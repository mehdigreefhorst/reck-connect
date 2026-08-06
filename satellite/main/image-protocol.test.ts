import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The module imports `protocol` for installReckImgProtocol; the decision
// logic under test never touches Electron.
vi.mock("electron", () => ({ protocol: { handle: vi.fn() } }));

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RECK_IMG_SCHEME,
  IMAGE_VIEWER_MAX_BYTES,
  imageMimeFor,
  convertibleMimeFor,
  convertedCachePathFor,
  ensureConvertedImage,
  canConvertImages,
  isImageFile,
  buildReckImgUrl,
  parseReckImgUrl,
  decideImageResponse,
} from "./image-protocol";

describe("imageMimeFor", () => {
  it("maps every Phase 1 extension to its MIME type", () => {
    expect(imageMimeFor("/a/b.png")).toBe("image/png");
    expect(imageMimeFor("/a/b.jpg")).toBe("image/jpeg");
    expect(imageMimeFor("/a/b.jpeg")).toBe("image/jpeg");
    expect(imageMimeFor("/a/b.gif")).toBe("image/gif");
    expect(imageMimeFor("/a/b.webp")).toBe("image/webp");
    expect(imageMimeFor("/a/b.bmp")).toBe("image/bmp");
    expect(imageMimeFor("/a/b.ico")).toBe("image/x-icon");
    expect(imageMimeFor("/a/b.avif")).toBe("image/avif");
    expect(imageMimeFor("/a/b.svg")).toBe("image/svg+xml");
  });
  it("is case-insensitive", () => {
    expect(imageMimeFor("/a/PHOTO.PNG")).toBe("image/png");
  });
  it("returns null for anything not an image -- this is the gate that stops the scheme serving .env", () => {
    for (const p of ["/a/b.env", "/a/b.ts", "/a/id_rsa", "/a/b.md", "/a/b.raw"]) {
      expect(imageMimeFor(p)).toBeNull();
    }
  });
  // imageMimeFor means "servable as-is". TIFF/HEIC are images but
  // Chromium can't decode them, so they must NOT appear here or the
  // handler would serve undecodable bytes with a confident Content-Type.
  it("does not claim formats that need transcoding first", () => {
    for (const p of ["/a/b.tiff", "/a/b.tif", "/a/b.heic", "/a/b.heif"]) {
      expect(imageMimeFor(p)).toBeNull();
      expect(convertibleMimeFor(p)).not.toBeNull();
    }
    expect(convertibleMimeFor("/a/b.png")).toBeNull();
  });
  it("never infers a type from a bare name", () => {
    expect(imageMimeFor("/a/png")).toBeNull();
    expect(isImageFile("/a/png")).toBe(false);
  });
});

describe("buildReckImgUrl / parseReckImgUrl", () => {
  const roundTrip = (p: string) => {
    const url = buildReckImgUrl({ absPath: p, version: "1-2" });
    const parsed = parseReckImgUrl(url);
    return parsed?.absPath;
  };

  it("round-trips a plain path", () => {
    expect(roundTrip("/Users/me/shot.png")).toBe("/Users/me/shot.png");
  });
  // The path goes in a QUERY PARAM, never the host or path component --
  // `standard: true` would canonicalise both (lowercase, punycode, `..`
  // collapsing), silently corrupting real filenames.
  it("round-trips spaces", () => {
    expect(roundTrip("/Users/me/Screen Shot 2026-01-01 at 10.00.00.png")).toBe(
      "/Users/me/Screen Shot 2026-01-01 at 10.00.00.png",
    );
  });
  it("round-trips unicode", () => {
    expect(roundTrip("/Users/me/写真/テスト.png")).toBe("/Users/me/写真/テスト.png");
  });
  it("round-trips URL metacharacters", () => {
    for (const p of [
      "/a/b#hash.png",
      "/a/b&amp.png",
      "/a/b+plus.png",
      "/a/b?q.png",
      "/a/b%20literal.png",
    ]) {
      expect(roundTrip(p)).toBe(p);
    }
  });
  it("preserves dots in a filename rather than collapsing them as traversal", () => {
    expect(roundTrip("/a/my..file.png")).toBe("/a/my..file.png");
  });
  it("uses the reck-img scheme and carries a cache-busting version", () => {
    const url = buildReckImgUrl({ absPath: "/a/b.png", version: "42-7" });
    expect(url.startsWith(`${RECK_IMG_SCHEME}://`)).toBe(true);
    expect(parseReckImgUrl(url)?.version).toBe("42-7");
  });
  it("defaults to the local host and honours an explicit station host", () => {
    expect(parseReckImgUrl(buildReckImgUrl({ absPath: "/a/b.png", version: "1" }))?.host).toBe("local");
    expect(
      parseReckImgUrl(
        buildReckImgUrl({ absPath: "/a/b.png", version: "1", host: "station" }),
      )?.host,
    ).toBe("station");
  });

  it("rejects malformed URLs", () => {
    expect(parseReckImgUrl("https://example.com/?p=/a/b.png")).toBeNull();
    expect(parseReckImgUrl(`${RECK_IMG_SCHEME}://local/`)).toBeNull();
    expect(parseReckImgUrl(`${RECK_IMG_SCHEME}://local/?p=`)).toBeNull();
    expect(parseReckImgUrl(`${RECK_IMG_SCHEME}://local/?p=relative.png`)).toBeNull();
    expect(parseReckImgUrl(`${RECK_IMG_SCHEME}://nowhere/?p=%2Fa%2Fb.png`)).toBeNull();
    expect(parseReckImgUrl("not a url at all")).toBeNull();
  });
  it("rejects a NUL smuggled through percent-encoding", () => {
    expect(parseReckImgUrl(`${RECK_IMG_SCHEME}://local/?p=%2Fa%2Fb%00.png`)).toBeNull();
  });
});

describe("decideImageResponse", () => {
  let dir: string;
  let roots: string[];
  const deps = () => ({ roots: () => roots });

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reck-img-")));
    roots = [dir];
    // 1x1 transparent GIF -- smallest real image bytes we can inline.
    fs.writeFileSync(
      path.join(dir, "ok.png"),
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    );
    fs.writeFileSync(path.join(dir, "secret.env"), "API_KEY=hunter2");
    fs.mkdirSync(path.join(dir, "adir.png"));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const decide = (absPath: string) =>
    decideImageResponse(deps(), buildReckImgUrl({ absPath, version: "1" }));

  it("serves an allowed image with an extension-derived MIME and hardening headers", () => {
    const res = decide(path.join(dir, "ok.png"));
    expect(res.status).toBe(200);
    expect(res.filePath).toBe(path.join(dir, "ok.png"));
    expect(res.headers["Content-Type"]).toBe("image/png");
    // Never sniff: a .png full of HTML must not become a document.
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    // Decisive if a window ever NAVIGATES to a reck-img:// SVG, where the
    // SVG becomes a document and its scripts would otherwise run.
    expect(res.headers["Content-Security-Policy"]).toContain("script-src 'none'");
  });

  it("refuses a path outside the allowed roots", () => {
    const res = decideImageResponse(
      deps(),
      buildReckImgUrl({ absPath: "/etc/passwd.png", version: "1" }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses a non-image extension even when it is inside the roots", () => {
    // The load-bearing narrowing: this is why the scheme is image-only.
    const res = decide(path.join(dir, "secret.env"));
    expect(res.status).toBe(415);
    expect(res.filePath).toBeUndefined();
  });

  it("refuses a directory named like an image", () => {
    expect(decide(path.join(dir, "adir.png")).status).toBe(404);
  });

  it("refuses a missing file", () => {
    expect(decide(path.join(dir, "nope.png")).status).toBe(404);
  });

  it("refuses a file over the byte cap", () => {
    const big = path.join(dir, "big.png");
    const fd = fs.openSync(big, "w");
    fs.ftruncateSync(fd, IMAGE_VIEWER_MAX_BYTES + 1);
    fs.closeSync(fd);
    expect(decide(big).status).toBe(413);
    fs.rmSync(big);
  });

  it("refuses a symlink that escapes the roots", () => {
    const link = path.join(dir, "escape.png");
    fs.symlinkSync("/etc/hosts", link);
    expect(decide(link).status).toBe(403);
    fs.rmSync(link);
  });

  it("refuses a malformed URL outright", () => {
    expect(decideImageResponse(deps(), "https://evil.example/x.png").status).toBe(400);
  });
});

describe("sips transcoding (TIFF / HEIC)", () => {
  let dir: string;
  const deps = () => ({ roots: () => [dir] });
  const darwin = canConvertImages();

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reck-conv-")));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** Build a real HEIC/TIFF by round-tripping a PNG through sips itself. */
  const makeSource = (name: string, format: "tiff" | "heic"): string => {
    const png = path.join(dir, `${name}.png`);
    // 2x2 red PNG.
    fs.writeFileSync(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z4AATAxDlgcAWpwBFHCiVQwAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const out = path.join(dir, `${name}.${format}`);
    execFileSync("/usr/bin/sips", ["-s", "format", format, png, "--out", out], {
      stdio: "ignore",
    });
    return out;
  };

  it.runIf(darwin)("converts a HEIC and serves it as PNG", async () => {
    const heic = makeSource("photo", "heic");
    const decision = decideImageResponse(
      deps(),
      buildReckImgUrl({ absPath: heic, version: "1" }),
    );
    expect(decision.status).toBe(200);
    expect(decision.needsConversion).toBe(true);
    // Chromium can't decode HEIC, so the wire type must be PNG.
    expect(decision.headers["Content-Type"]).toBe("image/png");
    // Length isn't knowable until the transcode runs; sending a wrong one
    // would truncate the response.
    expect(decision.headers["Content-Length"]).toBeUndefined();

    const conv = await ensureConvertedImage(heic, fs.statSync(heic));
    expect(conv.ok).toBe(true);
    if (!conv.ok) return;
    expect(fs.readFileSync(conv.filePath).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it.runIf(darwin)("converts a TIFF too", async () => {
    const tiff = makeSource("scan", "tiff");
    const conv = await ensureConvertedImage(tiff, fs.statSync(tiff));
    expect(conv.ok).toBe(true);
  });

  it.runIf(darwin)("reuses the cache on a second call", async () => {
    const heic = makeSource("cached", "heic");
    const stat = fs.statSync(heic);
    const first = await ensureConvertedImage(heic, stat);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const marker = Date.now();
    fs.utimesSync(first.filePath, new Date(marker), new Date(marker));
    const second = await ensureConvertedImage(heic, stat);
    expect(second.ok && second.filePath).toBe(first.filePath);
    // Same file, untouched — a re-convert would have rewritten it.
    expect(fs.statSync(first.filePath).mtimeMs).toBeCloseTo(marker, -3);
  });

  it("keys the cache on mtime and size, so an edit re-converts", () => {
    const a = convertedCachePathFor("/a/b.heic", { mtimeMs: 1, size: 10 });
    const b = convertedCachePathFor("/a/b.heic", { mtimeMs: 2, size: 10 });
    const c = convertedCachePathFor("/a/b.heic", { mtimeMs: 1, size: 11 });
    const d = convertedCachePathFor("/other.heic", { mtimeMs: 1, size: 10 });
    expect(new Set([a, b, c, d]).size).toBe(4);
    expect(a).toBe(convertedCachePathFor("/a/b.heic", { mtimeMs: 1, size: 10 }));
  });

  it.runIf(darwin)("fails cleanly when the source isn't really an image", async () => {
    const fake = path.join(dir, "lies.heic");
    fs.writeFileSync(fake, "this is not a HEIC file");
    const conv = await ensureConvertedImage(fake, fs.statSync(fake));
    expect(conv.ok).toBe(false);
    if (conv.ok) return;
    expect(conv.code).toBe("convert-failed");
  });

  it.runIf(darwin)("still refuses a convertible extension outside the roots", () => {
    const outside = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "reck-conv-out-")),
    );
    const heic = path.join(outside, "sneaky.heic");
    fs.writeFileSync(heic, "x");
    const res = decideImageResponse(
      deps(),
      buildReckImgUrl({ absPath: heic, version: "1" }),
    );
    expect(res.status).toBe(403);
    fs.rmSync(outside, { recursive: true, force: true });
  });
});
