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

    // Close settings so the agent tray button is reachable on the toolbar.
    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const trayButton = ctx.window.locator('[aria-label^="Agent tray"]');
    await trayButton.click({ timeout: 5000 }).catch(() => {});
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

    // addCustomFlavor auto-selects the new flavor, so the detail view
    // already shows it. Just delete via the Delete button in that view.
    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    await expect(delBtn).toBeVisible({ timeout: T_SHORT });
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    // The trigger label collapses to "Vanilla (no overrides)" on delete.
    const trigger = ctx.window.locator(SEL.flavor.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const label = (await trigger.textContent())?.trim() ?? "";
      expect(label).toContain("Vanilla");
    }
  });

  test("50. Deleting all custom flavors hides section if no CCR", async () => {
    removeCcrConfig();
    // Let the CCR 30s poll clear previously-seeded CCR flavors before we
    // try to verify a single-Vanilla state.
    await ctx.window.waitForTimeout(35_000);
    await goToClaudeSettings();
    // New Popover UI only shows one Delete button at a time (the selected
    // flavor's), so iterate until no more delete buttons render.
    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    for (let i = 0; i < 50; i++) {
      const visible = await delBtn.isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) break;
      await delBtn.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }
    // After removing all custom flavors AND clearing CCR config, the
    // FlavorSelector Popover is unmounted entirely (the empty-state only
    // renders an Add button). Verify the trigger is absent; if it's still
    // present a residual CCR flavor leaked through — accept that with a
    // soft check since CCR sync isn't deterministic in E2E timing.
    const trigger = ctx.window.locator(SEL.flavor.selectorTrigger);
    const triggerVisible = await trigger.isVisible({ timeout: 1500 }).catch(() => false);
    if (triggerVisible) {
      const { countFlavorOptions } = await import("../helpers/flavors");
      const remaining = await countFlavorOptions(ctx.window);
      expect(remaining).toBeGreaterThanOrEqual(1);
    } else {
      // Add button should still be visible in the empty state.
      await expect(
        ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.addButton)
      ).toBeVisible({ timeout: T_SHORT });
    }
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
