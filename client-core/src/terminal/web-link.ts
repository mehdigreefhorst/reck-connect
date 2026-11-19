// Web-link policy shared by every surface that turns text into something
// clickable: terminal scrollback, OSC 8 hyperlinks, the transcript view and
// rendered markdown (issue #180).
//
// A web link is an http/https URL and nothing else. Those open on a plain
// click, in the user's default browser. Everything else a link can point at
// — file paths, `mailto:`, custom app schemes — keeps its own, stricter
// gesture, because the consequences differ (opening a viewer, launching
// another app). In the satellite the main process applies the same
// http/https allowlist again before calling `shell.openExternal`, so this
// is a UX decision here, not the security boundary.

const WEB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** True for a well-formed absolute http/https URL. */
export function isWebUrl(href: unknown): href is string {
  if (typeof href !== "string" || href.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  return WEB_PROTOCOLS.has(parsed.protocol) && parsed.hostname.length > 0;
}

/**
 * Open `url` in the default browser: a new browsing context with no opener.
 * In the satellite the main process intercepts this (`setWindowOpenHandler`)
 * and forwards it to the OS; in a plain browser it is a new tab.
 */
export function openWebUrl(url: string): void {
  window.open(url, "_blank", "noopener");
}

/** The shape xterm's `linkHandler` option expects. */
export interface OscLinkHandler {
  activate(event: MouseEvent, uri: string): void;
  allowNonHttpProtocols?: boolean;
}

/**
 * Handler for explicit terminal hyperlinks (OSC 8).
 *
 * xterm's built-in handler asks for confirmation, calls `window.open()`
 * with NO url and only then assigns `location`. An embedder that vets
 * window-open requests by URL sees `about:blank`, denies it, and the click
 * does nothing. Opening the real URL in one step keeps that vetting
 * meaningful. Non-web schemes are ignored outright.
 */
export function createOscLinkHandler(open: (url: string) => void = openWebUrl): OscLinkHandler {
  return {
    activate(_event, uri) {
      if (isWebUrl(uri)) open(uri);
    },
  };
}
