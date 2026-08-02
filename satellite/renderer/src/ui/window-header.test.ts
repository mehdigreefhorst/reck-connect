/**
 * Window title bar drag contract.
 *
 * All three windows are `titleBarStyle: "hiddenInset"`, so the ONLY way to move
 * them is the `-webkit-app-region: drag` region on `.reck-window-header`. The
 * regression this guards: the opt-out rule used to be `.reck-window-header > *`,
 * which also caught the title element. The title is a direct child with
 * `flex: 1`, so it covers the whole middle of the bar — dragging worked on the
 * empty edges of the header and stopped dead over the title text.
 *
 * The assertion is behavioural rather than textual: parse the no-drag selectors
 * out of styles.css and check, against a real DOM of each header shape, which
 * elements they actually match. Buttons must opt out; titles must not.
 */
import { beforeAll, describe, expect, it } from "vitest";

/** Selectors that carry `-webkit-app-region: no-drag` in the renderer stylesheet. */
let noDragSelectors: string[] = [];
/** Selectors that carry `-webkit-app-region: drag`. */
let dragSelectors: string[] = [];

beforeAll(async () => {
  // jsdom does not parse arbitrary external stylesheets, so read the source.
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const raw = await fs.readFile(path.join(here, "..", "styles.css"), "utf8");
  // Comments first — this file is heavily commented and a `/* ... */` block
  // sitting above a rule would otherwise land inside its selector text.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");

  for (const [, rawSelector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rawSelector.trim();
    // Skip at-rule preludes (`@media ...`) and anything else that isn't a
    // selector list we can hand to `matches()`.
    if (!selector || selector.startsWith("@") || selector.includes("@")) continue;
    if (/-webkit-app-region:\s*no-drag/.test(body)) noDragSelectors.push(selector);
    else if (/-webkit-app-region:\s*drag/.test(body)) dragSelectors.push(selector);
  }
});

/** True when any no-drag rule in the stylesheet applies to `el`. */
function isNoDrag(el: Element): boolean {
  return noDragSelectors.some((sel) => el.matches(sel));
}

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe("window header drag region", () => {
  it("makes the header itself a drag region", () => {
    const host = mount(`<div class="reck-window-header popout-header"></div>`);
    const header = host.querySelector(".reck-window-header")!;
    expect(dragSelectors.some((sel) => header.matches(sel))).toBe(true);
  });

  it("keeps the popout title draggable while the reattach button opts out", () => {
    const host = mount(`
      <div class="reck-window-header popout-header">
        <div class="popout-title">pane-a</div>
        <div class="popout-actions"><button type="button">Reattach</button></div>
      </div>
    `);
    expect(isNoDrag(host.querySelector(".popout-title")!)).toBe(false);
    expect(isNoDrag(host.querySelector(".popout-actions button")!)).toBe(true);
  });

  it("keeps the file-viewer title draggable while its controls opt out", () => {
    const host = mount(`
      <div class="reck-window-header file-viewer-header">
        <div class="file-viewer-title">
          <span class="file-viewer-title-text">notes.md</span>
          <span class="file-viewer-host-badge" data-host="station">station</span>
        </div>
        <div class="file-viewer-toc-toggle-slot">
          <button type="button" class="reck-collapse-chip file-viewer-toc-toggle">*</button>
        </div>
        <div class="file-viewer-mode-toggle-slot">
          <button type="button" class="file-viewer-mode-toggle" data-mode="rendered">Edit source</button>
        </div>
        <div class="file-viewer-spinner-slot" aria-hidden="true"></div>
      </div>
    `);
    expect(isNoDrag(host.querySelector(".file-viewer-title")!)).toBe(false);
    expect(isNoDrag(host.querySelector(".file-viewer-title-text")!)).toBe(false);
    // Decorative, so it stays draggable rather than being a dead corner.
    expect(isNoDrag(host.querySelector(".file-viewer-spinner-slot")!)).toBe(false);
    expect(isNoDrag(host.querySelector(".file-viewer-toc-toggle")!)).toBe(true);
    expect(isNoDrag(host.querySelector(".file-viewer-mode-toggle")!)).toBe(true);
  });

  it("keeps the main nav's brand draggable while its icon buttons opt out", () => {
    const host = mount(`
      <div class="reck-window-header nav">
        <div class="nav-brand">Reck<span class="dot"></span></div>
        <div class="nav-subtitle">Satellite</div>
        <div class="nav-spacer"></div>
        <div class="nav-actions"><button class="icon-btn" id="nav-rail">i</button></div>
      </div>
    `);
    expect(isNoDrag(host.querySelector(".nav-brand")!)).toBe(false);
    expect(isNoDrag(host.querySelector(".nav-subtitle")!)).toBe(false);
    expect(isNoDrag(host.querySelector(".nav-spacer")!)).toBe(false);
    // Nested one level down — the opt-out must match descendants, not just
    // direct children of the header.
    expect(isNoDrag(host.querySelector("#nav-rail")!)).toBe(true);
  });

  it("has no blanket child opt-out that would swallow the whole bar", () => {
    expect(noDragSelectors).not.toContain(".reck-window-header > *");
  });
});
