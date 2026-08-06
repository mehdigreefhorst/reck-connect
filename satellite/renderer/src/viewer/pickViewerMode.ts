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
 * Phase 1 image formats — every one of these is decoded natively by
 * Chromium, so the viewer needs no conversion step and no npm dependency.
 * TIFF/HEIC deliberately excluded: Chromium cannot decode them, so they
 * need a `sips` pass (tracked as a follow-up) and would render as a broken
 * image if listed here.
 *
 * Kept in sync with IMAGE_MIME_BY_EXT in main/image-protocol.ts — that map
 * is the authoritative server-side gate; this is the renderer-side
 * classifier. A format must be in BOTH to work.
 */
export function isImagePath(p: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i.test(p);
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
