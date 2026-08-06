// Pure classifier for the file viewer's render mode. Centralises the
// path-type predicates and the (path, persisted-mode) -> ViewerMode
// decision that renderForPath and renderStationRemote both need, so the
// decision lives in exactly one place.

export type PersistedRenderMode = "rendered" | "source";

/** The concrete surface a viewer should mount for a file. */
export type ViewerMode =
  | "markdown-rendered"
  | "html-static"
  | "image"
  | "source";

export function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown)$/i.test(p);
}

export function isHtmlPath(p: string): boolean {
  return /\.html?$/i.test(p);
}

/**
 * Every format the image surface claims. Most are decoded natively by
 * Chromium; tiff/heic are transcoded to PNG by `sips` in the main process
 * before the bytes are served.
 *
 * tiff/heic are listed here even though they only work on macOS. The
 * renderer can't see the platform, and claiming them is still the better
 * behaviour: on a non-darwin host `file:imageMeta` returns `unsupported`
 * and the popup shows a clear inline message, which beats dropping a HEIC
 * into CodeMirror to render as binary garbage.
 *
 * Kept in sync with IMAGE_MIME_BY_EXT + CONVERTIBLE_MIME_BY_EXT in
 * main/image-protocol.ts — those are the authoritative server-side gate;
 * this is only the renderer-side classifier. A format must be in BOTH.
 */
export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg|tiff?|heic|heif)$/i.test(p);
}

/**
 * True for file types that offer a rendered view AND a rendered/source
 * toggle. Extended in Phase A to include HTML.
 *
 * IMAGES ARE DELIBERATELY EXCLUDED. This predicate does not mean "has a
 * non-source renderer" — it is what mounts the rendered/source toggle
 * button in FileViewerHost. Images have no source view (the bytes are
 * binary), so adding them here ships a broken "Edit source" button on
 * every PNG. `pickViewerMode` handles images on its own, before this is
 * ever consulted.
 */
export function isRenderablePath(p: string): boolean {
  return isMarkdownPath(p) || isHtmlPath(p);
}

/**
 * Decide the render mode. `persisted` is the per-path user preference
 * (`fileViewerModePerPath`); `undefined` means "no saved choice", which
 * defaults renderable files to their rendered view.
 */
export function pickViewerMode(
  path: string,
  persisted: PersistedRenderMode | undefined,
): ViewerMode {
  // Unconditional, and BEFORE the persisted check: "view the PNG's source"
  // is meaningless, and a stale `fileViewerModePerPath` entry must not be
  // able to strand an image in a CodeMirror that can't load it.
  if (isImagePath(path)) return "image";
  if (persisted !== "source") {
    if (isMarkdownPath(path)) return "markdown-rendered";
    if (isHtmlPath(path)) return "html-static";
  }
  return "source";
}
