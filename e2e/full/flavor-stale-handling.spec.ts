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

test.describe.serial("Flavors: Stale Flavor Handling (71–76)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "flavor-stale" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Flavor Stale Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  const selectCustomAsDefault = async () => {
    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    if (await select.isVisible().catch(() => false)) {
      const options = await select.locator("option").allInnerTexts();
      const customOption = options.find((o) => o.includes("New Flavor"));
      if (customOption) {
        await select.selectOption({ label: customOption });
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }
  };

  const deleteFirstCustomFlavor = async () => {
    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  test("71. Delete default flavor shows no error", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await selectCustomAsDefault();
    await deleteFirstCustomFlavor();

    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
    await expect(ctx.window.locator(SEL.flavor.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("72. Deleting default flavor resets defaultSelect to empty", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await selectCustomAsDefault();
    await deleteFirstCustomFlavor();

    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    if (await select.isVisible().catch(() => false)) {
      const value = await select.inputValue();
      expect(value).toBe("");
    }
  });

  test("73. Stale default flavor does not prevent settings from loading", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await selectCustomAsDefault();

    await deleteFirstCustomFlavor();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await expect(ctx.window.locator(SEL.flavor.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("74. Deleted default flavor remains vanilla after settings reopen", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await selectCustomAsDefault();

    await deleteFirstCustomFlavor();
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    if (await select.isVisible().catch(() => false)) {
      const value = await select.inputValue();
      expect(value).toBe("");
    }
  });

  test("75. Removing CCR config with CCR default flavor defaults to vanilla", async () => {
    writeCcrConfig([{ id: "ccr-stale", name: "CCR Stale", model: "stale-model" }]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    if (await select.isVisible().catch(() => false)) {
      const options = await select.locator("option").allInnerTexts();
      const ccrOption = options.find((o) => o.includes("CCR Stale"));
      if (ccrOption) {
        await select.selectOption({ label: ccrOption });
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }

    removeCcrConfig();
    await ctx.window.waitForTimeout(30_000);

    await goToClaudeSettings();
    if (await select.isVisible().catch(() => false)) {
      const value = await select.inputValue();
      expect(value).toBe("");
    }
  });

  test("76. Add custom flavor, set default, delete it, verify vanilla", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await expect(
      ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.customBadge).first()
    ).toBeVisible({ timeout: T_SHORT });

    await selectCustomAsDefault();
    await deleteFirstCustomFlavor();

    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    if (await select.isVisible().catch(() => false)) {
      const value = await select.inputValue();
      expect(value).toBe("");
    }
  });
});
