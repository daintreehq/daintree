import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_SETTLE } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  writeCcrConfig,
  removeCcrConfig,
  waitForCcrPresets,
  waitForCcrPresetsRemoved,
  getSelectedPresetLabel,
  getPresetOptionLabels,
  getPresetRowByName,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Presets: Stale Preset Handling (71–76)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-stale" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Stale Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  const getPersistedPresetId = async (): Promise<string | null> => {
    return ctx.window.evaluate(async (): Promise<string | null> => {
      const settings = await window.electron.agentSettings.get();
      const agents = settings.agents as
        Record<string, { presetId?: string } | undefined> | undefined;
      return agents?.claude?.presetId ?? null;
    });
  };

  const selectCustomAsDefault = async () => {
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    const labels = await getPresetOptionLabels(ctx.window);
    // The Add-preset dialog (blank choice) names new presets "New preset"; the
    // helper's direct-persist fallback names them "Custom Preset N". Match either.
    const customLabel = labels.find((o) => o.includes("New preset") || o.includes("Custom Preset"));
    expect(customLabel, "addCustomPreset should produce a new custom-preset option").toBeTruthy();
    await getPresetRowByName(ctx.window, customLabel as string);
    await ctx.window.waitForTimeout(T_SETTLE);
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain(customLabel as string);
    await expect.poll(() => getPersistedPresetId(), { timeout: T_MEDIUM }).not.toBeNull();
  };

  const getPersistedCustomCount = async (): Promise<number> => {
    return ctx.window.evaluate(async (): Promise<number> => {
      const settings = await window.electron.agentSettings.get();
      const agents = settings.agents as
        Record<string, { customPresets?: unknown[] } | undefined> | undefined;
      const presets = agents?.claude?.customPresets;
      return Array.isArray(presets) ? presets.length : 0;
    });
  };

  const deleteFirstCustomPreset = async () => {
    // The delete button only renders for the currently-selected custom preset's
    // detail view. Wait for it to be visible before clicking so timing races
    // fail fast instead of stuck on a silent 30s timeout.
    const countBefore = await getPersistedCustomCount();
    const delBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first();
    await expect(delBtn).toBeVisible({ timeout: T_SHORT });
    await delBtn.click();
    await expect.poll(() => getPersistedCustomCount(), { timeout: T_MEDIUM }).toBe(countBefore - 1);
  };

  test("71. Delete default preset shows no error", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await selectCustomAsDefault();
    await deleteFirstCustomPreset();

    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
    await expect(ctx.window.locator(SEL.errorBoundary.fallback)).not.toBeVisible();
    await expect(ctx.window.locator(SEL.notifications.toastRegion).getByRole("alert")).toHaveCount(
      0
    );
    expect(await getSelectedPresetLabel(ctx.window)).toContain("Default");
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
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Default");
    await expect.poll(() => getPersistedPresetId(), { timeout: T_MEDIUM }).toBeNull();
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
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Default");
    // Reopening settings re-reads persisted storage; the deleted default must
    // have been durably cleared, not just reset in memory.
    await expect.poll(() => getPersistedPresetId(), { timeout: T_MEDIUM }).toBeNull();
  });

  test("75. Removing CCR config with CCR default preset defaults to default", async () => {
    writeCcrConfig([{ id: "ccr-stale", name: "CCR Stale", model: "stale-model" }]);
    await waitForCcrPresets(ctx.window, ["CCR Stale"]);

    await goToClaudeSettings();
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    const labels = await getPresetOptionLabels(ctx.window);
    const ccrLabel = labels.find((o) => o.includes("CCR Stale"));
    expect(ccrLabel, "CCR Stale preset should be selectable after waitForCcrPresets").toBeTruthy();
    await getPresetRowByName(ctx.window, ccrLabel as string);
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("CCR Stale");

    removeCcrConfig();
    await waitForCcrPresetsRemoved(ctx.window, ["CCR Stale"]);

    await goToClaudeSettings();
    // Re-query the trigger after re-navigation rather than reusing the pre-removal node.
    await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({ timeout: T_MEDIUM });
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Default");
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
    await expect(trigger).toBeVisible({ timeout: T_MEDIUM });
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Default");
    await expect.poll(() => getPersistedPresetId(), { timeout: T_MEDIUM }).toBeNull();
  });
});
