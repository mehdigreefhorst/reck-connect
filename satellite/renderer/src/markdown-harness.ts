// Dev/e2e harness for the markdown file viewer (issues #108/#109). Mounts the
// REAL createMarkdownRenderer inside the real `.file-viewer-root` /
// `.file-viewer-body` shell markup, so mermaid diagrams, KaTeX math, images and
// link handling can be exercised — and screenshotted — without a daemon, a
// preload script, or Electron. Mirrors usage-harness.ts.
//
// Not listed in vite.config.ts `rollupOptions.input`: this page exists only on
// the dev server and never reaches the shipped bundle.
//
// Query parameters:
//   ?fixture=rich|plain   which document to render (default: rich)
//   ?theme=dark|light     palette (default: dark)
//
// The `plain` fixture is what proves the lazy-import contract: rendering it
// must not fetch mermaid or katex at all.

import "./styles.css";
import { createMarkdownRenderer } from "./viewer/MarkdownRenderer";

const FIXTURES: Record<string, string> = {
  // Exercises every Phase 1–4 surface at once: a diagram, inline + display
  // math, an image, enough headings for a TOC, and both link flavours.
  rich: `# Markdown viewer harness

Prose paragraph before the diagram, with an internal link to
[the renderer](./src/viewer/MarkdownRenderer.ts) and an external one to
[mermaid docs](https://mermaid.js.org/config/usage.html).

## Diagram

\`\`\`mermaid
flowchart TD
  A[Open .md popup] --> B{Has fences?}
  B -->|mermaid| C[Load mermaid chunk]
  B -->|none| D[Skip the 600 KB]
  C --> E[Replace fence with SVG]
\`\`\`

## Math

Inline: the identity $E=mc^2$ sits mid-sentence.

Display:

$$\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}$$

### Bad equation degrades, it does not throw

Inline nonsense: $\\frac{1}{$ should render red, not break the page.

## Code is left alone

\`\`\`typescript
const notMath = "$E=mc^2$";
\`\`\`

## Image

![sample image](/fixtures/sample-image.svg)

### Nested heading four

Trailing prose so the last heading has something to scroll to.

#### Heading level four

More trailing prose. More trailing prose. More trailing prose.
More trailing prose. More trailing prose. More trailing prose.
`,

  // No diagrams, no math — the negative control for the lazy-import contract.
  plain: `# Plain document

Just prose, a list and a code block. Nothing here should pull in mermaid
or katex.

## A list

- one
- two
- three

\`\`\`typescript
const x = 1;
\`\`\`
`,
};

function buildShell(): HTMLElement {
  const root = document.createElement("div");
  root.className = "file-viewer-root";

  const header = document.createElement("div");
  header.className = "file-viewer-header";
  const title = document.createElement("div");
  title.className = "file-viewer-title";
  title.textContent = "markdown-harness.md";
  header.appendChild(title);

  const body = document.createElement("div");
  body.className = "file-viewer-body";

  root.appendChild(header);
  root.appendChild(body);
  document.body.appendChild(root);
  return body;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const theme = params.get("theme") === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);

  const fixture = params.get("fixture") ?? "rich";
  const source = FIXTURES[fixture] ?? FIXTURES.rich;

  const body = buildShell();
  const renderer = createMarkdownRenderer({
    onLinkActivate: (href) => console.log("[harness] internal activate", href),
    onExternalActivate: (href) => console.log("[harness] external activate", href),
  });

  renderer.mount(body, renderer.render(source));
  await renderer.whenEnhanced();

  // Signal for Playwright / manual inspection: the post-mount passes have
  // settled, so the document height is final and it is safe to screenshot.
  document.body.dataset.enhanced = "true";
  console.log(`[harness] enhanced fixture=${fixture} theme=${theme}`);
}

void main();
