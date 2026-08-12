import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./harness";
import { makePng, openPopup } from "./imageFixtures";

// Acceptance tests for images INSIDE rendered markdown. The unit tests stub
// `files.imageMeta`, so they can only prove the wiring; whether a markdown
// figure actually decodes is answerable only here, against the real protocol
// handler and a real Chromium decoder.
//
// Fixtures live under the harness's temp HOME because $HOME is a built-in
// allowed root (main/file-roots.ts).

/** Writes `<home>/mddoc/doc.md` plus a sibling PNG, returns the .md path. */
function writeDoc(homeDir: string, markdown: string): string {
  const dir = path.join(homeDir, "mddoc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rack.png"), makePng(240, 120));
  const docPath = path.join(dir, "doc.md");
  fs.writeFileSync(docPath, markdown, "utf8");
  return docPath;
}

test("a relative markdown image decodes through reck-img://", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
    const docPath = writeDoc(ctx.homeDir, "# Doc\n\n![rack](./rack.png)\n");
    const popup = await openPopup(ctx, docPath);

    const img = popup.locator(".file-viewer-body img").first();
    await expect(img).toBeVisible({ timeout: 10_000 });
    // Auto-retrying, because a local image carries NO `src` at all until the
    // async enhancement pass fills it in — and the parked <img> is already
    // visible before then (its alt text gives it a non-zero box). A plain
    // getAttribute here races the pass. The pattern also pins the resolved
    // file, so a mis-resolution that happened to land on some other readable
    // image would not slip through.
    await expect(img).toHaveAttribute("src", /^reck-img:\/\/.*rack\.png/, {
      timeout: 10_000,
    });

    // THE assertion: non-zero only if the handler served bytes and Chromium
    // decoded them.
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 10_000,
      })
      .toBe(240);
    await expect(popup.locator(".reck-image-missing")).toHaveCount(0);

    await popup.screenshot({ path: "e2e/artifacts/markdown-image-electron.png" });
  } finally {
    await ctx.close();
  }
});

test("a wikilink embed decodes the same way", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
    const docPath = writeDoc(ctx.homeDir, "# Doc\n\n![[rack.png]]\n");
    const popup = await openPopup(ctx, docPath);

    const img = popup.locator(".file-viewer-body img").first();
    await expect(img).toBeVisible({ timeout: 10_000 });
    // Same scheme + filename assertion as the `![](…)` case: naturalWidth
    // alone would still be 240 if the wikilink rule regressed to emitting a
    // plain `file://` src, which decodes fine in a file://-origin renderer.
    // The embed must go through the SAME minting path, not merely paint.
    await expect(img).toHaveAttribute("src", /^reck-img:\/\/.*rack\.png/, {
      timeout: 10_000,
    });
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 10_000,
      })
      .toBe(240);
    await expect(popup.locator(".reck-image-missing")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

test("a markdown image outside the allowed roots becomes a placeholder", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
    // An ABSOLUTE path outside every allowed root, rather than a `../` chain:
    // a chain's escape depth is a function of how deep os.tmpdir() happens to
    // be, so it could silently stop escaping. This states the intent directly.
    // The path need not exist — main's roots gate
    // (`resolveInsideAllowedRoots`, main/file-viewer.ts) runs before any stat,
    // so the failure is `out-of-roots` and never degrades to `not-found`.
    const docPath = writeDoc(ctx.homeDir, "# Doc\n\n![x](/etc/passwd.png)\n");
    const popup = await openPopup(ctx, docPath);

    const placeholder = popup.locator(".reck-image-missing");
    await expect(placeholder).toHaveCount(1, { timeout: 10_000 });
    await expect(placeholder).toContainText("outside the allowed folders");
    // No <img> was left behind to fire a request.
    await expect(popup.locator(".file-viewer-body img")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
