import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ApiClient } from "./client";

// Component live preview (Phase B, Task 9): the satellite viewer drives the
// daemon's /projects/:id/preview lifecycle through these three ApiClient
// methods. Mirrors the fetch-mock convention used throughout client.test.ts
// (direct global.fetch assignment saved/restored per test).
describe("ApiClient preview lifecycle", () => {
  let origFetch: typeof fetch;

  beforeEach(() => {
    origFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = origFetch;
  });

  const statusBody = { running: true, ready: false, port: 5174, error: "" };

  it("POSTs /projects/:id/preview with bearer + hmr_host body for startPreview", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315", token: "sek" });
    let captured = { url: "", method: "", body: "", auth: "" };
    global.fetch = vi.fn(async (u, init) => {
      const headers = (init?.headers as Record<string, string>) ?? {};
      captured = {
        url: String(u),
        method: String(init?.method ?? "GET"),
        body: String(init?.body ?? ""),
        auth: headers["Authorization"] ?? "",
      };
      return new Response(JSON.stringify(statusBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resp = await c.startPreview("p", { hmrHost: "100.1.2.3" });

    expect(captured.url).toBe("http://x:7315/projects/p/preview");
    expect(captured.method).toBe("POST");
    expect(captured.auth).toBe("Bearer sek");
    expect(JSON.parse(captured.body)).toEqual({ hmr_host: "100.1.2.3" });
    expect(resp).toEqual(statusBody);
  });

  it("defaults hmr_host to empty string when opts omitted", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { body: "" };
    global.fetch = vi.fn(async (_u, init) => {
      captured = { body: String(init?.body ?? "") };
      return new Response(JSON.stringify(statusBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await c.startPreview("p");

    expect(JSON.parse(captured.body)).toEqual({ hmr_host: "" });
  });

  it("GETs /projects/:id/preview for getPreview and parses the status", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "", method: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = { url: String(u), method: String(init?.method ?? "GET") };
      return new Response(JSON.stringify(statusBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const resp = await c.getPreview("p");

    expect(captured.url).toBe("http://x:7315/projects/p/preview");
    expect(captured.method).toBe("GET");
    expect(resp).toEqual(statusBody);
  });

  it("DELETEs /projects/:id/preview for stopPreview and resolves undefined on 204", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    let captured = { url: "", method: "" };
    global.fetch = vi.fn(async (u, init) => {
      captured = { url: String(u), method: String(init?.method ?? "GET") };
      // Node's Response rejects a body on 204; use an empty body.
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    await expect(c.stopPreview("p")).resolves.toBeUndefined();
    expect(captured.url).toBe("http://x:7315/projects/p/preview");
    expect(captured.method).toBe("DELETE");
  });

  it("rejects on a non-2xx preview response (existing HttpError convention)", async () => {
    const c = new ApiClient({ baseUrl: "http://x:7315" });
    global.fetch = vi.fn(
      async () => new Response("boom", { status: 500, statusText: "Server Error" }),
    ) as unknown as typeof fetch;

    await expect(c.startPreview("p")).rejects.toThrow(/500/);
  });
});
