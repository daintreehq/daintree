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
  getSelectedFlavorLabel,
  getFlavorOptionLabels,
  getFlavorRowByName,
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
    const trigger = ctx.window.locator(SEL.flavor.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const labels = await getFlavorOptionLabels(ctx.window);
      const customLabel = labels.find((o) => o.includes("New Flavor"));
      if (customLabel) {
        await getFlavorRowByName(ctx.window, customLabel);
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }
  };

  const deleteFirstCustomFlavor = async () => {
    // The delete button only renders for the currently-selected custom flavor's
    // detail view. Wait for it to be visible before clicking so timing races
    // fail fast instead of stuck on a silent 30s timeout.
    const delBtn = ctx.window.locator(SEL.flavor.section).locator(SEL.flavor.deleteButton).first();
    await expect(delBtn).toBeVisible({ timeout: T_SHORT });
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

    // The Popover trigger falls back to the Vanilla label when the selected
    // flavor is deleted — no inputValue to read on a <button>.
    const trigger = ctx.window.locator(SEL.flavor.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const label = await getSelectedFlavorLabel(ctx.window);
      expect(label).toContain("Vanilla");
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
    const trigger = ctx.window.locator(SEL.flavor.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const label = await getSelectedFlavorLabel(ctx.window);
      expect(label).toContain("Vanilla");
    }
  });

  test("75. Removing CCR config with CCR default flavor defaults to vanilla", async () => {
    writeCcrConfig([{ id: "ccr-stale", name: "CCR Stale", model: "stale-model" }]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    const trigger = ctx.window.locator(SEL.flavor.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const labels = await getFlavorOptionLabels(ctx.window);
      const ccrLabel = labels.find((o) => o.includes("CCR Stale"));
      if (ccrLabel) {
        await getFlavorRowByName(ctx.window, ccrLabel);
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }

    removeCcrConfig();
    await ctx.window.waitForTimeout(30_000);

    await goToClaudeSettings();
    if (await trigger.isVisible().catch(() => false)) {
      const label = await getSelectedFlavorLabel(ctx.window);
      expect(label).toContain("Vanilla");
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

    const trigger = ctx.window.locator(SEL.flavor.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const label = await getSelectedFlavorLabel(ctx.window);
      expect(label).toContain("Vanilla");
    }
  });
});
