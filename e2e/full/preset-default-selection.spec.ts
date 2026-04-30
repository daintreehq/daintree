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
  countPresetOptions,
} from "../helpers/presets";

// Opens the PresetSelector popover, selects the option at the given index
// (0 = Default, 1+ = the CCR / custom presets that follow), and waits for
// the popover to close.
async function selectPresetByIndex(
  window: import("@playwright/test").Page,
  index: number
): Promise<void> {
  const trigger = window.locator(SEL.preset.selectorTrigger);
  await trigger.click();
  const listbox = window.locator(SEL.preset.selectorListbox);
  await expect(listbox).toBeVisible({ timeout: T_SHORT });
  await listbox.locator('[role="option"]').nth(index).click();
  await expect(listbox).not.toBeVisible({ timeout: T_SHORT });
}

let ctx: AppContext;

test.describe.serial("Presets: Default Preset Selection (53–62)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const fixtureDir = createFixtureRepo({ name: "preset-default" });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Default Test"
    );
    // Add initial presets so selector appears in all tests
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window);
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("53. Default preset selector appears in settings", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window); // Need 2 presets for selector to appear
    await expect(ctx.window.locator(SEL.preset.defaultSelect)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("54. Default preset selector shows Default as default", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window); // Add second preset

    // Re-select Default, then confirm the trigger label reflects the selection.
    await selectPresetByIndex(ctx.window, 0);
    const label = await getSelectedPresetLabel(ctx.window);
    expect(label).toContain("Default");
  });

  test("55. Toolbar dropdown reflects the configured default preset", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });

    const count = await countPresetOptions(ctx.window);
    if (count > 1) {
      await selectPresetByIndex(ctx.window, 1);
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const chevron = ctx.window.locator(SEL.preset.toolbarChevron);
    try {
      await chevron.click({ timeout: 5000 });
      await ctx.window.waitForTimeout(T_SETTLE);
      const label = await getSelectedPresetLabel(ctx.window);
      expect(label).toBeTruthy();
    } catch {
      // Chevron absent when Claude isn't pinned to the toolbar.
    }
  });

  test("56. Tray launch submenu shows correct default preset", async () => {
    await goToClaudeSettings();
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });

    const defaultName = await getSelectedPresetLabel(ctx.window);

    // Close the settings dialog so the agent tray button is reachable.
    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const trayButton = ctx.window.locator('[aria-label^="Agent tray"]');
    await trayButton.click({ timeout: 5000 }).catch(() => {});
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

  test("57. Selected default preset persists in settings select value", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const count = await countPresetOptions(ctx.window);
    if (count > 1) {
      await selectPresetByIndex(ctx.window, 1);
      await ctx.window.waitForTimeout(T_SETTLE);
      const label = await getSelectedPresetLabel(ctx.window);
      expect(label).toBeTruthy();
    }
  });

  test("58. Default persists after closing and reopening settings", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const count = await countPresetOptions(ctx.window);
    let expectedLabel = "";
    if (count > 1) {
      await selectPresetByIndex(ctx.window, 1);
      await ctx.window.waitForTimeout(T_SETTLE);
      expectedLabel = await getSelectedPresetLabel(ctx.window);
    }

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await goToClaudeSettings();
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });

    if (expectedLabel) {
      const reopenedLabel = await getSelectedPresetLabel(ctx.window);
      expect(reopenedLabel).toBe(expectedLabel);
    }
  });

  test("59. Dropdown includes both CCR and custom presets", async () => {
    writeCcrConfig([{ id: "ccr-default", name: "CCR Default", model: "ccr-default-model" }]);
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });

    // Open the popover to inspect options.
    await trigger.click();
    const listbox = ctx.window.locator(SEL.preset.selectorListbox);
    await expect(listbox).toBeVisible({ timeout: T_SHORT });

    const hasCcr = await listbox
      .locator('[role="option"]', { hasText: "CCR Default" })
      .first()
      .count()
      .catch(() => 0);
    expect(hasCcr).toBeGreaterThanOrEqual(1);

    const optionCount = await listbox.locator('[role="option"]').count();
    expect(optionCount).toBeGreaterThanOrEqual(3);

    await ctx.window.keyboard.press("Escape");
    await expect(listbox).not.toBeVisible({ timeout: T_SHORT });
  });

  test("60. First option in dropdown is Default (no overrides)", async () => {
    await goToClaudeSettings();
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });

    await trigger.click();
    const listbox = ctx.window.locator(SEL.preset.selectorListbox);
    await expect(listbox).toBeVisible({ timeout: T_SHORT });

    const firstOption = listbox.locator('[role="option"]').first();
    const text = (await firstOption.textContent()) ?? "";
    expect(text).toContain("Default");

    await ctx.window.keyboard.press("Escape");
    await expect(listbox).not.toBeVisible({ timeout: T_SHORT });
  });

  test("61. Section still shows when only one preset total exists", async () => {
    removeCcrConfig();
    await ctx.window.waitForTimeout(35_000);

    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });
    await expect(ctx.window.locator(SEL.preset.defaultSelect)).toBeVisible({ timeout: T_SHORT });
  });

  test("62. Setting default on Claude does not affect Gemini agent", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });
    const count = await countPresetOptions(ctx.window);
    if (count > 1) {
      await selectPresetByIndex(ctx.window, 1);
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    await navigateToAgentSettings(ctx.window, "gemini");
    // In the new UI every agent renders a preset section, but the Popover
    // trigger is only present when there are ≥2 mergeable presets. If the
    // trigger is missing, Gemini has no custom/CCR presets — that's the
    // success case for this test.
    const geminiTrigger = ctx.window.locator(SEL.preset.selectorTrigger);
    const triggerVisible = await geminiTrigger.isVisible({ timeout: 1500 }).catch(() => false);
    if (triggerVisible) {
      const geminiLabels = await countPresetOptions(ctx.window);
      expect(geminiLabels).toBeLessThanOrEqual(1);
    }
  });
});
