import { describe, it, expect } from "vitest";
import {
  deriveComponentTarget,
  deriveStationComponentTarget,
} from "./componentTarget";

describe("deriveComponentTarget", () => {
  it("splits a mount-relative component path into slug + root + rel", () => {
    expect(
      deriveComponentTarget(
        "/Users/x/reck/projects/app/src/Button.tsx",
        "/Users/x/reck/projects",
      ),
    ).toEqual({
      slug: "app",
      projectRootMac: "/Users/x/reck/projects/app",
      targetRelPath: "src/Button.tsx",
    });
  });

  it("normalises a trailing slash on the mount point", () => {
    expect(
      deriveComponentTarget(
        "/Users/x/reck/projects/app/src/Button.tsx",
        "/Users/x/reck/projects/",
      ),
    ).toEqual({
      slug: "app",
      projectRootMac: "/Users/x/reck/projects/app",
      targetRelPath: "src/Button.tsx",
    });
  });

  it("handles a component directly at the project root", () => {
    expect(
      deriveComponentTarget(
        "/Users/x/reck/projects/app/App.tsx",
        "/Users/x/reck/projects",
      ),
    ).toEqual({
      slug: "app",
      projectRootMac: "/Users/x/reck/projects/app",
      targetRelPath: "App.tsx",
    });
  });

  it("returns null when the path is not under the mount", () => {
    expect(
      deriveComponentTarget(
        "/somewhere/else/app/src/Button.tsx",
        "/Users/x/reck/projects",
      ),
    ).toBeNull();
  });

  it("returns null for a bare project root with no sub-path", () => {
    expect(
      deriveComponentTarget(
        "/Users/x/reck/projects/app",
        "/Users/x/reck/projects",
      ),
    ).toBeNull();
  });

  it("returns null when the resolved path equals the mount point", () => {
    expect(
      deriveComponentTarget(
        "/Users/x/reck/projects",
        "/Users/x/reck/projects",
      ),
    ).toBeNull();
  });
});

// Station-remote variant — no Mac mount involved: the project root is the
// pane's station-side cwd and the file path is the station-side absolute
// path.
describe("deriveStationComponentTarget", () => {
  it("derives the project-root-relative path for a root-level component", () => {
    expect(
      deriveStationComponentTarget(
        "/home/strijders/projects/commitify/Testimonials.tsx",
        "/home/strijders/projects/commitify",
      ),
    ).toEqual({ targetRelPath: "Testimonials.tsx" });
  });

  it("derives a nested relative path", () => {
    expect(
      deriveStationComponentTarget(
        "/home/strijders/projects/commitify/src/components/Pricing.tsx",
        "/home/strijders/projects/commitify",
      ),
    ).toEqual({ targetRelPath: "src/components/Pricing.tsx" });
  });

  it("normalises a trailing slash on the project cwd", () => {
    expect(
      deriveStationComponentTarget(
        "/home/strijders/projects/commitify/App.tsx",
        "/home/strijders/projects/commitify/",
      ),
    ).toEqual({ targetRelPath: "App.tsx" });
  });

  it("returns null when the file is outside the project cwd", () => {
    expect(
      deriveStationComponentTarget(
        "/home/strijders/other/App.tsx",
        "/home/strijders/projects/commitify",
      ),
    ).toBeNull();
  });

  it("does not treat a sibling dir sharing the cwd prefix as inside", () => {
    expect(
      deriveStationComponentTarget(
        "/home/strijders/projects/commitify-fork/App.tsx",
        "/home/strijders/projects/commitify",
      ),
    ).toBeNull();
  });

  it("returns null when the path equals the project cwd", () => {
    expect(
      deriveStationComponentTarget(
        "/home/strijders/projects/commitify",
        "/home/strijders/projects/commitify",
      ),
    ).toBeNull();
  });

  it("returns null for an empty or root-only project cwd", () => {
    expect(
      deriveStationComponentTarget("/home/x/App.tsx", ""),
    ).toBeNull();
    expect(
      deriveStationComponentTarget("/home/x/App.tsx", "/"),
    ).toBeNull();
  });
});
