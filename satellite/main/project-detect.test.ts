import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectPreview, detectPreviewForFile } from "./project-detect";

function proj(pkg: object, files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "reck-pd-"));
  writeFileSync(join(d, "package.json"), JSON.stringify(pkg));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(d, name), content);
  }
  return d;
}

describe("detectProjectPreview", () => {
  it("previewable: vite (devDep) + react", async () => {
    const d = proj({
      devDependencies: { vite: "^5" },
      dependencies: { react: "^18" },
    });
    expect((await detectProjectPreview(d)).previewable).toBe(true);
  });

  it("previewable: vite.config present + react, even without vite in package.json", async () => {
    const d = proj(
      { dependencies: { react: "^18" } },
      { "vite.config.ts": "export default {}" },
    );
    expect((await detectProjectPreview(d)).previewable).toBe(true);
  });

  it("not previewable: no vite → reason mentions vite", async () => {
    const d = proj({ dependencies: { react: "^18" } });
    const r = await detectProjectPreview(d);
    expect(r.previewable).toBe(false);
    expect(r.reason).toMatch(/vite/i);
  });

  it("not previewable: vite but no react", async () => {
    const d = proj({ devDependencies: { vite: "^5" } });
    expect((await detectProjectPreview(d)).previewable).toBe(false);
  });

  it("not previewable: no package.json (never throws)", async () => {
    const d = mkdtempSync(join(tmpdir(), "reck-empty-"));
    const r = await detectProjectPreview(d);
    expect(r.previewable).toBe(false);
    expect(r.reason).toMatch(/package\.json/i);
  });
});

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "reck-detect-"));
  return root;
}

describe("detectPreviewForFile (walk-up)", () => {
  it("finds a Vite+React app in a monorepo subdir", async () => {
    const root = scaffold();
    const app = join(root, "apps", "dashboard-v2");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { vite: "5", react: "18" } }));
    const info = await detectPreviewForFile(root, join(app, "src", "App.tsx"));
    expect(info).toEqual({ previewable: true, appRelPath: "apps/dashboard-v2", targetRelPath: "src/App.tsx", reason: "ok" });
    rmSync(root, { recursive: true, force: true });
  });

  it("treats a root-level Vite app as appRelPath=''", async () => {
    const root = scaffold();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "vite.config.ts"), "export default {}");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));
    const info = await detectPreviewForFile(root, join(root, "src", "App.tsx"));
    expect(info).toEqual({ previewable: true, appRelPath: "", targetRelPath: "src/App.tsx", reason: "ok" });
    rmSync(root, { recursive: true, force: true });
  });

  it("reports no-vite-app when nothing up the tree is Vite", async () => {
    const root = scaffold();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));
    const info = await detectPreviewForFile(root, join(root, "src", "App.tsx"));
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("no-vite-app");
    rmSync(root, { recursive: true, force: true });
  });

  it("reports vite-no-react when the nearest Vite app lacks React", async () => {
    const root = scaffold();
    const app = join(root, "apps", "cli");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "vite.config.ts"), "export default {}");
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { vite: "5" } }));
    const info = await detectPreviewForFile(root, join(app, "src", "main.tsx"));
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("vite-no-react");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not walk above the project root", async () => {
    const root = scaffold();
    // a Vite app ABOVE the project root must be ignored
    writeFileSync(join(root, "vite.config.ts"), "export default {}");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vite: "5", react: "18" } }));
    const proj = join(root, "packages", "inner");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));
    const info = await detectPreviewForFile(proj, join(proj, "src", "App.tsx"));
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("no-vite-app");
    rmSync(root, { recursive: true, force: true });
  });
});
