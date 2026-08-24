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
    const res = await fetchPastedImage(7, { fetchSlice });
    expect(res.image).toMatchObject({ base64: `${PNG}7` });
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
    expect((await fetchPastedImage(1, { fetchSlice, maxBytes: 500 })).image).toBeNull();
    expect(fetchSlice).toHaveBeenCalledTimes(5);
  });

  it("stops when the server stops advancing the offset", async () => {
    const fetchSlice = vi.fn(async () => ({ chunk: "", nextOffset: 0, hasMore: true }));
    expect((await fetchPastedImage(1, { fetchSlice })).image).toBeNull();
    expect(fetchSlice).toHaveBeenCalledTimes(1);
  });
});

describe("highestPasteId", () => {
  const line = (id: number) =>
    `{"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]},"imagePasteIds":[${id}]}`;

  // Distinguishes "you haven't sent this yet" from "this is from an
  // earlier session": a freshly pasted image always carries an id above
  // anything already written to the transcript, because the id is
  // assigned at paste time and the JSONL only gains it on send.
  it("reports the largest id present in the scanned transcript", async () => {
    const res = await fetchPastedImage(99, {
      fetchSlice: async () => ({
        chunk: [line(2), line(7), line(5)].join("\n") + "\n",
        nextOffset: 1,
        hasMore: false,
      }),
    });
    expect(res.image).toBeNull();
    expect(res.highestPasteId).toBe(7);
  });

  it("is 0 when the transcript carries no images at all", async () => {
    const res = await fetchPastedImage(3, {
      fetchSlice: async () => ({
        chunk: '{"type":"user","message":{"role":"user","content":[]}}\n',
        nextOffset: 1,
        hasMore: false,
      }),
    });
    expect(res.image).toBeNull();
    expect(res.highestPasteId).toBe(0);
  });

  it("still returns the image when found, alongside the highest id", async () => {
    const res = await fetchPastedImage(2, {
      fetchSlice: async () => ({
        chunk: [line(2), line(9)].join("\n") + "\n",
        nextOffset: 1,
        hasMore: false,
      }),
    });
    expect(res.image?.pasteId).toBe(2);
    // The walk stops at the hit, so ids after it are not counted -- the
    // value is only ever used on the not-found path.
    expect(res.highestPasteId).toBe(2);
  });

  it("accumulates the highest id across multiple slices", async () => {
    const chunks = [line(1) + "\n", line(4) + "\n", line(3) + "\n"];
    let i = 0;
    const res = await fetchPastedImage(99, {
      fetchSlice: async () => ({
        chunk: chunks[i] ?? "",
        nextOffset: ++i,
        hasMore: i < chunks.length,
      }),
    });
    expect(res.highestPasteId).toBe(4);
  });
});
