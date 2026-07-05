import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProjectPreview } from "./project-detect";

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
