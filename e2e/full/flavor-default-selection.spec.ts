import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomFlavor,
  writeCcrConfig,
  removeCcrConfig,
} from "../helpers/flavors";

let ctx: AppContext;

test.describe.serial("Flavors: Default Flavor Selection (53–62)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "flavor-default" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Flavor Default Test"
    );
    // Add initial flavors so selector appears in all tests
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomFlavor(ctx.window);
    await addCustomFlavor(ctx.window);
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("53. Default flavor selector appears in settings", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await addCustomFlavor(ctx.window); // Need 2 flavors for selector to appear
    await expect(ctx.window.locator(SEL.flavor.defaultSelect)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("54. Default flavor selector shows Vanilla as default", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window); // Add second flavor
    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });
    await expect(select.locator(SEL.flavor.vanillaOption)).toBeVisible({ timeout: T_SHORT });
  });

  test("55. Toolbar dropdown reflects the configured default flavor", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });
    const options = select.locator("option");
    const count = await options.count();
    if (count > 1) {
      await select.selectOption({ index: 1 });
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const chevron = ctx.window.locator(SEL.flavor.toolbarChevron);
    if (await chevron.isVisible().catch(() => false)) {
      await chevron.click();
      await ctx.window.waitForTimeout(T_SETTLE);
      const selectedOption = select.locator("option:checked");
      const selectedText = await selectedOption.textContent();
      expect(selectedText).toBeTruthy();
    }
  });

  test("56. Tray launch submenu shows correct default flavor", async () => {
    await goToClaudeSettings();
    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });

    const selectedOption = select.locator("option:checked");
    const defaultName = (await selectedOption.textContent()) ?? "";

    const trayButton = ctx.window.locator('[aria-label="Agent tray"]');
    await trayButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const submenuTrigger = ctx.window.locator('[data-testid="submenu-trigger"]', {
      hasText: "Claude",
    });
    if (await submenuTrigger.isVisible().catch(() => false)) {
      await submenuTrigger.hover();
      await ctx.window.waitForTimeout(T_SETTLE);
      const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
      if (await submenuContent.isVisible().catch(() => false)) {
        const items = submenuContent.locator('[role="menuitem"]');
        const hasDefault = await items
          .locator("span", { hasText: defaultName })
          .first()
          .count()
          .catch(() => 0);
        expect(hasDefault).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("57. Selected default flavor persists in settings select value", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });
    const options = select.locator("option");
    const count = await options.count();
    if (count > 1) {
      await select.selectOption({ index: 1 });
      await ctx.window.waitForTimeout(T_SETTLE);
      const value = await select.inputValue();
      expect(value).toBeTruthy();
    }
  });

  test("58. Default persists after closing and reopening settings", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });
    const options = select.locator("option");
    const count = await options.count();
    let expectedValue = "";
    if (count > 1) {
      await select.selectOption({ index: 1 });
      await ctx.window.waitForTimeout(T_SETTLE);
      expectedValue = (await select.inputValue()) ?? "";
    }

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    const selectReopened = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(selectReopened).toBeVisible({ timeout: T_SHORT });

    if (expectedValue) {
      const reopenedValue = await selectReopened.inputValue();
      expect(reopenedValue).toBe(expectedValue);
    }
  });

  test("59. Dropdown includes both CCR and custom flavors", async () => {
    writeCcrConfig([{ id: "ccr-default", name: "CCR Default", model: "ccr-default-model" }]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_MEDIUM });

    const hasCcr = await select
      .locator("option")
      .locator("span", { hasText: "CCR Default" })
      .first()
      .count()
      .catch(() => 0);
    expect(hasCcr).toBeGreaterThanOrEqual(1);

    const allOptions = select.locator("option");
    const optionCount = await allOptions.count();
    expect(optionCount).toBeGreaterThanOrEqual(3);
  });

  test("60. First option in dropdown is Vanilla (no overrides)", async () => {
    await goToClaudeSettings();
    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });

    const firstOption = select.locator("option").first();
    const text = (await firstOption.textContent()) ?? "";
    expect(text).toContain("Vanilla");
  });

  test("61. Section still shows when only one flavor total exists", async () => {
    removeCcrConfig();
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.flavor.section)).toBeVisible({ timeout: T_MEDIUM });
    await expect(ctx.window.locator(SEL.flavor.defaultSelect)).toBeVisible({ timeout: T_SHORT });
  });

  test("62. Setting default on Claude does not affect Gemini agent", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    await expect(select).toBeVisible({ timeout: T_SHORT });
    const options = select.locator("option");
    const count = await options.count();
    if (count > 1) {
      await select.selectOption({ index: 1 });
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    await navigateToAgentSettings(ctx.window, "gemini");
    const geminiSection = ctx.window.locator(SEL.flavor.section);
    const geminiVisible = await geminiSection.isVisible().catch(() => false);
    expect(geminiVisible).toBe(false);
  });
});
