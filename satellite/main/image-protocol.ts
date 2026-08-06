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

import fs from "node:fs";
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

/** MIME for `p` from its extension alone, or null if it isn't an image. */
export function imageMimeFor(p: string): string | null {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (!ext) return null;
  return IMAGE_MIME_BY_EXT.get(ext) ?? null;
}

export function isImageFile(p: string): boolean {
  return imageMimeFor(p) !== null;
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
  const mime = imageMimeFor(resolved);
  if (!mime) return { status: 415, headers: DENY_HEADERS };

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

  return {
    status: 200,
    filePath: resolved,
    headers: {
      "Content-Type": mime,
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
    try {
      // Streamed, so a 100 MB image never sits in main's heap. Node's
      // web-stream adapter is what protocol.handle's Response accepts.
      const stream = Readable.toWeb(
        fs.createReadStream(decision.filePath),
      ) as ReadableStream<Uint8Array>;
      return new Response(stream, { status: 200, headers: decision.headers });
    } catch (err) {
      console.error("[reck-img] read failed", decision.filePath, err);
      return new Response(null, { status: 500, headers: DENY_HEADERS });
    }
  });
}
