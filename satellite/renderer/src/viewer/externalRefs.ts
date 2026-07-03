// satellite/renderer/src/viewer/externalRefs.ts
//
// Email-client-style "load external data" gate for the static-HTML viewer.
// DOMPurify strips scripts but KEEPS <img>, <style>, media elements, so remote
// sub-resources (tracker pixels, remote CSS) would fetch the moment the
// sanitized markup lands in the DOM. These pure helpers neutralize every
// external-loading reference in a detached/mounted subtree — moving the live
// value into a parked `data-reck-blocked-<key>` attribute — so nothing fetches
// until the user explicitly consents, at which point `restoreExternalRefs`
// puts every value back exactly.
//
// An "external URL" is a trimmed value that starts with `http://`, `https://`,
// or `//` (protocol-relative). `data:` and relative (`./a.png`) URLs are left
// untouched — they never reach out to a third-party host.
//
// A SHARED vector table drives neutralize AND restore so the two can never
// drift out of sync: whatever we park, we know precisely how to un-park.

const PARK_PREFIX = "data-reck-blocked-";
const STYLE_PARK_ATTR = `${PARK_PREFIX}style`;
const STYLE_TEXT_PARK_ATTR = `${PARK_PREFIX}styletext`;

/**
 * How a given (element, attribute) pair carries a URL. `"url"` values are a
 * single URL; `"srcset"` values are a comma-separated candidate list.
 */
type RefKind = "url" | "srcset";

interface RefVector {
  /** CSS type selector for the element that owns the attribute. */
  readonly selector: string;
  /** Literal attribute name (qualified names like `xlink:href` allowed). */
  readonly attr: string;
  /** Suffix for the parked `data-reck-blocked-<parkKey>` attribute. Must be a
   *  valid `data-*` name fragment (no colon), so `xlink:href` parks as
   *  `xlinkhref`. */
  readonly parkKey: string;
  readonly kind: RefKind;
}

/**
 * Every external-loading attribute vector we neutralize. Reused verbatim by
 * `restoreExternalRefs` so a vector added here is automatically reversed.
 */
const REF_VECTORS: readonly RefVector[] = [
  { selector: "img", attr: "src", parkKey: "src", kind: "url" },
  { selector: "img", attr: "srcset", parkKey: "srcset", kind: "srcset" },
  { selector: "source", attr: "src", parkKey: "src", kind: "url" },
  { selector: "source", attr: "srcset", parkKey: "srcset", kind: "srcset" },
  { selector: "video", attr: "src", parkKey: "src", kind: "url" },
  { selector: "video", attr: "poster", parkKey: "poster", kind: "url" },
  { selector: "audio", attr: "src", parkKey: "src", kind: "url" },
  { selector: "track", attr: "src", parkKey: "src", kind: "url" },
  // SVG <image> can load a remote raster via either the modern `href` or the
  // legacy `xlink:href`. Both are handled by literal-name get/set/remove.
  { selector: "image", attr: "href", parkKey: "href", kind: "url" },
  { selector: "image", attr: "xlink:href", parkKey: "xlinkhref", kind: "url" },
];

/** External = trimmed value starts with http://, https://, or // (protocol-
 *  relative). `data:` and relative URLs are intentionally NOT external. */
function isExternalUrl(value: string): boolean {
  const v = value.trim().toLowerCase();
  return (
    v.startsWith("http://") || v.startsWith("https://") || v.startsWith("//")
  );
}

/** A `srcset` is external if ANY of its comma-separated candidates' URL part
 *  (the token before the optional descriptor) is external. */
function srcsetHasExternal(value: string): boolean {
  return value
    .split(",")
    .some((candidate) => isExternalUrl(candidate.trim().split(/\s+/)[0] ?? ""));
}

// CSS `url(...)` pointing at an external host, e.g. `background:url(https://…)`.
const STYLE_URL_EXTERNAL = /url\(\s*['"]?(?:https?:|\/\/)/i;
// `@import` of an external stylesheet, e.g. `@import "https://…"` or
// `@import url(https://…)`.
const STYLE_IMPORT_EXTERNAL = /@import\s+(?:url\(\s*)?['"]?(?:https?:|\/\/)/i;

function parkAttrFor(parkKey: string): string {
  return `${PARK_PREFIX}${parkKey}`;
}

/**
 * Neutralize every external-loading reference under `root`. For each match the
 * live value is moved into a parked `data-reck-blocked-<key>` attribute and the
 * live attribute is removed, so no sub-resource fetches until consent.
 *
 * @returns the number of individual references neutralized (an element with
 *   both an external `src` and `srcset` contributes 2). Use
 *   `countBlockedExternalRefs` for a per-element tally.
 */
export function neutralizeExternalRefs(root: HTMLElement): number {
  let count = 0;

  // Element/attribute vectors (img/source/video/audio/track/svg-image).
  for (const vector of REF_VECTORS) {
    root.querySelectorAll(vector.selector).forEach((el) => {
      const live = el.getAttribute(vector.attr);
      if (live === null) return;
      const external =
        vector.kind === "srcset" ? srcsetHasExternal(live) : isExternalUrl(live);
      if (!external) return;
      el.setAttribute(parkAttrFor(vector.parkKey), live);
      el.removeAttribute(vector.attr);
      count += 1;
    });
  }

  // Inline `style` attribute referencing an external `url(...)`. Park the WHOLE
  // value — a single declaration may mix relative and external URLs, and we
  // restore it verbatim, so all-or-nothing keeps neutralize/restore lossless.
  root.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style");
    if (style === null || !STYLE_URL_EXTERNAL.test(style)) return;
    el.setAttribute(STYLE_PARK_ATTR, style);
    el.removeAttribute("style");
    count += 1;
  });

  // <style> element whose CSS text loads an external `url(...)` or `@import`.
  // Park the whole textContent and clear it so the stylesheet is inert.
  root.querySelectorAll("style").forEach((el) => {
    const text = el.textContent ?? "";
    if (!STYLE_URL_EXTERNAL.test(text) && !STYLE_IMPORT_EXTERNAL.test(text)) {
      return;
    }
    el.setAttribute(STYLE_TEXT_PARK_ATTR, text);
    el.textContent = "";
    count += 1;
  });

  return count;
}

/** True when `el` carries at least one `data-reck-blocked-*` parked attribute. */
function hasParkedAttr(el: Element): boolean {
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith(PARK_PREFIX)) return true;
  }
  return false;
}

/**
 * Count elements under `root` that carry any parked `data-reck-blocked-*`
 * attribute. Each element is counted ONCE even if it parked several vectors
 * (e.g. both `src` and `srcset`) — this is the "N external resources" the
 * consent banner reports to the user.
 */
export function countBlockedExternalRefs(root: HTMLElement): number {
  let count = 0;
  root.querySelectorAll("*").forEach((el) => {
    if (hasParkedAttr(el)) count += 1;
  });
  return count;
}

/**
 * Exact reverse of `neutralizeExternalRefs`: restore every parked live
 * attribute / `<style>` textContent and drop the `data-reck-blocked-*` markers.
 * Idempotent and driven by the same vector table, so it can never restore a
 * value into the wrong attribute.
 */
export function restoreExternalRefs(root: HTMLElement): void {
  for (const vector of REF_VECTORS) {
    const parkAttr = parkAttrFor(vector.parkKey);
    root.querySelectorAll(`[${parkAttr}]`).forEach((el) => {
      const parked = el.getAttribute(parkAttr);
      if (parked === null) return;
      el.setAttribute(vector.attr, parked);
      el.removeAttribute(parkAttr);
    });
  }

  root.querySelectorAll(`[${STYLE_PARK_ATTR}]`).forEach((el) => {
    const parked = el.getAttribute(STYLE_PARK_ATTR);
    if (parked === null) return;
    el.setAttribute("style", parked);
    el.removeAttribute(STYLE_PARK_ATTR);
  });

  root.querySelectorAll(`[${STYLE_TEXT_PARK_ATTR}]`).forEach((el) => {
    const parked = el.getAttribute(STYLE_TEXT_PARK_ATTR);
    if (parked === null) return;
    el.textContent = parked;
    el.removeAttribute(STYLE_TEXT_PARK_ATTR);
  });
}
