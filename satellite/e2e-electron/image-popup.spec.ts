import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./harness";
import { makePng, openPopup } from "./imageFixtures";

// Acceptance test for the image viewer in the REAL popup: a real
// BrowserWindow, the real preload, the real `file:openInViewer` IPC, and —
// the thing nothing else can cover — the real `reck-img://` protocol
// handler.
//
// jsdom has no decoder and no Electron `protocol`, so the unit tests can
// only prove the wiring. Whether bytes actually flow through the scheme and
// PAINT is only answerable here. `naturalWidth` is the assertion that
// matters: it is non-zero only if Chromium fetched and decoded the image.
//
// Fixtures go in the harness's temp HOME because $HOME is a built-in
// allowed root (main/file-roots.ts); the file-viewer IPC refuses anything
// outside them.

test("image popup fetches bytes over reck-img:// and decodes them", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });

    const filePath = path.join(ctx.homeDir, "render-check.png");
    fs.writeFileSync(filePath, makePng(240, 120));

    const popup = await openPopup(ctx, filePath);
    const img = popup.locator("img.file-viewer-image-img");
    await expect(img).toBeVisible({ timeout: 10_000});

    // The URL went through the custom scheme, not file:// or a data URI.
    expect(await img.getAttribute("src")).toContain("reck-img://");

    // THE assertion: non-zero only if the protocol handler served bytes
    // AND Chromium decoded them.
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 10_000,
      })
      .toBe(240);
    expect(
      await img.evaluate((el: HTMLImageElement) => el.naturalHeight),
    ).toBe(120);

    // Header keeps its normal treatment, and the meta line reports the
    // decoded dimensions.
    await expect(popup.locator(".file-viewer-title-text")).toBeVisible();
    await expect(popup.locator(".file-viewer-image-meta-text")).toContainText(
      "240 × 120",
    );

    await popup.screenshot({ path: "e2e/artifacts/image-popup-electron.png" });
  } finally {
    await ctx.close();
  }
});

test("reck-img:// refuses a path outside the allowed roots", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
    const filePath = path.join(ctx.homeDir, "roots-check.png");
    fs.writeFileSync(filePath, makePng(8, 8));
    const popup = await openPopup(ctx, filePath);
    await expect(popup.locator("img.file-viewer-image-img")).toBeVisible({
      timeout: 10_000,
    });

    // Forge a URL for a file the user never asked for. Without the roots
    // check in the handler this would load, which is the whole reason the
    // scheme re-validates rather than trusting the renderer.
    const loaded = await popup.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const probe = new Image();
          probe.onload = () => resolve(true);
          probe.onerror = () => resolve(false);
          probe.src =
            "reck-img://local/?p=" +
            encodeURIComponent("/etc/passwd.png") +
            "&v=1";
          setTimeout(() => resolve(false), 5_000);
        }),
    );
    expect(loaded).toBe(false);
  } finally {
    await ctx.close();
  }
});

// HEIC is the iPhone capture default, so it is the format most likely to
// land on the Mac and the one worth an end-to-end proof. Chromium has no
// HEIC decoder — a non-zero naturalWidth here is only possible if the
// sips transcode ran inside the protocol pipeline.
test("HEIC is transcoded by sips and paints", async () => {
  test.skip(process.platform !== "darwin", "sips is macOS-only");
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });

    // Build a real HEIC by round-tripping a generated PNG through sips.
    const png = path.join(ctx.homeDir, "src.png");
    fs.writeFileSync(png, makePng(200, 100));
    const heic = path.join(ctx.homeDir, "photo.heic");
    execFileSync("/usr/bin/sips", ["-s", "format", "heic", png, "--out", heic], {
      stdio: "ignore",
    });

    const popup = await openPopup(ctx, heic);
    const img = popup.locator("img.file-viewer-image-img");
    await expect(img).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 20_000,
      })
      .toBe(200);
    await expect(popup.locator(".file-viewer-image-meta-text")).toContainText(
      "200 × 100",
    );
    await popup.screenshot({ path: "e2e/artifacts/image-popup-heic.png" });
  } finally {
    await ctx.close();
  }
});
