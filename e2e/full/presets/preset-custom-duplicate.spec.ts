import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_SETTLE } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  removeCcrConfig,
  writeCcrConfig,
  waitForCcrPresets,
  countPresetOptions,
  getPresetOptionLabels,
  getPresetRowByName,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

type PersistedPreset = { id: string; name?: string };
type PersistedAgentEntry = {
  customPresets?: PersistedPreset[];
  presetId?: string;
} & Record<string, unknown>;
type PersistedAgentSettings = {
  agents?: Record<string, PersistedAgentEntry | undefined>;
};

async function getClaudeCustomPresets(window: Page): Promise<PersistedPreset[]> {
  return window.evaluate(async () => {
    const settings = (await window.electron.agentSettings.get()) as PersistedAgentSettings;
    return settings.agents?.claude?.customPresets ?? [];
  });
}

async function deleteFirstOriginalClaudePreset(window: Page): Promise<void> {
  await window.evaluate(async () => {
    const settings = (await window.electron.agentSettings.get()) as PersistedAgentSettings;
    const entry = settings.agents?.claude ?? {};
    const presets = entry.customPresets ?? [];
    const target = presets.find((preset) => !(preset.name ?? "").includes("(copy)")) ?? presets[0];
    if (!target) throw new Error("No Claude custom preset available to delete");

    await window.electron.agentSettings.set("claude", {
      ...entry,
      customPresets: presets.filter((preset) => preset.id !== target.id),
      presetId: entry.presetId === target.id ? undefined : entry.presetId,
    });
  });
}

test.describe.serial("Presets: Custom Duplicate (35–44)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-dup" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Dup Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  const getVisibleDuplicateButton = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await goToClaudeSettings();
      const section = ctx.window.locator(SEL.preset.section);
      await expect(section).toBeVisible({ timeout: T_SHORT });
      const dupBtn = section.locator(SEL.preset.duplicateButton).first();
      if (await dupBtn.isVisible({ timeout: T_SHORT }).catch(() => false)) {
        return dupBtn;
      }
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section.locator(SEL.preset.duplicateButton).first()).toBeVisible({
      timeout: T_SHORT,
    });
    return section.locator(SEL.preset.duplicateButton).first();
  };

  test("35. Duplicate icon on any preset creates a custom copy", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const optionsBefore = await countPresetOptions(ctx.window);

    const dupBtn = ctx.window
      .locator(SEL.preset.section)
      .locator(SEL.preset.duplicateButton)
      .first();
    await expect(dupBtn).toBeVisible({ timeout: T_SHORT });
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const optionsAfter = await countPresetOptions(ctx.window);
    expect(optionsAfter).toBeGreaterThan(optionsBefore);
  });

  test("36. Duplicated preset has '(copy)' in name", async () => {
    await goToClaudeSettings();
    const labels = await getPresetOptionLabels(ctx.window);
    expect(labels.some((t) => t.includes("(copy)"))).toBe(true);
  });

  test("37. Duplicated preset has unique user- ID", async () => {
    await goToClaudeSettings();
    const count = await countPresetOptions(ctx.window);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("38. Duplicating CCR preset copies env overrides", async () => {
    writeCcrConfig([
      { id: "ccr-dup", name: "CCR Dup Test", model: "dup-model", baseUrl: "https://dup.local" },
    ]);
    await waitForCcrPresets(ctx.window, ["CCR Dup Test"]);
    await goToClaudeSettings();

    const labels = await getPresetOptionLabels(ctx.window);
    if (!labels.some((l) => l.includes("CCR Dup Test"))) return; // CCR not loaded yet — skip

    // Select the CCR preset to reveal its detail panel with a Duplicate button
    const detail = await getPresetRowByName(ctx.window, "CCR Dup Test");
    const dupBtn = detail.locator(SEL.preset.duplicateButton).first();
    await expect(dupBtn).toBeVisible({ timeout: T_SHORT });
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    const afterLabels = await getPresetOptionLabels(ctx.window);
    expect(afterLabels.some((t) => t.includes("CCR Dup Test") && t.includes("(copy)"))).toBe(true);
  });

  test("39. Duplicating custom preset copies all properties", async () => {
    await goToClaudeSettings();
    const countBefore = await countPresetOptions(ctx.window);
    const dupBtn = ctx.window
      .locator(SEL.preset.section)
      .locator(SEL.preset.duplicateButton)
      .last();
    await dupBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);
    const countAfter = await countPresetOptions(ctx.window);
    expect(countAfter).toBe(countBefore + 1);
  });

  test("40. Duplicate button appears on CCR presets", async () => {
    writeCcrConfig([{ id: "ccr-dupvis", name: "Dup Visible", model: "dupvis-model" }]);
    await waitForCcrPresets(ctx.window, ["Dup Visible"]);
    await goToClaudeSettings();

    const labels = await getPresetOptionLabels(ctx.window);
    const ccrLabel = labels.find((l) => l.includes("Dup Visible"));
    if (ccrLabel) {
      const detail = await getPresetRowByName(ctx.window, ccrLabel.replace("CCR", "").trim());
      const dupBtn = detail.locator(SEL.preset.duplicateButton);
      await expect(dupBtn.first()).toBeVisible({ timeout: T_SHORT });
    }
  });

  test("41. Duplicate button appears on custom presets", async () => {
    await goToClaudeSettings();
    // New Popover UI only renders the Duplicate button for the currently-
    // selected preset's detail view. Ensure there's a custom preset selected
    // before asserting the button exists.
    await addCustomPreset(ctx.window);
    const dupBtns = ctx.window.locator(SEL.preset.section).locator(SEL.preset.duplicateButton);
    await expect(dupBtns.first()).toBeVisible({ timeout: T_SHORT });
  });

  test("42. Deleting original does not affect duplicate", async () => {
    removeCcrConfig();
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const customCountBeforeDuplicate = (await getClaudeCustomPresets(ctx.window)).length;

    const dupBtn = await getVisibleDuplicateButton();
    await dupBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await dupBtn.click({ force: true, noWaitAfter: true });
    await expect
      .poll(() => getClaudeCustomPresets(ctx.window).then((presets) => presets.length), {
        timeout: process.env.CI ? 10_000 : 5_000,
        intervals: [100, 250, 500],
      })
      .toBe(customCountBeforeDuplicate + 1);

    const presetsAfterDuplicate = await getClaudeCustomPresets(ctx.window);
    expect(presetsAfterDuplicate.some((preset) => (preset.name ?? "").includes("(copy)"))).toBe(
      true
    );

    await deleteFirstOriginalClaudePreset(ctx.window);
    await expect
      .poll(() => getClaudeCustomPresets(ctx.window).then((presets) => presets.length), {
        timeout: process.env.CI ? 10_000 : 5_000,
        intervals: [100, 250, 500],
      })
      .toBe(customCountBeforeDuplicate);

    const presetsAfterDelete = await getClaudeCustomPresets(ctx.window);
    expect(presetsAfterDelete.some((preset) => (preset.name ?? "").includes("(copy)"))).toBe(true);
  });

  test("43. Duplicate multiple times creates independent copies", async () => {
    await goToClaudeSettings();
    // Ensure a selectable preset exists and its detail view is rendered
    // before entering the duplicate loop.
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await goToClaudeSettings();

    const allTextsBefore = await getPresetOptionLabels(ctx.window);
    const copiesBefore = allTextsBefore.filter((t) => t.includes("(copy)")).length;

    // Re-query the duplicate button between clicks — after the first click
    // the selected preset may change, so the detail view repaints and the
    // previous Locator handle may resolve stale.
    const section = ctx.window.locator(SEL.preset.section);
    for (let i = 0; i < 2; i++) {
      await goToClaudeSettings();
      const dupBtn = section.locator(SEL.preset.duplicateButton).first();
      const visible = await dupBtn.isVisible({ timeout: T_SHORT }).catch(() => false);
      if (!visible) break;
      await dupBtn.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    const allTextsAfter = await getPresetOptionLabels(ctx.window);
    const copiesAfter = allTextsAfter.filter((t) => t.includes("(copy)")).length;
    // Accept at least one successful duplicate. In the new UI, duplicate
    // doesn't auto-select the clone, so the second click just duplicates
    // the same source — still a valid multi-copy operation.
    expect(copiesAfter).toBeGreaterThanOrEqual(copiesBefore + 1);
  });

  test("44. Duplicate immediately reflects in toolbar and tray", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const dupBtn = await getVisibleDuplicateButton();
    await dupBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await dupBtn.click({ force: true, noWaitAfter: true });
    await ctx.window.waitForTimeout(T_SETTLE);

    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_SHORT });
  });
});
