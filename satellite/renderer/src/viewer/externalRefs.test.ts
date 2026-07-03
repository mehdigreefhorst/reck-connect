// @vitest-environment jsdom
// satellite/renderer/src/viewer/externalRefs.test.ts
import { describe, it, expect } from "vitest";
import {
  neutralizeExternalRefs,
  countBlockedExternalRefs,
  restoreExternalRefs,
} from "./externalRefs";

/** Build a detached root whose innerHTML is `html`. */
const makeRoot = (html: string): HTMLElement => {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
};

/**
 * Per-vector matrix. Each row provides the markup, the selector to find the
 * neutralized element, the live attribute that must vanish, the parked
 * attribute that must appear, and the exact value expected to be parked.
 */
interface VectorCase {
  name: string;
  html: string;
  selector: string;
  liveAttr: string;
  parkAttr: string;
  parkedValue: string;
}

const EXTERNAL = "https://tracker.example/pixel.png";

const VECTOR_CASES: VectorCase[] = [
  {
    name: "img src",
    html: `<img src="${EXTERNAL}">`,
    selector: "img",
    liveAttr: "src",
    parkAttr: "data-reck-blocked-src",
    parkedValue: EXTERNAL,
  },
  {
    name: "img srcset",
    html: `<img srcset="${EXTERNAL} 1x, ${EXTERNAL} 2x">`,
    selector: "img",
    liveAttr: "srcset",
    parkAttr: "data-reck-blocked-srcset",
    parkedValue: `${EXTERNAL} 1x, ${EXTERNAL} 2x`,
  },
  {
    name: "source src",
    html: `<video><source src="${EXTERNAL}"></video>`,
    selector: "source",
    liveAttr: "src",
    parkAttr: "data-reck-blocked-src",
    parkedValue: EXTERNAL,
  },
  {
    name: "source srcset",
    html: `<picture><source srcset="${EXTERNAL} 1x"></picture>`,
    selector: "source",
    liveAttr: "srcset",
    parkAttr: "data-reck-blocked-srcset",
    parkedValue: `${EXTERNAL} 1x`,
  },
  {
    name: "video src",
    html: `<video src="${EXTERNAL}"></video>`,
    selector: "video",
    liveAttr: "src",
    parkAttr: "data-reck-blocked-src",
    parkedValue: EXTERNAL,
  },
  {
    name: "video poster",
    html: `<video poster="${EXTERNAL}"></video>`,
    selector: "video",
    liveAttr: "poster",
    parkAttr: "data-reck-blocked-poster",
    parkedValue: EXTERNAL,
  },
  {
    name: "audio src",
    html: `<audio src="${EXTERNAL}"></audio>`,
    selector: "audio",
    liveAttr: "src",
    parkAttr: "data-reck-blocked-src",
    parkedValue: EXTERNAL,
  },
  {
    name: "track src",
    html: `<video><track src="${EXTERNAL}"></video>`,
    selector: "track",
    liveAttr: "src",
    parkAttr: "data-reck-blocked-src",
    parkedValue: EXTERNAL,
  },
  {
    name: "input[type=image] src",
    html: `<input type="image" src="${EXTERNAL}">`,
    selector: "input",
    liveAttr: "src",
    parkAttr: "data-reck-blocked-src",
    parkedValue: EXTERNAL,
  },
  {
    name: "table background",
    html: `<table background="${EXTERNAL}"></table>`,
    selector: "table",
    liveAttr: "background",
    parkAttr: "data-reck-blocked-background",
    parkedValue: EXTERNAL,
  },
  {
    name: "svg image href",
    html: `<svg><image href="${EXTERNAL}"></image></svg>`,
    selector: "image",
    liveAttr: "href",
    parkAttr: "data-reck-blocked-href",
    parkedValue: EXTERNAL,
  },
  {
    name: "svg image xlink:href",
    html: `<svg><image xlink:href="${EXTERNAL}"></image></svg>`,
    selector: "image",
    liveAttr: "xlink:href",
    parkAttr: "data-reck-blocked-xlinkhref",
    parkedValue: EXTERNAL,
  },
];

describe("neutralizeExternalRefs — per-vector", () => {
  it.each(VECTOR_CASES)(
    "$name: neutralize removes the live ref, parks it, and count reflects it",
    ({ html, selector, liveAttr, parkAttr, parkedValue }) => {
      const root = makeRoot(html);
      const el = root.querySelector(selector);
      expect(el).not.toBeNull();
      // Precondition: the live reference is present before neutralizing.
      expect(el!.getAttribute(liveAttr)).not.toBeNull();

      const neutralized = neutralizeExternalRefs(root);
      expect(neutralized).toBe(1);

      // Live ref gone, value parked verbatim.
      expect(el!.hasAttribute(liveAttr)).toBe(false);
      expect(el!.getAttribute(parkAttr)).toBe(parkedValue);

      // Per-element count reflects the single blocked element.
      expect(countBlockedExternalRefs(root)).toBe(1);
    },
  );

  it.each(VECTOR_CASES)(
    "$name: restore fully reverses neutralize",
    ({ html, selector, liveAttr, parkAttr, parkedValue }) => {
      const root = makeRoot(html);
      const before = root.innerHTML;
      neutralizeExternalRefs(root);
      restoreExternalRefs(root);

      const el = root.querySelector(selector);
      expect(el).not.toBeNull();
      // Live ref restored to its original value, park attr removed.
      expect(el!.getAttribute(liveAttr)).toBe(parkedValue);
      expect(el!.hasAttribute(parkAttr)).toBe(false);
      // Nothing left blocked and the markup matches the pre-neutralize state.
      expect(countBlockedExternalRefs(root)).toBe(0);
      expect(root.innerHTML).toBe(before);
    },
  );
});

describe("neutralizeExternalRefs — srcset any-candidate rule", () => {
  it("parks the WHOLE srcset when ANY candidate is external", () => {
    const root = makeRoot(`<img srcset="./a.png 1x, ${EXTERNAL} 2x">`);
    expect(neutralizeExternalRefs(root)).toBe(1);
    const img = root.querySelector("img")!;
    expect(img.hasAttribute("srcset")).toBe(false);
    expect(img.getAttribute("data-reck-blocked-srcset")).toBe(
      `./a.png 1x, ${EXTERNAL} 2x`,
    );
  });

  it("leaves an all-relative srcset untouched", () => {
    const root = makeRoot(`<img srcset="./a.png 1x, ./b.png 2x">`);
    expect(neutralizeExternalRefs(root)).toBe(0);
    expect(root.querySelector("img")!.getAttribute("srcset")).toBe(
      "./a.png 1x, ./b.png 2x",
    );
  });
});

describe("neutralizeExternalRefs — inline style attribute", () => {
  it("parks the whole style value when it references an external url()", () => {
    const root = makeRoot(
      `<div style="color:red;background:url(${EXTERNAL})">x</div>`,
    );
    expect(neutralizeExternalRefs(root)).toBe(1);
    const div = root.querySelector("div")!;
    expect(div.hasAttribute("style")).toBe(false);
    expect(div.getAttribute("data-reck-blocked-style")).toBe(
      `color:red;background:url(${EXTERNAL})`,
    );
    expect(countBlockedExternalRefs(root)).toBe(1);
    restoreExternalRefs(root);
    expect(div.getAttribute("style")).toBe(
      `color:red;background:url(${EXTERNAL})`,
    );
    expect(div.hasAttribute("data-reck-blocked-style")).toBe(false);
  });

  it("leaves an inline style with only a relative url() untouched", () => {
    const root = makeRoot(`<div style="background:url(./bg.png)">x</div>`);
    expect(neutralizeExternalRefs(root)).toBe(0);
    expect(root.querySelector("div")!.getAttribute("style")).toBe(
      "background:url(./bg.png)",
    );
  });
});

describe("neutralizeExternalRefs — <style> element", () => {
  it("parks textContent that loads an external url()", () => {
    const css = `.a{background:url(${EXTERNAL})}`;
    const root = makeRoot(`<style>${css}</style><div class="a">x</div>`);
    expect(neutralizeExternalRefs(root)).toBe(1);
    const style = root.querySelector("style")!;
    expect(style.textContent).toBe("");
    expect(style.getAttribute("data-reck-blocked-styletext")).toBe(css);
    expect(countBlockedExternalRefs(root)).toBe(1);
    restoreExternalRefs(root);
    expect(style.textContent).toBe(css);
    expect(style.hasAttribute("data-reck-blocked-styletext")).toBe(false);
  });

  it("parks textContent that @imports an external stylesheet", () => {
    const css = `@import "${EXTERNAL}";`;
    const root = makeRoot(`<style>${css}</style>`);
    expect(neutralizeExternalRefs(root)).toBe(1);
    const style = root.querySelector("style")!;
    expect(style.textContent).toBe("");
    expect(style.getAttribute("data-reck-blocked-styletext")).toBe(css);
  });

  it("leaves a <style> with only relative/local CSS untouched", () => {
    const css = `.a{color:red;background:url(./bg.png)}`;
    const root = makeRoot(`<style>${css}</style>`);
    expect(neutralizeExternalRefs(root)).toBe(0);
    expect(root.querySelector("style")!.textContent).toBe(css);
  });
});

describe("neutralizeExternalRefs — background / input / feImage", () => {
  it("parks an external `background` on <td> (no live fetch), restore reverses", () => {
    const root = makeRoot(
      `<table><tbody><tr><td background="${EXTERNAL}">x</td></tr></tbody></table>`,
    );
    expect(neutralizeExternalRefs(root)).toBe(1);
    const td = root.querySelector("td")!;
    // Live background gone, parked verbatim — nothing fetches until consent.
    expect(td.hasAttribute("background")).toBe(false);
    expect(td.getAttribute("data-reck-blocked-background")).toBe(EXTERNAL);
    expect(countBlockedExternalRefs(root)).toBe(1);
    restoreExternalRefs(root);
    expect(td.getAttribute("background")).toBe(EXTERNAL);
    expect(td.hasAttribute("data-reck-blocked-background")).toBe(false);
  });

  it("leaves a relative `background` attribute live (external-only)", () => {
    const root = makeRoot(`<table background="./bg.png"></table>`);
    expect(neutralizeExternalRefs(root)).toBe(0);
    expect(root.querySelector("table")!.getAttribute("background")).toBe(
      "./bg.png",
    );
  });

  it("parks an external <input type=image src> (no eager load), restore reverses", () => {
    const root = makeRoot(`<input type="image" src="${EXTERNAL}">`);
    expect(neutralizeExternalRefs(root)).toBe(1);
    const input = root.querySelector("input")!;
    expect(input.hasAttribute("src")).toBe(false);
    expect(input.getAttribute("data-reck-blocked-src")).toBe(EXTERNAL);
    restoreExternalRefs(root);
    expect(input.getAttribute("src")).toBe(EXTERNAL);
    expect(input.hasAttribute("data-reck-blocked-src")).toBe(false);
  });

  it("parks an external SVG <feImage href>, restore reverses", () => {
    const root = makeRoot(
      `<svg><filter><feImage href="${EXTERNAL}"></feImage></filter></svg>`,
    );
    expect(neutralizeExternalRefs(root)).toBe(1);
    const fe = Array.from(root.querySelectorAll("*")).find(
      (el) => el.localName === "feImage",
    )!;
    expect(fe).not.toBeUndefined();
    expect(fe.hasAttribute("href")).toBe(false);
    expect(fe.getAttribute("data-reck-blocked-href")).toBe(EXTERNAL);
    expect(countBlockedExternalRefs(root)).toBe(1);
    restoreExternalRefs(root);
    expect(fe.getAttribute("href")).toBe(EXTERNAL);
    expect(fe.hasAttribute("data-reck-blocked-href")).toBe(false);
  });

  it("parks an external SVG <feImage xlink:href>, restore reverses", () => {
    const root = makeRoot(
      `<svg><filter><feImage xlink:href="${EXTERNAL}"></feImage></filter></svg>`,
    );
    expect(neutralizeExternalRefs(root)).toBe(1);
    const fe = Array.from(root.querySelectorAll("*")).find(
      (el) => el.localName === "feImage",
    )!;
    expect(fe).not.toBeUndefined();
    expect(fe.hasAttribute("xlink:href")).toBe(false);
    expect(fe.getAttribute("data-reck-blocked-xlinkhref")).toBe(EXTERNAL);
    restoreExternalRefs(root);
    expect(fe.getAttribute("xlink:href")).toBe(EXTERNAL);
    expect(fe.hasAttribute("data-reck-blocked-xlinkhref")).toBe(false);
  });
});

describe("neutralizeExternalRefs — CSS image-set()", () => {
  it("parks an inline style using bare-string image-set('https://…'), restore reverses", () => {
    const style = `background:image-set('${EXTERNAL}' 1x)`;
    const root = makeRoot(`<div style="${style}">x</div>`);
    expect(neutralizeExternalRefs(root)).toBe(1);
    const div = root.querySelector("div")!;
    expect(div.hasAttribute("style")).toBe(false);
    expect(div.getAttribute("data-reck-blocked-style")).toBe(style);
    restoreExternalRefs(root);
    expect(div.getAttribute("style")).toBe(style);
    expect(div.hasAttribute("data-reck-blocked-style")).toBe(false);
  });

  it("parks a <style> block using bare-string image-set('https://…'), restore reverses", () => {
    const css = `.a{background:image-set('${EXTERNAL}' 1x)}`;
    const root = makeRoot(`<style>${css}</style>`);
    expect(neutralizeExternalRefs(root)).toBe(1);
    const styleEl = root.querySelector("style")!;
    expect(styleEl.textContent).toBe("");
    expect(styleEl.getAttribute("data-reck-blocked-styletext")).toBe(css);
    restoreExternalRefs(root);
    expect(styleEl.textContent).toBe(css);
    expect(styleEl.hasAttribute("data-reck-blocked-styletext")).toBe(false);
  });

  it("still parks the image-set(url(https://…)) form (positive control)", () => {
    const style = `background:image-set(url(${EXTERNAL}) 1x)`;
    const root = makeRoot(`<div style="${style}">x</div>`);
    expect(neutralizeExternalRefs(root)).toBe(1);
    expect(
      root.querySelector("div")!.getAttribute("data-reck-blocked-style"),
    ).toBe(style);
  });

  it("does NOT park local url(#id) fragment refs or url(data:…) URIs", () => {
    const root = makeRoot(
      `<div style="fill:url(#grad);background:url(data:image/png;base64,AAAA)">x</div>` +
        `<style>.a{content:url(#frag)}</style>`,
    );
    expect(neutralizeExternalRefs(root)).toBe(0);
    expect(countBlockedExternalRefs(root)).toBe(0);
    expect(root.querySelector("div")!.hasAttribute("style")).toBe(true);
    expect(root.querySelector("style")!.textContent).toBe(
      ".a{content:url(#frag)}",
    );
  });
});

describe("neutralizeExternalRefs — untouched vectors", () => {
  it("leaves relative and data: URLs alone", () => {
    const root = makeRoot(
      `<img src="./a.png"><img src="data:image/png;base64,iVBOR">`,
    );
    expect(neutralizeExternalRefs(root)).toBe(0);
    expect(countBlockedExternalRefs(root)).toBe(0);
    const imgs = root.querySelectorAll("img");
    expect(imgs[0].getAttribute("src")).toBe("./a.png");
    expect(imgs[1].getAttribute("src")).toBe("data:image/png;base64,iVBOR");
  });
});

describe("countBlockedExternalRefs — per-element rule", () => {
  it("counts an element with several parked attrs only once", () => {
    const root = makeRoot(
      `<img src="${EXTERNAL}" srcset="${EXTERNAL} 1x, ${EXTERNAL} 2x">`,
    );
    // Two references neutralized (src + srcset)...
    expect(neutralizeExternalRefs(root)).toBe(2);
    // ...but only one blocked ELEMENT.
    expect(countBlockedExternalRefs(root)).toBe(1);
    const img = root.querySelector("img")!;
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.hasAttribute("srcset")).toBe(false);
    expect(img.getAttribute("data-reck-blocked-src")).toBe(EXTERNAL);
    expect(img.getAttribute("data-reck-blocked-srcset")).toBe(
      `${EXTERNAL} 1x, ${EXTERNAL} 2x`,
    );
    // Restore reverses both.
    restoreExternalRefs(root);
    expect(img.getAttribute("src")).toBe(EXTERNAL);
    expect(img.getAttribute("srcset")).toBe(`${EXTERNAL} 1x, ${EXTERNAL} 2x`);
    expect(countBlockedExternalRefs(root)).toBe(0);
  });
});

describe("mixed document", () => {
  const MIXED = [
    `<img src="${EXTERNAL}">`, // blocked
    `<img src="./local.png">`, // untouched (relative)
    `<img src="data:image/gif;base64,AAAA">`, // untouched (data:)
    `<style>.b{background:url(${EXTERNAL})}</style>`, // blocked
    `<div style="background:url(${EXTERNAL})">y</div>`, // blocked
    `<video poster="${EXTERNAL}"><source srcset="${EXTERNAL} 2x"></video>`, // 2 blocked elements
  ].join("");

  it("counts blocked elements correctly and leaves relative/data untouched", () => {
    const root = makeRoot(MIXED);
    const before = root.innerHTML;

    // References: img src(1) + style(1) + inline style(1) + video poster(1) +
    // source srcset(1) = 5 references.
    expect(neutralizeExternalRefs(root)).toBe(5);
    // Blocked ELEMENTS: img, style, div, video, source = 5 elements.
    expect(countBlockedExternalRefs(root)).toBe(5);

    // Relative + data: images keep their live src (no leak of the ban).
    const imgs = root.querySelectorAll("img");
    expect(imgs[1].getAttribute("src")).toBe("./local.png");
    expect(imgs[2].getAttribute("src")).toBe("data:image/gif;base64,AAAA");

    // No live external reference survives anywhere in the subtree.
    expect(root.querySelector("img[src]")!.getAttribute("src")).not.toContain(
      "tracker.example",
    );
    expect(root.querySelector("[poster]")).toBeNull();
    expect(root.querySelector("[srcset]")).toBeNull();
    expect(root.querySelector("style")!.textContent).toBe("");

    // Restore is an exact reverse of the whole mixed document.
    restoreExternalRefs(root);
    expect(countBlockedExternalRefs(root)).toBe(0);
    expect(root.innerHTML).toBe(before);
  });
});
