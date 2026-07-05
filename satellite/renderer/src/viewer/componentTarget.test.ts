import { describe, it, expect } from "vitest";
import { deriveComponentTarget } from "./componentTarget";

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
