// Post-mount pass that turns parked local image paths into paintable
// `reck-img://` URLs.
//
// Runs after `MarkdownRenderer.mount()`, alongside enhanceMermaid/enhanceMath,
// and for the same structural reason as those two: the work cannot happen
// inside the synchronous `render()`. Here the blocker is specifically that
// minting a `reck-img://` URL is an IPC round-trip into main — main is the
// only place allowed to mint one, because that is where the allowed-roots,
// extension and size gates live (see main/image-protocol.ts).
//
// SECURITY — this writes `src` onto the live DOM *past* DOMPurify, which is
// deliberate and is what keeps `reck-img:` off the sanitizer's URI allowlist.
// The URL written here never originates in this file: it is whatever
// `files.imageMeta` returned, and that value already survived
// `resolveInsideAllowedRoots` + an extension allowlist in main. Do NOT
// construct a reck-img URL here, and do NOT copy an author-supplied string
// into `src`.

// From markdownImageSrc, not MarkdownRenderer: MarkdownRenderer imports this
// module to run the pass, so importing back would make the two mutually
// dependent — and the selectors below are built at module scope, where a
// half-initialised cyclic import reads the constants as `undefined`.
import {
  RECK_IMAGE_SRC_ATTR,
  RECK_IMAGE_UNSUPPORTED_ATTR,
} from "./markdownImageSrc";
import { resolveActivatePath } from "./resolveActivatePath";

/** Mirrors the `file:imageMeta` IPC contract (preload/preload.ts). */
export type ImageMetaResult =
  | {
      ok: true;
      resolvedPath: string;
      url: string;
      mime: string;
      byteSize: number;
      mtimeMs: number;
    }
  | { ok: false; code: string; error: string };

export interface EnhanceLocalImagesOptions {
  /**
   * Directory that relative image paths resolve against — the open file's
   * own directory in the viewer, the session's project cwd in the
   * transcript. `null` means the surface has no anchor: absolute paths
   * still resolve, relative ones become a placeholder.
   */
  baseDir: string | null;
  /**
   * True when the markdown came from a host whose files this process cannot
   * serve (today: `sourceHost: "station"`). Every local image becomes a
   * placeholder and no IPC is attempted. `reck-img://` reserves a `station`
   * host but does not implement it yet.
   */
  unsupportedHost?: boolean;
  /** Same staleness contract as EnhanceMermaidOptions.stillCurrent. */
  stillCurrent?: () => boolean;
  /** Injectable for tests; defaults to `window.reckAPI.files.imageMeta`. */
  imageMeta?: (absPath: string) => Promise<ImageMetaResult>;
}

/** Images the markdown-it rule parked a filesystem path on. */
export const LOCAL_IMAGE_SELECTOR = `img[${RECK_IMAGE_SRC_ATTR}]`;

/** Images whose scheme we refuse to serve at all. */
const UNSUPPORTED_IMAGE_SELECTOR = `img[${RECK_IMAGE_UNSUPPORTED_ATTR}]`;

/** Class on the inline node that replaces an image we could not display. */
export const IMAGE_PLACEHOLDER_CLASS = "reck-image-missing";

/**
 * How many `imageMeta` round-trips may be in flight at once.
 *
 * Not a latency knob — a resource cap. For PNG/JPEG the handler is an
 * `fs.stat`, but for HEIC/TIFF it calls `ensureConvertedImage`, which SPAWNS
 * `/usr/bin/sips` (main/image-protocol.ts). Unbounded, a markdown file
 * embedding 20 HEICs would spawn 20 transcode processes simultaneously.
 *
 * Small enough to bound the process count, large enough that a page of cheap
 * stats still overlaps its IPC latency instead of paying it serially.
 */
export const IMAGE_META_CONCURRENCY = 4;

/**
 * Human-readable reason per `handleImageMeta` failure code
 * (main/file-viewer.ts). Kept exhaustive on purpose: collapsing these into
 * one generic string is exactly the regression PR #146 called out — seven
 * distinguishable states must not become one silent onerror.
 */
function reasonFor(code: string): string {
  switch (code) {
    case "out-of-roots":
      return "it is outside the allowed folders";
    case "not-found":
      return "it was not found";
    case "too-large":
      return "it is too large to display";
    case "unsupported":
      return "it is an unsupported image format";
    case "is-directory":
      return "it is a folder, not an image";
    case "io-error":
      return "it could not be read";
    case "invalid-input":
      return "it is not a usable path";
    default:
      return "it could not be displayed";
  }
}

function placeholder(img: HTMLImageElement, message: string): void {
  const span = img.ownerDocument.createElement("span");
  span.className = IMAGE_PLACEHOLDER_CLASS;
  // textContent, never innerHTML: this node is built past DOMPurify, and
  // `message` embeds an author-supplied path.
  span.textContent = message;
  span.title = message;
  img.replaceWith(span);
}

async function resolveOne(
  img: HTMLImageElement,
  opts: EnhanceLocalImagesOptions,
  imageMeta: (absPath: string) => Promise<ImageMetaResult>,
): Promise<void> {
  const raw = img.getAttribute(RECK_IMAGE_SRC_ATTR) ?? "";

  if (opts.unsupportedHost) {
    placeholder(img, `Image “${raw}” lives on the station and cannot be shown here yet.`);
    return;
  }

  const isAnchored =
    raw.startsWith("/") || raw.startsWith("~/") || raw === "~";
  if (!isAnchored && !opts.baseDir) {
    placeholder(img, `Image “${raw}” has no folder to resolve it against.`);
    return;
  }

  const abs = resolveActivatePath(raw, opts.baseDir);

  let meta: ImageMetaResult;
  try {
    meta = await imageMeta(abs);
  } catch (err) {
    console.warn("[markdown] imageMeta threw", { raw, abs, err });
    meta = { ok: false, code: "io-error", error: String(err) };
  }

  // The container may have been re-rendered or disposed during the IPC.
  if (opts.stillCurrent && !opts.stillCurrent()) return;
  if (!img.isConnected) return;

  if (!meta.ok) {
    placeholder(img, `Image “${raw}” could not be shown — ${reasonFor(meta.code)}.`);
    return;
  }

  img.setAttribute("src", meta.url);
  img.removeAttribute(RECK_IMAGE_SRC_ATTR);
}

export async function enhanceLocalImages(
  container: HTMLElement,
  opts: EnhanceLocalImagesOptions,
): Promise<void> {
  // Checked before ANY DOM write, including the synchronous placeholder loop
  // below: an abandoned pass must leave the container exactly as it found it.
  if (opts.stillCurrent && !opts.stillCurrent()) return;

  for (const img of Array.from(
    container.querySelectorAll<HTMLImageElement>(UNSUPPORTED_IMAGE_SELECTOR),
  )) {
    placeholder(img, "This image cannot be displayed.");
  }

  const locals = Array.from(
    container.querySelectorAll<HTMLImageElement>(LOCAL_IMAGE_SELECTOR),
  );
  if (locals.length === 0) return;

  const imageMeta =
    opts.imageMeta ?? ((p: string) => window.reckAPI.files.imageMeta(p));

  // Concurrent but capped: each image is an independent IPC round-trip and a
  // doc with a dozen figures should not pay a dozen serial latencies, but an
  // uncapped fan-out can spawn one `sips` per HEIC — see
  // IMAGE_META_CONCURRENCY. A shared cursor over `locals` rather than chunked
  // batches, so one slow transcode stalls its own worker instead of a whole
  // batch boundary. resolveOne never throws, so allSettled would add nothing
  // over all().
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < locals.length) {
      const img = locals[next];
      next += 1;
      await resolveOne(img, opts, imageMeta);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(IMAGE_META_CONCURRENCY, locals.length) }, () =>
      worker(),
    ),
  );
}
