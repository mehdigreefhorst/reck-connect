import { describe, it, expect, vi } from "vitest";
import { createComponentPreview } from "./ComponentPreview";

const ready = { running: true, ready: true, port: 43000, error: "" };

describe("createComponentPreview", () => {
  it("frames the station dev server with the encoded target when ready", async () => {
    const api = { startPreview: vi.fn().mockResolvedValue(ready), getPreview: vi.fn().mockResolvedValue(ready), stopPreview: vi.fn().mockResolvedValue(undefined) };
    const h = createComponentPreview({ api, projectId: "p", stationHost: "100.1.2.3", targetRelPath: "src/components/Button.tsx" });
    document.body.appendChild(h.el);
    // Three microtask hops: vitest's mocked promise settles after two ticks,
    // plus one for this host's own `.then` handler that swaps in the iframe.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const iframe = h.el.querySelector("iframe")!;
    expect(iframe.getAttribute("src")).toBe("http://100.1.2.3:43000/?target=src%2Fcomponents%2FButton.tsx");
    expect(iframe.getAttribute("sandbox")).toBeNull();
    h.dispose();
  });

  it("forwards appRelPath (with defaulted hmrHost) to startPreview for a monorepo subdir app", async () => {
    const api = { startPreview: vi.fn().mockResolvedValue(ready), getPreview: vi.fn().mockResolvedValue(ready), stopPreview: vi.fn().mockResolvedValue(undefined) };
    const h = createComponentPreview({ api, projectId: "p", stationHost: "100.1.2.3", targetRelPath: "apps/dashboard-v2/src/App.tsx", appRelPath: "apps/dashboard-v2" });
    document.body.appendChild(h.el);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(api.startPreview).toHaveBeenCalledWith("p", { hmrHost: "100.1.2.3", appRelPath: "apps/dashboard-v2" });
    h.dispose();
  });

  it("shows a degrade panel and calls onError when start returns not-ready", async () => {
    const api = { startPreview: vi.fn().mockResolvedValue({ running:false, ready:false, port:0, error:"node not found on station" }), getPreview: vi.fn(), stopPreview: vi.fn().mockResolvedValue(undefined) };
    const onError = vi.fn();
    const h = createComponentPreview({ api, projectId: "p", stationHost: "h", targetRelPath: "a.tsx", onError });
    document.body.appendChild(h.el);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(h.el.textContent).toMatch(/node not found/);
    expect(onError).toHaveBeenCalled();
    expect(h.el.querySelector("iframe")).toBeNull();
    h.dispose();
  });

  it("shows degrade + onError when startPreview rejects", async () => {
    const api = { startPreview: vi.fn().mockRejectedValue(new Error("boom")), getPreview: vi.fn(), stopPreview: vi.fn().mockResolvedValue(undefined) };
    const onError = vi.fn();
    const h = createComponentPreview({ api, projectId: "p", stationHost: "h", targetRelPath: "a.tsx", onError });
    document.body.appendChild(h.el);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(onError).toHaveBeenCalled();
    h.dispose();
  });

  it("heartbeats while mounted and does NOT kill the shared server on dispose", async () => {
    vi.useFakeTimers();
    const api = { startPreview: vi.fn().mockResolvedValue(ready), getPreview: vi.fn().mockResolvedValue(ready), stopPreview: vi.fn().mockResolvedValue(undefined) };
    const h = createComponentPreview({ api, projectId: "p", stationHost: "h", targetRelPath: "a.tsx" });
    document.body.appendChild(h.el);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.getPreview).toHaveBeenCalledWith("p");
    const beats = api.getPreview.mock.calls.length;
    h.dispose();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(api.getPreview.mock.calls.length).toBe(beats);
    expect(api.stopPreview).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
