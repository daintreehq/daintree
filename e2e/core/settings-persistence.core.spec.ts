import { test, expect } from "@playwright/test";
import { launchApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM } from "../helpers/timeouts";

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
    await expect(heading).toBeVisible({ timeout: T_MEDIUM });
  });

  test("General tab: toggle Project Pulse off", async () => {
    const { window } = ctx;

    const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
    await generalTab.click();

    const toggle = window.locator(SEL.settings.projectPulseToggle);
    await expect(toggle).toBeVisible({ timeout: T_MEDIUM });

    await expect(toggle).toHaveAttribute("aria-checked", "true");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  test("Terminal tab: toggle Performance Mode on", async () => {
    const { window } = ctx;

    const terminalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("Terminal")`);
    await terminalTab.click();

    const toggle = window.locator(SEL.settings.performanceModeToggle);
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeVisible({ timeout: T_MEDIUM });

    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("Appearance tab: change font family", async () => {
    const { window } = ctx;

    const appearanceTab = window.locator(
      `${SEL.settings.navSidebar} button:has-text("Appearance")`
    );
    await appearanceTab.click();

    const fontSelect = window.locator(SEL.settings.fontFamilySelect);
    await expect(fontSelect).toBeVisible({ timeout: T_MEDIUM });

    await expect(fontSelect).toHaveValue("jetbrains");

    await fontSelect.selectOption("system");
    await expect(fontSelect).toHaveValue("system");
  });

  test("close and reopen settings — changes persist", async () => {
    const { window } = ctx;

    await window.keyboard.press("Escape");
    const heading = window.locator(SEL.settings.heading);
    await expect(heading).not.toBeVisible({ timeout: T_SHORT });

    await window.locator(SEL.toolbar.openSettings).click();
    await expect(heading).toBeVisible({ timeout: T_MEDIUM });

    const generalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("General")`);
    await generalTab.click();
    const pulseToggle = window.locator(SEL.settings.projectPulseToggle);
    await expect(pulseToggle).toHaveAttribute("aria-checked", "false");

    const terminalTab = window.locator(`${SEL.settings.navSidebar} button:has-text("Terminal")`);
    await terminalTab.click();
    const perfToggle = window.locator(SEL.settings.performanceModeToggle);
    await perfToggle.scrollIntoViewIfNeeded();
    await expect(perfToggle).toHaveAttribute("aria-checked", "true");

    const appearanceTab = window.locator(
      `${SEL.settings.navSidebar} button:has-text("Appearance")`
    );
    await appearanceTab.click();
    const fontSelect = window.locator(SEL.settings.fontFamilySelect);
    await expect(fontSelect).toHaveValue("system");

    await window.keyboard.press("Escape");
  });
});
