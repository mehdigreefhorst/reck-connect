import { describe, it, expect, vi } from "vitest";
import {
  detectStationProjectPreview,
  detectStationPreviewForFile,
} from "./stationPreviewDetect";

// Reader stub keyed by absolute station path. Missing key → null (the
// production wiring maps a failed `files.readStation` to null the same way).
function readerFor(files: Record<string, string>) {
  return vi.fn(async (p: string): Promise<string | null> => files[p] ?? null);
}

const CWD = "/home/strijders/projects/commitify";

describe("detectStationProjectPreview", () => {
  it("is previewable when vite and react are both dependencies", async () => {
    const read = readerFor({
      [`${CWD}/package.json`]: JSON.stringify({
        dependencies: { react: "^19.0.0" },
        devDependencies: { vite: "^6.0.0" },
      }),
    });
    await expect(detectStationProjectPreview(read, CWD)).resolves.toEqual({
      previewable: true,
      reason: "",
    });
  });

  it("accepts vite and react in either dependency block", async () => {
    const read = readerFor({
      [`${CWD}/package.json`]: JSON.stringify({
        dependencies: { vite: "^6.0.0", react: "^19.0.0" },
      }),
    });
    await expect(detectStationProjectPreview(read, CWD)).resolves.toEqual({
      previewable: true,
      reason: "",
    });
  });

  it("falls back to a vite config file when the dep is hoisted away", async () => {
    const read = readerFor({
      [`${CWD}/package.json`]: JSON.stringify({
        dependencies: { react: "^19.0.0" },
      }),
      [`${CWD}/vite.config.ts`]: "export default {}",
    });
    await expect(detectStationProjectPreview(read, CWD)).resolves.toEqual({
      previewable: true,
      reason: "",
    });
  });

  it("reports 'not a Vite project' when neither dep nor config exists", async () => {
    const read = readerFor({
      [`${CWD}/package.json`]: JSON.stringify({
        dependencies: { react: "^19.0.0" },
      }),
    });
    await expect(detectStationProjectPreview(read, CWD)).resolves.toEqual({
      previewable: false,
      reason: "not a Vite project",
    });
  });

  it("reports 'no React dependency' for a vite project without react", async () => {
    const read = readerFor({
      [`${CWD}/package.json`]: JSON.stringify({
        devDependencies: { vite: "^6.0.0" },
      }),
    });
    await expect(detectStationProjectPreview(read, CWD)).resolves.toEqual({
      previewable: false,
      reason: "no React dependency",
    });
  });

  it("reports 'no package.json' when the read fails", async () => {
    const read = readerFor({});
    await expect(detectStationProjectPreview(read, CWD)).resolves.toEqual({
      previewable: false,
      reason: "no package.json",
    });
    // Config-file probes must not run without a package.json.
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reports 'unreadable package.json' on malformed JSON", async () => {
    const read = readerFor({ [`${CWD}/package.json`]: "{not json" });
    await expect(detectStationProjectPreview(read, CWD)).resolves.toEqual({
      previewable: false,
      reason: "unreadable package.json",
    });
  });

  it("never throws when the reader itself rejects", async () => {
    const read = vi.fn(async (): Promise<string | null> => {
      throw new Error("ssh exploded");
    });
    await expect(detectStationProjectPreview(read, CWD)).resolves.toEqual({
      previewable: false,
      reason: "no package.json",
    });
  });

  it("normalises a trailing slash on the project cwd", async () => {
    const read = readerFor({
      [`${CWD}/package.json`]: JSON.stringify({
        dependencies: { vite: "^6.0.0", react: "^19.0.0" },
      }),
    });
    await expect(
      detectStationProjectPreview(read, `${CWD}/`),
    ).resolves.toEqual({ previewable: true, reason: "" });
  });
});

// Task 6 — the file-aware walk-up variant, over the same injected reader.
// Mirrors Task 1's `detectPreviewForFile` cases (main/project-detect.test.ts)
// against a fake path→content map so no fs / IPC is touched.
const ROOT = "/home/strijders/projects/mono";

describe("detectStationPreviewForFile (walk-up)", () => {
  it("finds a Vite+React app in a monorepo subdir", async () => {
    const app = `${ROOT}/apps/dashboard-v2`;
    const read = readerFor({
      [`${app}/package.json`]: JSON.stringify({
        dependencies: { vite: "5", react: "18" },
      }),
    });
    await expect(
      detectStationPreviewForFile(read, ROOT, `${app}/src/App.tsx`),
    ).resolves.toEqual({
      previewable: true,
      appRelPath: "apps/dashboard-v2",
      targetRelPath: "src/App.tsx",
      reason: "ok",
    });
  });

  it("treats a root-level Vite app as appRelPath=''", async () => {
    const read = readerFor({
      [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { react: "18" } }),
      [`${ROOT}/vite.config.ts`]: "export default {}",
    });
    await expect(
      detectStationPreviewForFile(read, ROOT, `${ROOT}/src/App.tsx`),
    ).resolves.toEqual({
      previewable: true,
      appRelPath: "",
      targetRelPath: "src/App.tsx",
      reason: "ok",
    });
  });

  it("reports no-vite-app when nothing up the tree is Vite", async () => {
    const read = readerFor({
      [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { react: "18" } }),
    });
    const info = await detectStationPreviewForFile(
      read,
      ROOT,
      `${ROOT}/src/App.tsx`,
    );
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("no-vite-app");
  });

  it("reports vite-no-react when the nearest Vite app lacks React", async () => {
    const app = `${ROOT}/apps/cli`;
    const read = readerFor({
      [`${app}/package.json`]: JSON.stringify({ dependencies: { vite: "5" } }),
      [`${app}/vite.config.ts`]: "export default {}",
    });
    const info = await detectStationPreviewForFile(
      read,
      ROOT,
      `${app}/src/main.tsx`,
    );
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("vite-no-react");
  });

  it("does not walk above the project root", async () => {
    const proj = `${ROOT}/packages/inner`;
    const read = readerFor({
      // A Vite+React app ABOVE the project root must be ignored.
      [`${ROOT}/package.json`]: JSON.stringify({
        dependencies: { vite: "5", react: "18" },
      }),
      [`${ROOT}/vite.config.ts`]: "export default {}",
      [`${proj}/package.json`]: JSON.stringify({ dependencies: { react: "18" } }),
    });
    const info = await detectStationPreviewForFile(
      read,
      proj,
      `${proj}/src/App.tsx`,
    );
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("no-vite-app");
  });

  it("reports read-error when the file's own dir package.json read throws", async () => {
    const read = vi.fn(async (p: string): Promise<string | null> => {
      if (p === `${ROOT}/src/package.json`) throw new Error("ssh exploded");
      return null;
    });
    const info = await detectStationPreviewForFile(
      read,
      ROOT,
      `${ROOT}/src/App.tsx`,
    );
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("read-error");
  });
});
