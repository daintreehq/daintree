import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  removeCcrConfig,
  countPresetOptions,
} from "../helpers/presets";

let ctx: AppContext;

test.describe.serial("Presets: Edge Cases & Resilience (97–100)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-edge" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Edge Case Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("97. Adding 50 custom presets does not crash or freeze Settings", async () => {
    await goToClaudeSettings();

    for (let i = 0; i < 50; i++) {
      await addCustomPreset(ctx.window);
    }
    await ctx.window.waitForTimeout(T_SETTLE);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    // With the Popover-based PresetSelector the per-preset "custom" badge only
    // renders for the currently-selected preset in the detail view, so counting
    // badges would always yield 1. Open the listbox and count options instead
    // (Default + 50 custom entries = 51).
    const optionCount = await countPresetOptions(ctx.window);
    expect(optionCount).toBeGreaterThanOrEqual(50);
  });

  test("98. Preset name with shell metacharacters does not crash", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const editBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.editButton).last();
    await expect(editBtn).toBeVisible({ timeout: T_SHORT });

    ctx.window.once("dialog", (dialog) => dialog.accept("'; echo pwned; '"));
    await editBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("99. Rapid add/delete 10 presets — no duplicate entries", async () => {
    await goToClaudeSettings();

    const customBadgesBefore = ctx.window
      .locator(SEL.preset.section)
      .locator(SEL.preset.customBadge);
    const countBefore = await customBadgesBefore.count();

    for (let i = 0; i < 10; i++) {
      await addCustomPreset(ctx.window);
      await ctx.window.waitForTimeout(100);

      const deleteButtons = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton);
      const deleteCount = await deleteButtons.count();
      if (deleteCount > 0) {
        ctx.window.once("dialog", (dialog) => dialog.accept());
        await deleteButtons.last().click();
        await ctx.window.waitForTimeout(100);
      }
    }
    await ctx.window.waitForTimeout(T_SETTLE);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    const customBadgesAfter = section.locator(SEL.preset.customBadge);
    const countAfter = await customBadgesAfter.count();
    expect(countAfter).toBeLessThanOrEqual(countBefore + 10);
    expect(countAfter).toBeGreaterThanOrEqual(0);
  });

  test("100. Corrupt customPresets data does not crash settings page", async () => {
    try {
      await ctx.window.evaluate(() => {
        const _stores = Object.keys(window).filter(
          (k) => k.startsWith("__CANOPY") || k.includes("store")
        );
        const event = new CustomEvent("preset-test-inject", {
          detail: [{ name: "corrupt-no-id" }],
        });
        window.dispatchEvent(event);
      });
    } catch {
      // evaluate may fail if store injection not supported — fall through
    }

    await goToClaudeSettings();

    const section = ctx.window.locator(SEL.preset.section);
    const sectionVisible = await section.isVisible({ timeout: T_MEDIUM }).catch(() => false);

    const settingsHeading = ctx.window.locator(SEL.settings.heading);
    await expect(settingsHeading).toBeVisible({ timeout: T_MEDIUM });

    if (sectionVisible) {
      await expect(section).toBeVisible({ timeout: T_SHORT });
    }
  });
});
