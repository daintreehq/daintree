import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "./launch";

let ctx: AppContext;

test.beforeAll(async () => {
  ctx = await launchApp();
});

test.afterAll(async () => {
  await ctx.app.close();
});

test("settings dialog opens and closes", async () => {
  const { window } = ctx;

  await window.locator('[aria-label="Open settings"]').click();

  // Dialog appears with the "Settings" heading
  const heading = window.locator("h2", { hasText: "Settings" });
  await expect(heading).toBeVisible({ timeout: 5_000 });

  // Default tab is General
  const tabTitle = window.locator("h3", { hasText: "General" });
  await expect(tabTitle).toBeVisible();

  // Close via the X button
  await window.locator('[aria-label="Close settings"]').click();
  await expect(heading).not.toBeVisible({ timeout: 3_000 });
});

test("settings tab navigation works", async () => {
  const { window } = ctx;

  await window.locator('[aria-label="Open settings"]').click();
  await window.locator("h2", { hasText: "Settings" }).waitFor({ state: "visible", timeout: 5_000 });

  const tabs = [
    { nav: "Keyboard", title: "Keyboard Shortcuts" },
    { nav: "Terminal", title: "Panel Grid" },
    { nav: "Appearance", title: "Appearance" },
    { nav: "CLI Agents", title: "CLI Agents" },
    { nav: "GitHub", title: "GitHub Integration" },
    { nav: "Troubleshooting", title: "Troubleshooting" },
  ];

  for (const { nav, title } of tabs) {
    // Click the nav button in the sidebar
    await window.locator(".w-48 button", { hasText: nav }).click();
    // Verify the content header updates
    const tabTitle = window.locator("h3", { hasText: title });
    await expect(tabTitle).toBeVisible({ timeout: 2_000 });
  }

  // Close with Escape
  await window.keyboard.press("Escape");
  await expect(window.locator("h2", { hasText: "Settings" })).not.toBeVisible({ timeout: 3_000 });
});
