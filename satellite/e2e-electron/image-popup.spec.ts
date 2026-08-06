import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./harness";

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

/** 240x120 solid-colour PNG, generated at test time so there is no opaque
 *  binary in the repo and the expected dimensions are self-evident. */
function makePng(width: number, height: number): Buffer {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour RGB
  // One filter byte per scanline, then RGB triples.
  const raw = Buffer.concat(
    Array.from({ length: height }, () =>
      Buffer.concat([
        Buffer.from([0]),
        Buffer.concat(
          Array.from({ length: width }, () => Buffer.from([0x2e, 0x8b, 0x57])),
        ),
      ]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const openPopup = async (
  ctx: Awaited<ReturnType<typeof launchApp>>,
  filePath: string,
) => {
  const popupPromise = ctx.app.waitForEvent("window");
  await ctx.window.evaluate(async (p) => {
    await (
      window as unknown as {
        reckAPI: { files: { openInViewer(t: string): Promise<unknown> } };
      }
    ).reckAPI.files.openInViewer(p);
  }, filePath);
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  return popup;
};

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
