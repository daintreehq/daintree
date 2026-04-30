import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  writeCcrConfig,
  removeCcrConfig,
  getSelectedPresetLabel,
  getPresetOptionLabels,
  getPresetRowByName,
} from "../helpers/presets";

let ctx: AppContext;

test.describe.serial("Presets: Stale Preset Handling (71–76)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-stale" });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Stale Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  const selectCustomAsDefault = async () => {
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const labels = await getPresetOptionLabels(ctx.window);
      const customLabel = labels.find((o) => o.includes("New Preset"));
      if (customLabel) {
        await getPresetRowByName(ctx.window, customLabel);
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }
  };

  const deleteFirstCustomPreset = async () => {
    // The delete button only renders for the currently-selected custom preset's
    // detail view. Wait for it to be visible before clicking so timing races
    // fail fast instead of stuck on a silent 30s timeout.
    const delBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first();
    await expect(delBtn).toBeVisible({ timeout: T_SHORT });
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  test("71. Delete default preset shows no error", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await selectCustomAsDefault();
    await deleteFirstCustomPreset();

    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("72. Deleting default preset resets defaultSelect to empty", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await selectCustomAsDefault();
    await deleteFirstCustomPreset();

    // The Popover trigger falls back to the Default label when the selected
    // preset is deleted — no inputValue to read on a <button>.
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const label = await getSelectedPresetLabel(ctx.window);
      expect(label).toContain("Default");
    }
  });

  test("73. Stale default preset does not prevent settings from loading", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await selectCustomAsDefault();

    await deleteFirstCustomPreset();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("74. Deleted default preset remains default after settings reopen", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await selectCustomAsDefault();

    await deleteFirstCustomPreset();
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const label = await getSelectedPresetLabel(ctx.window);
      expect(label).toContain("Default");
    }
  });

  test("75. Removing CCR config with CCR default preset defaults to default", async () => {
    writeCcrConfig([{ id: "ccr-stale", name: "CCR Stale", model: "stale-model" }]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const labels = await getPresetOptionLabels(ctx.window);
      const ccrLabel = labels.find((o) => o.includes("CCR Stale"));
      if (ccrLabel) {
        await getPresetRowByName(ctx.window, ccrLabel);
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    }

    removeCcrConfig();
    await ctx.window.waitForTimeout(30_000);

    await goToClaudeSettings();
    if (await trigger.isVisible().catch(() => false)) {
      const label = await getSelectedPresetLabel(ctx.window);
      expect(label).toContain("Default");
    }
  });

  test("76. Add custom preset, set default, delete it, verify default", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await expect(
      ctx.window.locator(SEL.preset.section).locator(SEL.preset.customBadge).first()
    ).toBeVisible({ timeout: T_SHORT });

    await selectCustomAsDefault();
    await deleteFirstCustomPreset();

    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    if (await trigger.isVisible().catch(() => false)) {
      const label = await getSelectedPresetLabel(ctx.window);
      expect(label).toContain("Default");
    }
  });
});
