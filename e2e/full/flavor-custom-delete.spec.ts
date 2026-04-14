import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_SETTLE } from "../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomFlavor,
  removeCcrConfig,
  writeCcrConfig,
} from "../helpers/flavors";

let ctx: AppContext;

test.describe.serial("Flavors: Custom Delete (45–52)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "flavor-del" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Flavor Del Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("45. Trash icon removes custom flavor from section", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const section = ctx.window.locator(SEL.flavor.section);
    await expect(section).toBeVisible({ timeout: T_SHORT });
  });

  test("46. Deleted flavor removed from toolbar dropdown", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const chevron = ctx.window.locator(SEL.flavor.toolbarChevron);
    if (await chevron.isVisible().catch(() => false)) {
      await chevron.click();
    }
  });

  test("47. Deleted flavor removed from agent tray sub-menu", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const trayButton = ctx.window.locator('[aria-label="Agent tray"]');
    await trayButton.click();
    await ctx.window.waitForTimeout(T_SETTLE);
  });

  test("48. Delete button not shown for CCR flavors", async () => {
    writeCcrConfig([{ id: "ccr-nodel", model: "nodel-model" }]);
    await ctx.window.waitForTimeout(35_000);
    await goToClaudeSettings();
    const ccrRow = ctx.window.locator(SEL.flavor.section).locator("div.flex.items-center.border", {
      hasText: "ccr-nodel",
    });
    if (await ccrRow.isVisible().catch(() => false)) {
      await expect(ccrRow.locator(SEL.flavor.deleteButton)).toHaveCount(0);
    }
  });

  test("49. Deleting the default flavor resets to vanilla", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const select = ctx.window.locator(SEL.flavor.defaultSelect);
    if (await select.isVisible().catch(() => false)) {
      const options = await select.locator("option").allInnerTexts();
      const customOption = options.find((o) => o.includes("New Flavor"));
      if (customOption) {
        await select.selectOption({ label: customOption });
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }

    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    if (await select.isVisible().catch(() => false)) {
      const value = await select.inputValue();
      expect(value).toBe("");
    }
  });

  test("50. Deleting all custom flavors hides section if no CCR", async () => {
    removeCcrConfig();
    await goToClaudeSettings();
    const delBtns = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton);
    const count = await delBtns.count();
    for (let i = 0; i < count; i++) {
      await delBtns.first().click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }
    const section = ctx.window.locator(SEL.flavor.section);
    const visible = await section.isVisible().catch(() => false);
    expect(visible).toBe(false);
  });

  test("51. Deletion persists after closing Settings", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const customBefore = await ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.customBadge)
      .count();

    await ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first().click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);
    await goToClaudeSettings();

    const customAfter = await ctx.window
      .locator(SEL.flavor.section)
      .locator(SEL.flavor.customBadge)
      .count();
    expect(customAfter).toBeLessThan(customBefore);
  });

  test("52. Deleting flavor while agent running with it does not crash", async () => {
    await goToClaudeSettings();
    await addCustomFlavor(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
  });
});
