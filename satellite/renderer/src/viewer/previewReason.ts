// Phase B — user-facing copy for why a `.tsx/.jsx` file has no live preview.
//
// The walk-up detector (`preview:detect`) returns a `reason` when a file
// isn't previewable. Rather than silently falling back to the source editor,
// the viewer shows a small "why" card built from this copy so the user
// understands what happened (no Vite app, Vite-but-no-React, or an unreadable
// project over the mount) and can reveal the source on demand.

/** The reason keys mirror `FilePreviewInfo.reason` from the detector (Task 1). */
export type PreviewReasonKey = "ok" | "no-vite-app" | "vite-no-react" | "read-error";

/**
 * User-facing copy for a non-previewable file. Keep messages concrete: what
 * happened, in the interface's voice. `ok` never reaches here in practice
 * (previewable files render the live surface), so it shares the default copy.
 */
export function previewReasonCopy(reason: PreviewReasonKey): {
  title: string;
  body: string;
} {
  switch (reason) {
    case "vite-no-react":
      return {
        title: "No live preview here",
        body: "This file's app uses Vite but not React. Live preview renders Vite + React components.",
      };
    case "read-error":
      return {
        title: "Couldn't read the project",
        body: "The project's package.json couldn't be read over the mount. Showing source.",
      };
    case "no-vite-app":
    case "ok":
    default:
      return {
        title: "No live preview here",
        body: "Live preview renders Vite + React apps. This file isn't inside one.",
      };
  }
}
