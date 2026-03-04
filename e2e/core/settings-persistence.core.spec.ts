import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";

let ctx: AppContext;

test.describe.serial("Settings Persistence", () => {
  test.beforeAll(async () => {
    const fixtureDir = createFixtureRepo({ name: "settings-test" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Settings Test");
  });

  test.afterAll(async () => {
    await ctx?.app.close();
  });

  test("open settings dialog", async () => {
    const { window } = ctx;

    await window.locator(SEL.toolbar.openSettings).click();
    const heading = window.locator(SEL.settings.heading);
    await expect(heading).toBeVisible({ timeout: 5_000 });
  });

  test("General tab: toggle Project Pulse off", async () => {
    const { window } = ctx;

    // Navigate to General tab (should be default)
    const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
    await generalTab.click();

    const toggle = window.locator(SEL.settings.projectPulseToggle);
    await expect(toggle).toBeVisible({ timeout: 5_000 });

    // Should be on by default
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    // Toggle it off
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("Terminal tab: toggle Performance Mode on", async () => {
    const { window } = ctx;

    // Navigate to Terminal tab
    const terminalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("Terminal")`);
    await terminalTab.click();

    const toggle = window.locator(SEL.settings.performanceModeToggle);
    // Toggle may be below the fold — scroll it into view
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeVisible({ timeout: 5_000 });

    // Should be off by default
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    // Toggle it on
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("Appearance tab: change font family", async () => {
    const { window } = ctx;

    // Navigate to Appearance tab
    const appearanceTab = window.locator(
      `${SEL.settings.navSidebar} button:has-text("Appearance")`
    );
    await appearanceTab.click();

    const fontSelect = window.locator(SEL.settings.fontFamilySelect);
    await expect(fontSelect).toBeVisible({ timeout: 5_000 });

    // Default should be jetbrains
    await expect(fontSelect).toHaveValue("jetbrains");

    // Change to system
    await fontSelect.selectOption("system");
    await expect(fontSelect).toHaveValue("system");
  });

  test("close and reopen settings — changes persist", async () => {
    const { window } = ctx;

    // Close settings
    await window.keyboard.press("Escape");
    const heading = window.locator(SEL.settings.heading);
    await expect(heading).not.toBeVisible({ timeout: 3_000 });

    // Reopen settings
    await window.locator(SEL.toolbar.openSettings).click();
    await expect(heading).toBeVisible({ timeout: 5_000 });

    // Verify General tab: Project Pulse should still be off
    const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
    await generalTab.click();
    const pulseToggle = window.locator(SEL.settings.projectPulseToggle);
    await expect(pulseToggle).toHaveAttribute("aria-checked", "false");

    // Verify Terminal tab: Performance Mode should still be on
    const terminalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("Terminal")`);
    await terminalTab.click();
    const perfToggle = window.locator(SEL.settings.performanceModeToggle);
    await perfToggle.scrollIntoViewIfNeeded();
    await expect(perfToggle).toHaveAttribute("aria-checked", "true");

    // Verify Appearance tab: font should still be system
    const appearanceTab = window.locator(
      `${SEL.settings.navSidebar} button:has-text("Appearance")`
    );
    await appearanceTab.click();
    const fontSelect = window.locator(SEL.settings.fontFamilySelect);
    await expect(fontSelect).toHaveValue("system");

    // Close settings
    await window.keyboard.press("Escape");
  });
});
