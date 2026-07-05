import { describe, it, expect, vi } from "vitest";
import { detectStationProjectPreview } from "./stationPreviewDetect";

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
