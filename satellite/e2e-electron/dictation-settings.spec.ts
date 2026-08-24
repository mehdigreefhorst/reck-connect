import { test, expect } from "@playwright/test";
import { launchApp, LaunchedApp } from "./harness";

// The Engine picker in Settings → Voice dictation must offer all four
// transcription engines — the two in-satellite ones and the two
// daemon-backed ones — and explain a daemon engine's availability in the
// hint line. With a fresh profile (no daemon configured, per-host registry
// not initialised) the honest hint is "availability unknown", not silence
// and not a crash.

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchApp();
  await expect(launched.window.locator(".settings-card, .app-shell")).toBeVisible({
    timeout: 15_000,
  });
});

test.afterAll(async () => {
  await launched?.close();
});

test("engine dropdown offers all four engines", async () => {
  const options = launched.window.locator("#s-stt-provider option");
  await expect(options).toHaveCount(4);
  const values = await options.evaluateAll((els) =>
    els.map((el) => (el as HTMLOptionElement).value),
  );
  expect(values).toEqual(["local", "deepgram", "claude", "codex"]);
});

test("choosing a daemon engine surfaces an availability hint", async () => {
  const select = launched.window.locator("#s-stt-provider");
  const hint = launched.window.locator("#s-stt-daemon-hint");

  await expect(hint).toBeHidden();
  await select.selectOption("claude");
  await expect(hint).toBeVisible();
  // Fresh profile → no daemon reachable → the hint must say the truth
  // (unknown availability), never sit empty.
  await expect(hint).not.toHaveText("");

  await select.selectOption("local");
  await expect(hint).toBeHidden();
  // The on-device model picker comes back when returning to local.
  await expect(launched.window.locator("#s-stt-local-fields")).toBeVisible();
});
