// Shared fixtures for the image-related Electron acceptance specs.
//
// `makePng` generates a real PNG at test time rather than committing opaque
// binary, so the expected dimensions are visible in the call site. `openPopup`
// drives the real `file:openInViewer` IPC and waits for the spawned
// BrowserWindow.

import type { Page } from "@playwright/test";
import type { launchApp } from "./harness";

/** 240x120 solid-colour PNG, generated at test time so there is no opaque
 *  binary in the repo and the expected dimensions are self-evident. */
export function makePng(width: number, height: number): Buffer {
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

export const openPopup = async (
  ctx: Awaited<ReturnType<typeof launchApp>>,
  filePath: string,
): Promise<Page> => {
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
