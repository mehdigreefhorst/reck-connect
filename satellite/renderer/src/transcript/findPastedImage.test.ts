import { describe, it, expect, vi } from "vitest";
import {
  createPastedImageScanner,
  fetchPastedImage,
  findPastedImage,
} from "./findPastedImage";

const PNG = "iVBORw0KGgoAAAANSUhEUg";

/** A user message carrying `n` pasted images with the given ids. */
const pasteLine = (ids: number[], tag = "") =>
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"see"}${ids
    .map(
      (id) =>
        `,{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${PNG}${tag}${id}"}}`,
    )
    .join("")}]},"imagePasteIds":[${ids.join(",")}]}`;

/** A tool-result screenshot — has bytes but NO paste id. */
const toolResultLine = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":[{"type":"image","file":{"type":"image/png","base64":"${PNG}TOOL"}}]}]}}`;

describe("findPastedImage", () => {
  it("finds the image an id names, not the first image in the file", () => {
    const jsonl = [toolResultLine, pasteLine([4, 5]), pasteLine([6])].join("\n");
    expect(findPastedImage(jsonl, 5)).toMatchObject({ base64: `${PNG}5` });
    expect(findPastedImage(jsonl, 6)).toMatchObject({ base64: `${PNG}6` });
  });

  it("returns null for an id this session does not contain", () => {
    // The failure that matters: scrollback outliving its transcript must
    // yield NOTHING, never a neighbouring screenshot.
    expect(findPastedImage(pasteLine([1, 2]), 9)).toBeNull();
  });

  it("ignores images with no paste id", () => {
    expect(findPastedImage(toolResultLine, 1)).toBeNull();
  });

  it("matches across a slice boundary that splits a line", () => {
    const jsonl = pasteLine([3]);
    const cut = Math.floor(jsonl.length / 2);
    const scanner = createPastedImageScanner(3);
    expect(scanner.push(jsonl.slice(0, cut))).toBeNull();
    expect(scanner.push(jsonl.slice(cut))).toBeNull(); // no trailing newline yet
    expect(scanner.end()).toMatchObject({ base64: `${PNG}3` });
  });

  it("survives torn and non-JSON lines", () => {
    const jsonl = ['{"type":"user","message":', "not json at all", pasteLine([2])].join("\n");
    expect(findPastedImage(jsonl, 2)).toMatchObject({ base64: `${PNG}2` });
  });
});

describe("fetchPastedImage", () => {
  it("walks slices by the server's byte offset and stops at the first hit", async () => {
    const slices = [
      { chunk: `${toolResultLine}\n`, nextOffset: 100, hasMore: true },
      { chunk: `${pasteLine([7])}\n`, nextOffset: 200, hasMore: true },
      { chunk: `${pasteLine([8])}\n`, nextOffset: 300, hasMore: false },
    ];
    const fetchSlice = vi.fn(async (offset: number) => slices[offset / 100]);
    const img = await fetchPastedImage(7, { fetchSlice });
    expect(img).toMatchObject({ base64: `${PNG}7` });
    // Stopped as soon as it matched — the third slice was never requested.
    expect(fetchSlice.mock.calls.map((c) => c[0])).toEqual([0, 100]);
  });

  it("gives up at the byte budget rather than walking forever", async () => {
    // A server that always says "more" must not pin the renderer.
    const fetchSlice = vi.fn(async (offset: number) => ({
      chunk: `${toolResultLine}\n`,
      nextOffset: offset + 100,
      hasMore: true,
    }));
    expect(await fetchPastedImage(1, { fetchSlice, maxBytes: 500 })).toBeNull();
    expect(fetchSlice).toHaveBeenCalledTimes(5);
  });

  it("stops when the server stops advancing the offset", async () => {
    const fetchSlice = vi.fn(async () => ({ chunk: "", nextOffset: 0, hasMore: true }));
    expect(await fetchPastedImage(1, { fetchSlice })).toBeNull();
    expect(fetchSlice).toHaveBeenCalledTimes(1);
  });
});
