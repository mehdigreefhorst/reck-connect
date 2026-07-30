import { test, expect, type Page } from "@playwright/test";

// Browser-level tests of the markdown viewer's post-mount enhancement passes
// against renderer/markdown-harness.html (no daemon, no Electron).
//
// These live here rather than in vitest on purpose: jsdom has no layout engine
// and no real SVG, so it cannot tell a rendered mermaid diagram from a blank
// div. Only a real browser can judge whether §3/§4 of
// docs/markdown-viewer-integration.md actually work. The vitest suite covers
// the surrounding contract (when we load the libraries, what config we hand
// them, staleness); this file covers "did it paint".
//
// Screenshots land in e2e/artifacts/ alongside the usage-view ones.

// Relative to `use.baseURL` — see playwright.config.ts, which honours
// RECK_E2E_PORT so the suite can move off a contested 5173.
const HARNESS = "/markdown-harness.html";

async function openHarness(
  page: Page,
  opts: { fixture?: "rich" | "plain"; theme?: "light" | "dark" } = {},
): Promise<void> {
  const fixture = opts.fixture ?? "rich";
  const theme = opts.theme ?? "dark";
  await page.goto(`${HARNESS}?fixture=${fixture}&theme=${theme}`);
  // The harness sets this once whenEnhanced() has settled, so every assertion
  // below runs against a final layout rather than racing the lazy imports.
  await expect(page.locator("body[data-enhanced='true']")).toBeAttached();
}

test.describe("mermaid", () => {
  test("replaces the fence with an inline SVG diagram", async ({ page }) => {
    await openHarness(page);

    const svg = page.locator(".file-viewer-body .reck-mermaid svg");
    await expect(svg.first()).toBeVisible();

    // The source block must be gone, not merely hidden behind the diagram.
    await expect(
      page.locator(".file-viewer-body pre code.language-mermaid"),
    ).toHaveCount(0);

    // A diagram with real geometry, not a collapsed 0x0 placeholder.
    const box = await svg.first().boundingBox();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(50);
  });

  test("renders the diagram outside any code block", async ({ page }) => {
    await openHarness(page);
    // Regression guard for the shape the source doc's recipe produces: the SVG
    // living inside <pre><code>, wearing the code-block treatment. (Note
    // `.file-viewer-body` itself falls back to the mono stack when --font-sans
    // is unset, so the container's font proves nothing — check the diagram's.)
    await expect(page.locator(".file-viewer-body pre svg")).toHaveCount(0);
    await expect(page.locator(".file-viewer-body pre .reck-mermaid")).toHaveCount(0);

    const font = await page
      .locator(".file-viewer-body .reck-mermaid svg")
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(font).not.toMatch(/mono/i);
  });

  test("renders the node labels from the flowchart", async ({ page }) => {
    await openHarness(page);
    // Mermaid v11 flowcharts put labels in <foreignObject> HTML rather than
    // SVG <text>, so assert on the diagram's text content instead of a tag.
    const labels = await page
      .locator(".file-viewer-body .reck-mermaid svg")
      .first()
      .evaluate((el) => el.textContent ?? "");
    expect(labels).toContain("Open .md popup");
    expect(labels).toContain("Skip the 600 KB");
  });

  test("leaves non-mermaid fenced code as a code block", async ({ page }) => {
    await openHarness(page);
    const ts = page.locator(".file-viewer-body code.language-typescript");
    await expect(ts).toBeVisible();
    // The `$E=mc^2$` inside the code sample must NOT have been typeset —
    // KaTeX ignores pre/code by default and we rely on that.
    await expect(ts.locator(".katex")).toHaveCount(0);
    await expect(ts).toContainText("$E=mc^2$");
  });
});

test.describe("KaTeX", () => {
  test("typesets inline and display math", async ({ page }) => {
    await openHarness(page);
    const katex = page.locator(".file-viewer-body .katex");
    // Inline, display, and the deliberately-malformed one.
    expect(await katex.count()).toBeGreaterThanOrEqual(2);
    await expect(page.locator(".file-viewer-body .katex-display")).toBeVisible();
  });

  test("emits no MathML, so search and TTS see each equation once", async ({
    page,
  }) => {
    await openHarness(page);
    // output:"html" — the default htmlAndMathml would add a parallel subtree
    // holding the LaTeX source, which both text-walkers would index twice.
    await expect(page.locator(".file-viewer-body .katex-mathml")).toHaveCount(0);
    await expect(page.locator(".file-viewer-body math")).toHaveCount(0);
  });

  test("a malformed equation renders in place instead of breaking the page", async ({
    page,
  }) => {
    await openHarness(page);
    // throwOnError:false — the rest of the document must still be there.
    await expect(page.locator(".file-viewer-body h1")).toBeVisible();
    await expect(page.locator(".file-viewer-body img")).toBeVisible();
  });
});

test.describe("lazy loading", () => {
  test("a document with diagrams and math fetches both libraries", async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await openHarness(page, { fixture: "rich" });

    expect(requested.some((u) => /mermaid/i.test(u))).toBe(true);
    expect(requested.some((u) => /katex/i.test(u))).toBe(true);
  });

  test("a plain document fetches neither", async ({ page }) => {
    // This is the whole point of the lazy import: ~600 KB of mermaid and
    // ~280 KB of KaTeX must not load for the majority of files, which contain
    // neither diagrams nor math.
    const requested: string[] = [];
    page.on("request", (r) => requested.push(r.url()));
    await openHarness(page, { fixture: "plain" });

    expect(requested.filter((u) => /mermaid/i.test(u))).toEqual([]);
    expect(requested.filter((u) => /katex/i.test(u))).toEqual([]);
  });
});

test.describe("console health", () => {
  test("renders without CSP violations or library errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));

    await openHarness(page);

    expect(
      errors.filter((e) => /Content Security Policy|mermaid|katex/i.test(e)),
    ).toEqual([]);
  });
});

test.describe("screenshots", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} theme renders diagrams and math`, async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 1100 });
      await openHarness(page, { theme });
      await expect(page.locator(".file-viewer-body .reck-mermaid svg").first()).toBeVisible();
      await page.screenshot({
        path: `e2e/artifacts/markdown-${theme}.png`,
        fullPage: true,
      });
    });
  }
});
