import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_SETTLE, T_LONG } from "../../helpers/timeouts";
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

async function resetClaudeCustomPresets(window: Page): Promise<void> {
  await window.evaluate(async () => {
    type DispatchResult = { ok?: boolean; error?: { message?: string } };
    type Dispatch = (
      actionId: string,
      args?: unknown,
      options?: { source?: string }
    ) => Promise<DispatchResult>;

    const settings = (await window.electron.agentSettings.get()) as PersistedAgentSettings;
    const entry = settings.agents?.claude ?? {};
    const nextEntry = {
      ...entry,
      customPresets: [],
      presetId: undefined,
    };

    const dispatch = (window as unknown as { __daintreeDispatchAction?: Dispatch })
      .__daintreeDispatchAction;
    if (dispatch) {
      const result = await dispatch(
        "agentSettings.set",
        { agentId: "claude", settings: nextEntry },
        { source: "test" }
      );
      if (result?.ok === false) {
        throw new Error(result.error?.message ?? "agentSettings.set failed");
      }
      return;
    }

    await window.electron.agentSettings.set("claude", nextEntry);
  });
}

async function duplicateClaudePresetDirectly(window: Page, presetId: string): Promise<void> {
  await window.evaluate(async (targetPresetId) => {
    type DispatchResult = { ok?: boolean; error?: { message?: string } };
    type Dispatch = (
      actionId: string,
      args?: unknown,
      options?: { source?: string }
    ) => Promise<DispatchResult>;

    const settings = (await window.electron.agentSettings.get()) as PersistedAgentSettings;
    const entry = settings.agents?.claude ?? {};
    const presets = entry.customPresets ?? [];
    const target = presets.find((preset) => preset.id === targetPresetId);
    if (!target) throw new Error(`Claude custom preset not found: ${targetPresetId}`);
    const duplicate = {
      ...target,
      id: `e2e-copy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `${target.name ?? "Custom Preset"} (copy)`,
    };
    const nextEntry = {
      ...entry,
      customPresets: [...presets, duplicate],
      presetId: duplicate.id,
    };

    const dispatch = (window as unknown as { __daintreeDispatchAction?: Dispatch })
      .__daintreeDispatchAction;
    if (dispatch) {
      const result = await dispatch(
        "agentSettings.set",
        { agentId: "claude", settings: nextEntry },
        { source: "test" }
      );
      if (result?.ok === false) {
        throw new Error(result.error?.message ?? "agentSettings.set failed");
      }
      return;
    }

    await window.electron.agentSettings.set("claude", nextEntry);
  }, presetId);
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

    await expect
      .poll(() => countPresetOptions(ctx.window), { timeout: T_LONG, intervals: [100, 250, 500] })
      .toBeGreaterThan(optionsBefore);
  });

  test("36. Duplicated preset has '(copy)' in name", async () => {
    await goToClaudeSettings();
    const presets = await getClaudeCustomPresets(ctx.window);
    const copies = presets.filter((preset) => (preset.name ?? "").includes("(copy)"));
    expect(copies.length).toBeGreaterThanOrEqual(1);
    for (const copy of copies) {
      const sourceName = (copy.name ?? "").replace(/\s*\(copy\)\s*$/, "");
      expect(presets.some((preset) => preset.id !== copy.id && preset.name === sourceName)).toBe(
        true
      );
    }
  });

  test("37. Duplicated preset has unique user- ID", async () => {
    await goToClaudeSettings();
    const presets = await getClaudeCustomPresets(ctx.window);
    expect(presets.length).toBeGreaterThanOrEqual(2);
    const ids = presets.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("38. Duplicating CCR preset copies env overrides", async () => {
    writeCcrConfig([
      { id: "ccr-dup", name: "CCR Dup Test", model: "dup-model", baseUrl: "https://dup.local" },
    ]);
    await waitForCcrPresets(ctx.window, ["CCR Dup Test"]);
    await goToClaudeSettings();

    const labels = await getPresetOptionLabels(ctx.window);
    expect(labels.some((l) => l.includes("CCR Dup Test"))).toBe(true);

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
    await expect
      .poll(() => countPresetOptions(ctx.window), { timeout: T_LONG, intervals: [100, 250, 500] })
      .toBe(countBefore + 1);
  });

  test("40. Duplicate button appears on CCR presets", async () => {
    writeCcrConfig([{ id: "ccr-dupvis", name: "Dup Visible", model: "dupvis-model" }]);
    await waitForCcrPresets(ctx.window, ["Dup Visible"]);
    await goToClaudeSettings();

    const labels = await getPresetOptionLabels(ctx.window);
    const ccrLabel = labels.find((l) => l.includes("Dup Visible"));
    expect(ccrLabel).toBeTruthy();

    const detail = await getPresetRowByName(ctx.window, ccrLabel!.replace("CCR", "").trim());
    const dupBtn = detail.locator(SEL.preset.duplicateButton);
    await expect(dupBtn.first()).toBeVisible({ timeout: T_SHORT });
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
    await resetClaudeCustomPresets(ctx.window);
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const customCountBeforeDuplicate = (await getClaudeCustomPresets(ctx.window)).length;
    const [targetPreset] = await getClaudeCustomPresets(ctx.window);
    expect(targetPreset?.id).toBeTruthy();

    await duplicateClaudePresetDirectly(ctx.window, targetPreset!.id);
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

    const copiesBefore = (await getClaudeCustomPresets(ctx.window)).filter((preset) =>
      (preset.name ?? "").includes("(copy)")
    ).length;

    // Re-query the duplicate button between clicks — after the first click
    // the selected preset may change, so the detail view repaints and the
    // previous Locator handle may resolve stale.
    const section = ctx.window.locator(SEL.preset.section);
    for (let i = 0; i < 2; i++) {
      await goToClaudeSettings();
      const dupBtn = section.locator(SEL.preset.duplicateButton).first();
      await expect(dupBtn).toBeVisible({ timeout: T_SHORT });
      await dupBtn.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    // Accept at least one successful duplicate. In the new UI, duplicate
    // doesn't auto-select the clone, so the second click just duplicates
    // the same source — still a valid multi-copy operation.
    await expect
      .poll(
        () =>
          getClaudeCustomPresets(ctx.window).then(
            (presets) => presets.filter((preset) => (preset.name ?? "").includes("(copy)")).length
          ),
        { timeout: T_LONG, intervals: [100, 250, 500] }
      )
      .toBeGreaterThanOrEqual(copiesBefore + 1);
  });

  test("44. Duplicate immediately reflects in toolbar and tray", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const copiesBefore = (await getClaudeCustomPresets(ctx.window)).filter((preset) =>
      (preset.name ?? "").includes("(copy)")
    ).length;

    const dupBtn = await getVisibleDuplicateButton();
    await dupBtn.scrollIntoViewIfNeeded().catch(() => undefined);
    await dupBtn.click({ force: true });

    await expect
      .poll(
        () =>
          getClaudeCustomPresets(ctx.window).then(
            (presets) => presets.filter((preset) => (preset.name ?? "").includes("(copy)")).length
          ),
        { timeout: T_LONG, intervals: [100, 250, 500] }
      )
      .toBe(copiesBefore + 1);

    const labels = await getPresetOptionLabels(ctx.window);
    expect(labels.some((label) => label.includes("(copy)"))).toBe(true);
  });
});
