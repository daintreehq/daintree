import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "./launch";

let ctx: AppContext;

test.beforeAll(async () => {
  ctx = await launchApp();
});

test.afterAll(async () => {
  await ctx.app.close();
});

test("sidebar toggle hides and restores sidebar", async () => {
  const { window } = ctx;

  const toggleBtn = window.locator('[aria-label="Toggle Sidebar"]');
  await expect(toggleBtn).toBeVisible();

  const sidebar = window.locator('[aria-label="Resize sidebar"]');

  // Sidebar should be visible initially (aria-pressed="true" means sidebar is showing)
  await expect(sidebar).toBeVisible({ timeout: 5_000 });

  // Toggle off — sidebar should hide
  await toggleBtn.click();
  await expect(sidebar).not.toBeVisible({ timeout: 3_000 });

  // Toggle back on — sidebar should reappear
  await toggleBtn.click();
  await expect(sidebar).toBeVisible({ timeout: 3_000 });
});

test("toolbar renders key buttons", async () => {
  const { window } = ctx;

  // These toolbar buttons should always be visible
  const buttons = ["Toggle Sidebar", "Open Terminal", "Open settings"];

  for (const label of buttons) {
    await expect(window.locator(`[aria-label="${label}"]`)).toBeVisible({ timeout: 5_000 });
  }
});

test("problems button shows error count", async () => {
  const { window } = ctx;

  // The problems button aria-label follows the pattern "Problems: N error(s)"
  const problemsBtn = window.locator('[aria-label^="Problems:"]');
  await expect(problemsBtn).toBeVisible({ timeout: 5_000 });

  const label = await problemsBtn.getAttribute("aria-label");
  expect(label).toMatch(/Problems: \d+ errors?/);
});
