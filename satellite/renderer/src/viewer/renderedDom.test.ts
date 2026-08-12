// @vitest-environment jsdom
// satellite/renderer/src/viewer/renderedDom.test.ts
import { describe, it, expect, vi } from "vitest";
import { createRenderedDom, isInsideSvg } from "./renderedDom";

describe("createRenderedDom.mount", () => {
  it("sets innerHTML and wraps free-text paths as internal links", () => {
    const dom = createRenderedDom();
    const el = document.createElement("div");
    dom.mount(el, "<p>see services/foo.ts here</p>");
    const a = el.querySelector("a.reck-internal-link");
    expect(a?.getAttribute("href")).toBe("services/foo.ts");
  });

  it("blocks plain clicks and routes Cmd+click on internal links", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="./x.md">x</a>');
    const a = el.querySelector("a")!;

    const plain = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(onLinkActivate).not.toHaveBeenCalled();

    const meta = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    a.dispatchEvent(meta);
    expect(onLinkActivate).toHaveBeenCalledWith("./x.md", expect.any(MouseEvent));
  });

  it("routes Cmd+click on external links to onExternalActivate", () => {
    const onExternalActivate = vi.fn();
    const dom = createRenderedDom({ onExternalActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="https://example.com">e</a>');
    el.querySelector("a")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onExternalActivate).toHaveBeenCalledWith(
      "https://example.com",
      expect.any(MouseEvent),
    );
  });

  it("dispose() detaches the click handler", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="./x.md">x</a>');
    const a = el.querySelector("a")!;
    dom.dispose();
    a.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onLinkActivate).not.toHaveBeenCalled();
  });
});

describe("isInsideSvg", () => {
  function build(html: string): HTMLElement {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
  }

  it("is true for a text node inside a mermaid-style svg", () => {
    // Shape mermaid actually produces: <text> labels nested a few levels down.
    const root = build("<svg><g><text>node label</text></g></svg>");
    const label = root.querySelector("text")!.firstChild!;
    expect(isInsideSvg(label, root)).toBe(true);
  });

  it("is true for the svg element itself", () => {
    const root = build("<svg><g></g></svg>");
    expect(isInsideSvg(root.querySelector("svg")!, root)).toBe(true);
  });

  it("is false for prose beside a diagram", () => {
    const root = build("<p>prose</p><svg><text>label</text></svg>");
    const prose = root.querySelector("p")!.firstChild!;
    expect(isInsideSvg(prose, root)).toBe(false);
  });

  it("is false for the root itself", () => {
    const root = build("<p>prose</p>");
    expect(isInsideSvg(root, root)).toBe(false);
  });

  it("stops at the root — an svg ancestor above it does not count", () => {
    const outer = document.createElement("div");
    outer.innerHTML = "<svg><foreignObject></foreignObject></svg>";
    const root = outer.querySelector("foreignObject") as unknown as HTMLElement;
    root.innerHTML = "<p>prose</p>";
    const prose = root.querySelector("p")!.firstChild!;
    expect(isInsideSvg(prose, root)).toBe(false);
  });
});

describe("createRenderedDom — lightbox lifecycle", () => {
  it("opens the lightbox on a plain image click", () => {
    const dom = createRenderedDom();
    const el = document.createElement("div");
    dom.mount(el, '<img src="a.png" alt="pic">');
    el.querySelector("img")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(el.querySelector(".reck-lightbox")).not.toBeNull();
    dom.dispose();
  });

  it("Cmd+click on a linked image still routes to onLinkActivate", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const el = document.createElement("div");
    dom.mount(el, '<a href="./x.md"><img src="a.png" alt="pic"></a>');
    el.querySelector("img")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onLinkActivate).toHaveBeenCalledWith("./x.md", expect.anything());
    expect(el.querySelector(".reck-lightbox")).toBeNull();
    dom.dispose();
  });

  it("re-mounting does not stack lightbox listeners", () => {
    const dom = createRenderedDom();
    const el = document.createElement("div");
    dom.mount(el, '<img src="a.png" alt="pic">');
    dom.mount(el, '<img src="b.png" alt="pic2">');
    el.querySelector("img")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(el.querySelectorAll(".reck-lightbox")).toHaveLength(1);
    dom.dispose();
  });

  it("dispose closes an open lightbox", () => {
    const dom = createRenderedDom();
    const el = document.createElement("div");
    dom.mount(el, '<img src="a.png" alt="pic">');
    el.querySelector("img")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    dom.dispose();
    expect(el.querySelector(".reck-lightbox")).toBeNull();
  });
});

// The transcript overlay mounts ONE renderer into one container per assistant
// block. A single attachment slot meant only the newest block could zoom.
describe("createRenderedDom — many containers, one handle", () => {
  function connected(): HTMLElement {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
  }

  const click = (el: HTMLElement): void => {
    el.querySelector("img")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  };

  it("keeps every mounted container lightbox-capable", () => {
    const dom = createRenderedDom();
    const first = connected();
    const second = connected();
    dom.mount(first, '<img src="a.png" alt="a">');
    dom.mount(second, '<img src="b.png" alt="b">');

    // The earlier block must still zoom — this is the regression.
    click(first);
    expect(first.querySelector(".reck-lightbox")).not.toBeNull();
    click(second);
    expect(second.querySelector(".reck-lightbox")).not.toBeNull();

    dom.dispose();
    first.remove();
    second.remove();
  });

  it("mounting a new container does not close another's open lightbox", () => {
    const dom = createRenderedDom();
    const first = connected();
    dom.mount(first, '<img src="a.png" alt="a">');
    click(first);
    expect(first.querySelector(".reck-lightbox")).not.toBeNull();

    // A newly streamed assistant block used to yank the overlay out mid-view.
    const second = connected();
    dom.mount(second, '<img src="b.png" alt="b">');
    expect(first.querySelector(".reck-lightbox")).not.toBeNull();

    dom.dispose();
    first.remove();
    second.remove();
  });

  it("routes Cmd+click from any container, not just the newest", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const first = connected();
    const second = connected();
    dom.mount(first, '<a href="./a.md">a</a>');
    dom.mount(second, '<a href="./b.md">b</a>');

    first.querySelector("a")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onLinkActivate).toHaveBeenCalledWith("./a.md", expect.anything());

    dom.dispose();
    first.remove();
    second.remove();
  });

  it("dispose tears down every container", () => {
    const onLinkActivate = vi.fn();
    const dom = createRenderedDom({ onLinkActivate });
    const first = connected();
    const second = connected();
    dom.mount(first, '<a href="./a.md">a</a><img src="a.png" alt="a">');
    dom.mount(second, '<a href="./b.md">b</a><img src="b.png" alt="b">');
    click(first);
    click(second);

    dom.dispose();

    expect(first.querySelector(".reck-lightbox")).toBeNull();
    expect(second.querySelector(".reck-lightbox")).toBeNull();
    for (const el of [first, second]) {
      el.querySelector("a")!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
      click(el);
      expect(el.querySelector(".reck-lightbox")).toBeNull();
    }
    expect(onLinkActivate).not.toHaveBeenCalled();

    first.remove();
    second.remove();
  });

  it("forgets containers that left the DOM, so attachments cannot pile up", () => {
    // The map is strong (dispose() has to iterate it), so a long-lived
    // transcript would otherwise pin every block it has ever discarded —
    // and each one's document-level Escape listener with it.
    const dom = createRenderedDom();
    const gone = connected();
    dom.mount(gone, '<img src="a.png" alt="a">');
    click(gone);
    expect(gone.querySelector(".reck-lightbox")).not.toBeNull();

    gone.remove();
    const next = connected();
    dom.mount(next, '<img src="b.png" alt="b">');

    // Swept: its lightbox was disposed, which closes any open overlay.
    expect(gone.querySelector(".reck-lightbox")).toBeNull();
    click(gone);
    expect(gone.querySelector(".reck-lightbox")).toBeNull();

    dom.dispose();
    next.remove();
  });
});
