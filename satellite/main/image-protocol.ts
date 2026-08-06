// The `reck-img://` scheme — how image bytes reach an `<img>` in the file
// viewer popup.
//
// WHY A CUSTOM SCHEME AND NOT SOMETHING SIMPLER
//
//   data: URI over IPC — at the 100 MB cap that is a ~133 MB base64 string,
//   structured-clone copied across the boundary and held as a UTF-16 JS
//   string in the renderer. Several hundred MB across two processes for one
//   file, with the encode happening synchronously on main.
//
//   <img src="file:///…"> — works in prod (the popup loads via loadFile, so
//   the page origin is file://) and is BLOCKED IN DEV, where the origin is
//   http://localhost:5173. Dev and prod must not diverge.
//
//   protocol.handle("file", …) — a global override; in prod it would
//   intercept the app's own bundle.
//
// A dedicated scheme streams from disk at constant memory, behaves
// identically in dev and prod (its origin is independent of the page's), and
// keeps the security decision in main rather than trusting the renderer.
//
// THREAT MODEL — read before changing anything here.
//
// The popup renders UNTRUSTED markdown and HTML. A malicious document can
// therefore construct `reck-img://` URLs. Five properties keep that boring:
//
//   1. resolveInsideAllowedRoots — the same realpath-containment gate every
//      other file:* channel uses, with the same live roots getter.
//   2. IMAGE ONLY. imageMimeFor() returns null for anything not in the
//      extension map, and the handler refuses it. The scheme cannot serve
//      .env, id_rsa, or .ts at any MIME type. This is why it is named
//      `reck-img` and not `reck-file` — do not generalise it.
//   3. Content-Type comes from the extension map, never from content
//      sniffing and never from the URL, plus `nosniff`.
//   4. supportFetchAPI is OFF (see registerReckImgScheme), so a compromised
//      renderer can paint these responses but cannot read them into JS.
//   5. A response CSP, which matters if a window ever NAVIGATES to a
//      reck-img:// SVG URL — there the SVG is a document, not an image, and
//      its scripts would otherwise run in this scheme's origin.
//
// The residual gap is that untrusted markdown could display an allowlisted
// image the user didn't ask for. It cannot exfiltrate it (externalRefs.ts
// parks http(s) egress; fetch is off), so this is accepted for now.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import { resolveInsideAllowedRoots } from "./file-allowlist";

export const RECK_IMG_SCHEME = "reck-img";

/**
 * Its own constant — deliberately NOT shared with the text viewer's
 * FILE_VIEWER_MAX_BYTES (2 MB), which is the right size for text and far too
 * small for a screenshot. Related caps, all four of which look
 * interchangeable and are not:
 *   FILE_VIEWER_MAX_BYTES    2 MB   file-viewer.ts   local text
 *   STATION_READ_MAX_BYTES   2 MB   station-ssh.ts   station text
 *   IMAGE_VIEWER_MAX_BYTES   100 MB here            local images
 */
export const IMAGE_VIEWER_MAX_BYTES = 100 * 1024 * 1024;

export type ReckImgHost = "local" | "station";

/**
 * The authoritative server-side allowlist. Every entry is a format Chromium
 * decodes natively. Kept in sync with isImagePath() in
 * renderer/src/viewer/pickViewerMode.ts — a format must be in BOTH to work.
 */
export const IMAGE_MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["avif", "image/avif"],
  ["svg", "image/svg+xml"],
]);

/**
 * Formats Chromium has NO decoder for. `<img src>` fires onerror for these
 * no matter how the bytes are delivered, so they are transcoded to PNG by
 * `sips` before being served. HEIC is the one that matters in practice:
 * it's the iPhone capture default, so anything AirDropped to the Mac
 * arrives as .heic.
 *
 * These are NOT in IMAGE_MIME_BY_EXT — that map is "servable as-is", and
 * conflating the two would serve undecodable bytes with a confident
 * Content-Type.
 */
export const CONVERTIBLE_MIME_BY_EXT: ReadonlyMap<string, string> = new Map([
  ["tiff", "image/tiff"],
  ["tif", "image/tiff"],
  ["heic", "image/heic"],
  ["heif", "image/heif"],
]);

/** MIME for `p` from its extension alone, or null if it isn't an image. */
export function imageMimeFor(p: string): string | null {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!ext) return null;
  return IMAGE_MIME_BY_EXT.get(ext) ?? null;
}

/** Source MIME for a format that must be transcoded first, else null. */
export function convertibleMimeFor(p: string): string | null {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!ext) return null;
  return CONVERTIBLE_MIME_BY_EXT.get(ext) ?? null;
}

/**
 * `sips` ships with macOS and needs no npm dependency. Elsewhere these
 * formats stay unsupported rather than shelling out to a binary that
 * isn't there — the repo has a Linux station concept, so this really can
 * run on a non-darwin host.
 */
export function canConvertImages(): boolean {
  return process.platform === "darwin";
}

/** Any image the viewer can display, whether or not it needs transcoding. */
export function isImageFile(p: string): boolean {
  if (imageMimeFor(p) !== null) return true;
  return canConvertImages() && convertibleMimeFor(p) !== null;
}

/**
 * Transcoded output can dwarf its source — a 13 KB HEIC expands to
 * multiple MB of PNG, and a 40 MP one far more. The source passing
 * IMAGE_VIEWER_MAX_BYTES therefore says nothing about the result, so the
 * converted file gets its own check.
 */
export const CONVERTED_IMAGE_MAX_BYTES = IMAGE_VIEWER_MAX_BYTES;

/** How long a single `sips` invocation may take before we give up. */
const CONVERT_TIMEOUT_MS = 30_000;

/**
 * Cache path for the PNG form of `resolved`. Keyed by realpath + mtime +
 * size, so re-opening a file is free and editing it re-converts. Lives
 * under the OS temp dir: losing it costs one re-conversion.
 */
export function convertedCachePathFor(
  resolved: string,
  stat: { mtimeMs: number; size: number },
): string {
  const key = createHash("sha256")
    .update(`${resolved}\0${Math.trunc(stat.mtimeMs)}\0${stat.size}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(os.tmpdir(), "reck-img-cache", `${key}.png`);
}

export type ConvertResult =
  | { ok: true; filePath: string; size: number }
  | { ok: false; code: "unsupported" | "too-large" | "convert-failed" };

/**
 * Ensure a PNG rendition of `resolved` exists, converting if the cache is
 * cold. Idempotent and safe to call from both `file:imageMeta` (where the
 * spinner is already up, so a slow decode doesn't show a blank popup) and
 * the protocol handler (which must still work if the temp cache was
 * evicted between the two).
 */
export async function ensureConvertedImage(
  resolved: string,
  stat: { mtimeMs: number; size: number },
): Promise<ConvertResult> {
  if (!canConvertImages()) return { ok: false, code: "unsupported" };

  const out = convertedCachePathFor(resolved, stat);
  try {
    const cached = fs.statSync(out);
    if (cached.size > 0) {
      return cached.size > CONVERTED_IMAGE_MAX_BYTES
        ? { ok: false, code: "too-large" }
        : { ok: true, filePath: out, size: cached.size };
    }
  } catch {
    // Cache miss — fall through and convert.
  }

  await fsp.mkdir(path.dirname(out), { recursive: true });
  // Convert to a per-call temp name and rename into place, so two windows
  // opening the same file can't observe a half-written PNG.
  const scratch = `${out}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;

  const converted = await new Promise<boolean>((resolve) => {
    // Arg array, never a shell string: `resolved` is user-controlled and
    // may contain spaces, quotes, or metacharacters.
    const proc = spawn(
      "/usr/bin/sips",
      ["-s", "format", "png", resolved, "--out", scratch],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    proc.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf-8");
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, CONVERT_TIMEOUT_MS);
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn("[reck-img] sips failed", { resolved, code, stderr: stderr.trim() });
      }
      resolve(code === 0);
    });
  });

  if (!converted) {
    await fsp.rm(scratch, { force: true });
    return { ok: false, code: "convert-failed" };
  }

  let size: number;
  try {
    size = (await fsp.stat(scratch)).size;
  } catch {
    return { ok: false, code: "convert-failed" };
  }
  if (size > CONVERTED_IMAGE_MAX_BYTES) {
    await fsp.rm(scratch, { force: true });
    return { ok: false, code: "too-large" };
  }
  try {
    await fsp.rename(scratch, out);
  } catch {
    // Another window won the race and already published this exact key —
    // the content is identical, so use theirs.
    await fsp.rm(scratch, { force: true });
  }
  return { ok: true, filePath: out, size };
}

export interface BuildReckImgUrlOpts {
  absPath: string;
  /** Cache-buster, `<mtimeMs>-<size>`. Chromium caches scheme responses; without
   *  this an edited image shows stale bytes indefinitely. */
  version: string;
  host?: ReckImgHost;
}

/**
 * Mint a URL. ALWAYS CALLED FROM MAIN, never the renderer or preload — the
 * preload is sandboxed (no node:path), and keeping URL construction in one
 * place keeps the encoding rules in one place.
 *
 * The path lives in a QUERY PARAMETER. It must not go in the host (which
 * `standard: true` lowercases and punycodes) nor the path component (which
 * it canonicalises, collapsing `..` and rewriting separators) — either
 * would silently corrupt real filenames, and path canonicalisation could
 * produce a target different from the one that was validated.
 */
export function buildReckImgUrl(opts: BuildReckImgUrlOpts): string {
  const params = new URLSearchParams({ p: opts.absPath, v: opts.version });
  return `${RECK_IMG_SCHEME}://${opts.host ?? "local"}/?${params.toString()}`;
}

export interface ParsedReckImgUrl {
  absPath: string;
  version: string;
  host: ReckImgHost;
}

export function parseReckImgUrl(url: string): ParsedReckImgUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${RECK_IMG_SCHEME}:`) return null;

  const host = parsed.hostname;
  if (host !== "local" && host !== "station") return null;

  const absPath = parsed.searchParams.get("p");
  if (!absPath) return null;
  if (absPath.includes("\0")) return null;
  if (!path.isAbsolute(absPath)) return null;

  return { absPath, version: parsed.searchParams.get("v") ?? "", host };
}

export interface ImageProtocolDeps {
  /** Live getter, so Settings edits to fileViewerExtraRoots apply without a
   *  restart — exactly like the file:* IPC channels. */
  roots(): readonly string[];
}

export interface ImageResponseDecision {
  status: number;
  headers: Record<string, string>;
  /** Set only on 200 — the canonical path whose bytes to stream. */
  filePath?: string;
  /** Set only on 200 — `filePath` is a source Chromium cannot decode, and
   *  must be transcoded before it is streamed. The gates above have
   *  already run against the ORIGINAL file. */
  needsConversion?: boolean;
  /** Set with `needsConversion` — stat of the original, for the cache key. */
  sourceStat?: { mtimeMs: number; size: number };
}

const DENY_HEADERS: Record<string, string> = { "Cache-Control": "no-store" };

/**
 * The whole security decision, as a pure function of (roots, url) plus
 * synchronous fs metadata. Extracted from the Electron handler so the tests
 * that matter most need no Electron at all.
 */
export function decideImageResponse(
  deps: ImageProtocolDeps,
  url: string,
): ImageResponseDecision {
  const parsed = parseReckImgUrl(url);
  if (!parsed) return { status: 400, headers: DENY_HEADERS };

  // Gate 1 — realpath containment inside the allowed roots.
  const resolved = resolveInsideAllowedRoots(deps.roots(), parsed.absPath);
  if (!resolved) return { status: 403, headers: DENY_HEADERS };

  // Gate 2 — image extensions only. The load-bearing narrowing.
  // A convertible source (TIFF/HEIC) passes here but is served as PNG,
  // because Chromium cannot decode the original bytes.
  const directMime = imageMimeFor(resolved);
  const convertible = directMime ? null : convertibleMimeFor(resolved);
  if (!directMime && !(convertible && canConvertImages())) {
    return { status: 415, headers: DENY_HEADERS };
  }

  // Gate 3 — must be a regular file of a sane size. isFile() also excludes
  // FIFOs, which would otherwise hang the stream forever.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { status: 404, headers: DENY_HEADERS };
  }
  if (!stat.isFile()) return { status: 404, headers: DENY_HEADERS };
  if (stat.size > IMAGE_VIEWER_MAX_BYTES) {
    return { status: 413, headers: DENY_HEADERS };
  }

  if (!directMime) {
    // Content-Length is deliberately omitted: the transcoded size isn't
    // known until the conversion runs, and a wrong one truncates the
    // response.
    return {
      status: 200,
      filePath: resolved,
      needsConversion: true,
      sourceStat: { mtimeMs: stat.mtimeMs, size: stat.size },
      headers: {
        "Content-Type": "image/png",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'none'; sandbox",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    };
  }

  return {
    status: 200,
    filePath: resolved,
    headers: {
      "Content-Type": directMime,
      "Content-Length": String(stat.size),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; script-src 'none'; sandbox",
      // Bytes are addressed by a version token that changes with mtime+size,
      // so the URL itself is the cache key; immutable is safe and avoids a
      // revalidation round-trip on every re-render.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  };
}

/** `<mtimeMs>-<size>` — changes whenever the bytes could have changed. */
export function versionTokenFor(stat: { mtimeMs: number; size: number }): string {
  return `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
}

/**
 * Wire the scheme to the filesystem. Call once, AFTER app ready — the
 * `registerSchemesAsPrivileged` declaration in main.ts is the part that
 * must run before.
 *
 * All of the security lives in `decideImageResponse`; this only turns a
 * decision into a Response, so the tests that matter need no Electron.
 */
export function installReckImgProtocol(deps: ImageProtocolDeps): void {
  protocol.handle(RECK_IMG_SCHEME, async (request) => {
    const decision = decideImageResponse(deps, request.url);
    if (decision.status !== 200 || !decision.filePath) {
      console.warn("[reck-img] refused", {
        url: request.url,
        status: decision.status,
      });
      return new Response(null, {
        status: decision.status,
        headers: decision.headers,
      });
    }
    let bodyPath = decision.filePath;
    const headers = { ...decision.headers };
    if (decision.needsConversion && decision.sourceStat) {
      // Normally a cache hit: file:imageMeta already warmed it while the
      // spinner was up. This branch still has to work for an evicted temp
      // dir, or a URL constructed without going through imageMeta.
      const conv = await ensureConvertedImage(
        decision.filePath,
        decision.sourceStat,
      );
      if (!conv.ok) {
        console.warn("[reck-img] conversion failed", {
          path: decision.filePath,
          code: conv.code,
        });
        return new Response(null, {
          status: conv.code === "too-large" ? 413 : 415,
          headers: DENY_HEADERS,
        });
      }
      bodyPath = conv.filePath;
      headers["Content-Length"] = String(conv.size);
    }

    try {
      // Streamed, so a 100 MB image never sits in main's heap. Node's
      // web-stream adapter is what protocol.handle's Response accepts.
      const stream = Readable.toWeb(
        fs.createReadStream(bodyPath),
      ) as ReadableStream<Uint8Array>;
      return new Response(stream, { status: 200, headers });
    } catch (err) {
      console.error("[reck-img] read failed", decision.filePath, err);
      return new Response(null, { status: 500, headers: DENY_HEADERS });
    }
  });
}
