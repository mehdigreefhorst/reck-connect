import { test, expect, type Page } from "@playwright/test";

// Browser-level tests of the usage overlay against the synthetic-API
// harness (renderer/usage-harness.html — no daemon needed). Covers the
// two field reports from v1: the card growing on hover, and the fixed
// bin widths. Screenshots land in e2e/artifacts/ for visual review.

const HARNESS = "http://localhost:5173/usage-harness.html";

async function openHarness(page: Page, theme: "light" | "dark" = "light") {
  await page.goto(`${HARNESS}?theme=${theme}`);
  await expect(page.locator(".usage-card")).toBeVisible();
  // First fetch resolves and draws.
  await expect(page.locator(".usage-chart canvas")).toBeVisible();
}

test("hovering the chart never resizes the card", async ({ page }) => {
  await openHarness(page);
  const card = page.locator(".usage-card");
  const before = await card.boundingBox();
  expect(before).not.toBeNull();

  // Sweep the cursor across the plot area; the readout populates but
  // the card must not change size (v1 bug: live legend + unreserved
  // readout line grew the layout on every mousemove).
  const chart = page.locator(".usage-chart .u-over");
  const box = (await chart.boundingBox())!;
  for (let i = 0; i <= 10; i++) {
    await page.mouse.move(box.x + 2 + ((box.width - 4) * i) / 10, box.y + box.height / 2);
  }
  // Park mid-chart: the readout stays populated (sweeping fully off the
  // right edge would legitimately clear it).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".usage-readout")).not.toHaveText("");

  const after = await card.boundingBox();
  expect(after!.width).toBeCloseTo(before!.width, 0);
  expect(after!.height).toBeCloseTo(before!.height, 0);
});

test("bin selector offers per-view widths and re-renders", async ({ page }) => {
  await openHarness(page);

  // Week view default: 1-day bins.
  await expect(page.locator(".usage-bins")).toHaveValue("1d");
  const weekOptions = await page.locator(".usage-bins option").allTextContents();
  expect(weekOptions).toEqual(["5 min", "10 min", "30 min", "1 hour", "4 hours", "1 day"]);

  // Fine bins → curve (uPlot still draws one canvas; assert data volume
  // via the readout after hover, and take a screenshot for the eye).
  await page.locator(".usage-bins").selectOption("30m");
  await expect(page.locator(".usage-bins")).toHaveValue("30m");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-week-30m-curve.png" });

  // Day view: defaults to 1 hour, offers down to 1 minute.
  await page.locator('.usage-chip[data-g="day"]').click();
  await expect(page.locator(".usage-bins")).toHaveValue("1h");
  const dayOptions = await page.locator(".usage-bins option").allTextContents();
  expect(dayOptions).toEqual(["1 min", "2 min", "5 min", "10 min", "30 min", "1 hour", "4 hours"]);
  await page.locator(".usage-bins").selectOption("1m");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-day-1m-curve.png" });

  // Year view: day bins or calendar months.
  await page.locator('.usage-chip[data-g="year"]').click();
  await expect(page.locator(".usage-bins")).toHaveValue("month");
  const yearOptions = await page.locator(".usage-bins option").allTextContents();
  expect(yearOptions).toEqual(["1 day", "Month"]);
});

test("drill-down resets the bin width to the finer view's default", async ({ page }) => {
  await openHarness(page);
  await page.locator('.usage-chip[data-g="year"]').click();
  await expect(page.locator(".usage-bins")).toHaveValue("month");

  // Click mid-chart → month view at 1-day bins.
  const chart = page.locator(".usage-chart .u-over");
  const box = (await chart.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await expect(page.locator('.usage-chip[data-g="month"]')).toHaveClass(/active/);
  await expect(page.locator(".usage-bins")).toHaveValue("1d");

  // ↑ drills back up (month → year on the ladder) with year's default.
  await page.locator(".usage-drill-up").click();
  await expect(page.locator('.usage-chip[data-g="year"]')).toHaveClass(/active/);
  await expect(page.locator(".usage-bins")).toHaveValue("month");
  // At the ceiling the ↑ button disables.
  await expect(page.locator(".usage-drill-up")).toBeDisabled();
});

test("dark theme renders and looks right", async ({ page }) => {
  await openHarness(page, "dark");
  await page.locator(".usage-bins").selectOption("1h");
  await page.waitForTimeout(150);
  await page.screenshot({ path: "e2e/artifacts/usage-week-1h-dark.png" });
  await expect(page.locator(".usage-chart canvas")).toBeVisible();
});
