import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "./launch";

let ctx: AppContext;

test.beforeAll(async () => {
  ctx = await launchApp();
});

test.afterAll(async () => {
  await ctx.app.close();
});

test("app launches and shows core UI", async () => {
  const { app, window } = ctx;

  const title = await window.title();
  expect(title).toContain("Canopy");

  const layout = window.locator("div.h-screen.flex.flex-col");
  await expect(layout).toBeVisible({ timeout: 15_000 });

  const settingsBtn = window.locator('[aria-label="Open settings"]');
  await expect(settingsBtn).toBeVisible({ timeout: 10_000 });

  const version = await app.evaluate(({ app: a }) => a.getVersion());
  expect(typeof version).toBe("string");
  expect(version.length).toBeGreaterThan(0);

  await window.screenshot({ path: "test-results/smoke.png" });
});
