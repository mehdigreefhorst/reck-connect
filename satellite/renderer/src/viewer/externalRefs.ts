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
  /** CSS selector for candidate elements. When `localName` is also set this is
   *  a BROAD selector (`"*"`) and the real match is the `localName` filter — a
   *  camelCase/namespaced SVG type selector (`feImage`) is unreliable across
   *  DOM engines, so we never lean on it. */
  readonly selector: string;
  /** When set, only elements whose `.localName` equals this are considered.
   *  Robustly matches SVG elements (`image`, `feImage`) regardless of how a
   *  given engine handles camelCase/namespaced type selectors. */
  readonly localName?: string;
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
  // <input type="image" src="…"> loads its image eagerly, exactly like <img>.
  // DOMPurify keeps <input src>, so an external src here is a live beacon.
  { selector: "input", attr: "src", parkKey: "src", kind: "url" },
  // A legacy `background` attribute on ANY element (e.g. <body|table|td
  // background="https://…">) is a live background-image fetch that survives
  // DOMPurify's default allowlist. Selector matches only elements that carry
  // one; `isExternalUrl` keeps it external-only.
  {
    selector: "[background]",
    attr: "background",
    parkKey: "background",
    kind: "url",
  },
  // SVG <image> loads a remote raster via the modern `href` or the legacy
  // `xlink:href`. Matched by localName (robust across engines), then handled
  // by literal-name get/set/remove.
  { selector: "*", localName: "image", attr: "href", parkKey: "href", kind: "url" },
  {
    selector: "*",
    localName: "image",
    attr: "xlink:href",
    parkKey: "xlinkhref",
    kind: "url",
  },
  // SVG <feImage> fetches its href/xlink:href when a <filter> is applied —
  // same shape as <image>, same localName-robust matching. `feImage` is
  // camelCase so a type selector cannot be trusted; the localName filter can.
  {
    selector: "*",
    localName: "feImage",
    attr: "href",
    parkKey: "href",
    kind: "url",
  },
  {
    selector: "*",
    localName: "feImage",
    attr: "xlink:href",
    parkKey: "xlinkhref",
    kind: "url",
  },
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
// CSS `image-set()` BARE-STRING form, e.g. `image-set('https://…' 1x)` — no
// `url(` token, so `STYLE_URL_EXTERNAL` misses it entirely. Matches an
// optionally-quoted external URL as the first `image-set(` argument. The
// `image-set(url(https://…))` form is already caught by `STYLE_URL_EXTERNAL`.
const STYLE_IMAGE_SET_EXTERNAL = /image-set\(\s*['"]?(?:https?:|\/\/)/i;

/**
 * True when CSS text (an inline `style` value OR a `<style>` element body)
 * references an external sub-resource via `url(…)`, the bare-string
 * `image-set(…)`, or `@import`. External-only: `url(#id)` fragment refs and
 * `url(data:…)` URIs do NOT match, so they stay live (they never fetch).
 */
function cssHasExternalRef(css: string): boolean {
  return (
    STYLE_URL_EXTERNAL.test(css) ||
    STYLE_IMAGE_SET_EXTERNAL.test(css) ||
    STYLE_IMPORT_EXTERNAL.test(css)
  );
}

function parkAttrFor(parkKey: string): string {
  return `${PARK_PREFIX}${parkKey}`;
}

/**
 * Candidate elements for a vector. When `localName` is set we scan broadly and
 * filter by `.localName` so camelCase/namespaced SVG tags (`feImage`) match on
 * every DOM engine; otherwise the CSS `selector` is authoritative.
 */
function selectVectorTargets(root: HTMLElement, vector: RefVector): Element[] {
  const nodes = Array.from(root.querySelectorAll(vector.selector));
  if (vector.localName === undefined) return nodes;
  return nodes.filter((el) => el.localName === vector.localName);
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

  // Element/attribute vectors (img/source/video/audio/track/input/background/
  // svg-image/svg-feImage).
  for (const vector of REF_VECTORS) {
    for (const el of selectVectorTargets(root, vector)) {
      const live = el.getAttribute(vector.attr);
      if (live === null) continue;
      const external =
        vector.kind === "srcset" ? srcsetHasExternal(live) : isExternalUrl(live);
      if (!external) continue;
      el.setAttribute(parkAttrFor(vector.parkKey), live);
      el.removeAttribute(vector.attr);
      count += 1;
    }
  }

  // Inline `style` attribute referencing an external `url(...)`, bare-string
  // `image-set(...)`, or `@import`. Park the WHOLE value — a single declaration
  // may mix relative and external URLs, and we restore it verbatim, so
  // all-or-nothing keeps neutralize/restore lossless.
  root.querySelectorAll("[style]").forEach((el) => {
    const style = el.getAttribute("style");
    if (style === null || !cssHasExternalRef(style)) return;
    el.setAttribute(STYLE_PARK_ATTR, style);
    el.removeAttribute("style");
    count += 1;
  });

  // <style> element whose CSS text loads an external `url(...)`, bare-string
  // `image-set(...)`, or `@import`. Park the whole textContent and clear it so
  // the stylesheet is inert.
  root.querySelectorAll("style").forEach((el) => {
    const text = el.textContent ?? "";
    if (!cssHasExternalRef(text)) return;
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
