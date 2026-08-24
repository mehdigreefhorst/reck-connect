import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./harness";

// Regression guard for the lost-events bug.
//
// `file:openInViewer` creates the picker window and starts the search in
// the same tick. With the ripgrep backend a small tree finishes in tens of
// milliseconds — long before the popup's bundle has parsed and subscribed
// — so every match and the `done` event were emitted into the void and the
// picker sat on "Searching project tree…" for a search that had already
// found the file.
//
// This asserts the OUTCOME (the match is listed / opened), not the
// transport, so it stays honest whichever way the race falls on CI.

test("picker shows results even when the search finishes before it subscribes", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });

    // Two matches, so the single-match auto-open path doesn't fire and we
    // can actually see the rendered list.
    const proj = path.join(ctx.homeDir, "proj");
    for (const d of ["src/deep", "lib/other"]) {
      fs.mkdirSync(path.join(proj, d), { recursive: true });
      fs.writeFileSync(path.join(proj, d, "target.ts"), "export const x = 1;");
    }

    const popupPromise = ctx.app.waitForEvent("window");
    // Mirrors boot.ts: resolveActivatePath has already anchored the bare
    // click text to the project cwd; originalText is what was clicked.
    const res = await ctx.window.evaluate(
      async ({ resolved, orig, cwd }) =>
        await (
          window as unknown as {
            reckAPI: {
              files: { openInViewer(t: string, o: unknown): Promise<unknown> };
            };
          }
        ).reckAPI.files.openInViewer(resolved, {
          originalText: orig,
          projectCwd: cwd,
        }),
      { resolved: path.join(proj, "target.ts"), orig: "target.ts", cwd: proj },
    );
    expect(res).toMatchObject({ ok: true });

    const popup = await popupPromise;
    await popup.waitForLoadState("domcontentloaded");

    // The failure mode was an indefinite "Searching project tree…".
    await expect(popup.locator("body")).toContainText("found 2 matches", {
      timeout: 15_000,
    });
    await expect(popup.locator("body")).not.toContainText(
      "Searching project tree",
    );
    for (const d of ["src/deep", "lib/other"]) {
      await expect(popup.locator("body")).toContainText(d);
    }
  } finally {
    await ctx.close();
  }
});

test("a single match still auto-opens the file", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
    const proj = path.join(ctx.homeDir, "proj");
    fs.mkdirSync(path.join(proj, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "deep", "solo.ts"), "const y = 2;");

    await ctx.window.evaluate(
      async ({ resolved, orig, cwd }) =>
        await (
          window as unknown as {
            reckAPI: {
              files: { openInViewer(t: string, o: unknown): Promise<unknown> };
            };
          }
        ).reckAPI.files.openInViewer(resolved, {
          originalText: orig,
          projectCwd: cwd,
        }),
      { resolved: path.join(proj, "solo.ts"), orig: "solo.ts", cwd: proj },
    );

    // The picker replaces itself with the real file viewer on one match.
    await expect
      .poll(
        async () => {
          for (const w of ctx.app.windows()) {
            // The picker closes itself as it hands off, so a window can
            // vanish between enumeration and this call.
            const title = await w.title().catch(() => "");
            if (title.includes("solo.ts")) return true;
          }
          return false;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
  } finally {
    await ctx.close();
  }
});
