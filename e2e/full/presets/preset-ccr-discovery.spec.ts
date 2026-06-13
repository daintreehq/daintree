import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  navigateToAgentSettings,
  waitForCcrPresets,
  waitForCcrPresetsRemoved,
  getPresetOptionLabels,
  getPresetRowByName,
  type CcrModelEntry,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

const T_CCR = T_LONG;

const closeSettings = async () => {
  await ctx.window.keyboard.press("Escape");
  await expect(ctx.window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_MEDIUM });
};

const selectClaudePresetDirectly = async (presetId: string) => {
  await ctx.window.evaluate(async (targetPresetId) => {
    type AgentEntry = Record<string, unknown> & { presetId?: string };
    type AgentSettings = { agents?: Record<string, AgentEntry | undefined> };
    type DispatchResult = { ok?: boolean; error?: { message?: string } };
    type Dispatch = (
      actionId: string,
      args?: unknown,
      options?: { source?: string }
    ) => Promise<DispatchResult>;

    const settings = (await window.electron.agentSettings.get()) as AgentSettings;
    const entry = settings.agents?.claude ?? {};
    const nextEntry: AgentEntry = { ...entry, presetId: targetPresetId };
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
};

test.describe.serial("Presets: CCR Discovery & Auto-Config (1–12)", () => {
  test.beforeAll(async () => {
    writeCcrConfig([
      { id: "deepseek", name: "DeepSeek V3", model: "deepseek-v3" },
      { id: "gpt5", name: "GPT-5", model: "gpt-5.4" },
    ]);
    ctx = await launchApp();
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-ccr" });
    fixtureCleanup = cleanup;
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset CCR Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("1. CCR config with models shows presets in toolbar split-button", async () => {
    writeCcrConfig([
      { id: "deepseek", name: "DeepSeek V3", model: "deepseek-v3" },
      { id: "gpt5", name: "GPT-5", model: "gpt-5.4" },
    ]);

    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });

    // The PresetSelector lists the CCR models without the "CCR: " prefix
    // (that's stripped by stripCcrPrefix in the component).
    const labels = await getPresetOptionLabels(ctx.window);
    expect(labels.some((l) => l.includes("DeepSeek V3"))).toBe(true);
    expect(labels.some((l) => l.includes("GPT-5"))).toBe(true);

    await closeSettings();
  });

  test("2. No CCR config means no preset chevron on Claude button", async () => {
    removeCcrConfig();
    // Wait for the running poll cycle to drop test 1's presets before asserting,
    // so a passing assertion reflects the app reacting to the removed config.
    await waitForCcrPresetsRemoved(ctx.window, ["DeepSeek V3", "GPT-5"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section).locator(SEL.preset.autoBadge)).toHaveCount(
      0,
      { timeout: T_CCR }
    );

    await closeSettings();
  });

  test("3. Empty CCR config {} produces no presets", async () => {
    writeCcrConfig([{ id: "transient", name: "Transient", model: "transient-model" }]);
    await waitForCcrPresets(ctx.window, ["Transient"]);
    // Now empty the config; the running poll cycle must clear the preset.
    writeCcrConfig([]);
    await waitForCcrPresetsRemoved(ctx.window, ["Transient"]);
    await navigateToAgentSettings(ctx.window, "claude");
    const autoPresets = ctx.window.locator(SEL.preset.section).locator(SEL.preset.autoBadge);
    await expect(autoPresets).toHaveCount(0, { timeout: T_CCR });

    await closeSettings();
  });

  test("4. CCR model with baseUrl sets ANTHROPIC_MODEL and ANTHROPIC_BASE_URL env", async () => {
    writeCcrConfig([
      {
        id: "routed",
        name: "Routed Model",
        model: "custom-model",
        baseUrl: "https://router.local/v1",
      },
    ]);
    await waitForCcrPresets(ctx.window, ["Routed Model"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });
    const row = await getPresetRowByName(ctx.window, "Routed Model");
    await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("ANTHROPIC_BASE_URL")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("custom-model")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("https://router.local/v1")).toBeVisible({ timeout: T_SHORT });

    await closeSettings();
  });

  test("5. CCR model with apiKeyEnv sets ANTHROPIC_API_KEY template", async () => {
    writeCcrConfig([
      { id: "keyed", name: "Keyed Model", model: "test-model", apiKeyEnv: "MY_API_KEY" },
    ]);
    await waitForCcrPresets(ctx.window, ["Keyed Model"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });
    const row = await getPresetRowByName(ctx.window, "Keyed Model");
    await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("ANTHROPIC_API_KEY")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("test-model")).toBeVisible({ timeout: T_SHORT });
    await expect(row.getByText("${MY_API_KEY}")).toBeVisible({ timeout: T_SHORT });

    await closeSettings();
  });

  test("6. CCR entry without id or model is skipped", async () => {
    writeCcrConfig([
      { name: "Bad Entry" } as CcrModelEntry,
      { id: "valid", name: "Valid", model: "valid-model" },
    ]);
    await waitForCcrPresets(ctx.window, ["Valid"]);

    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });
    const labels = await getPresetOptionLabels(ctx.window);
    expect(labels.some((l) => l.includes("Valid"))).toBe(true);
    expect(labels.some((l) => l.includes("Bad Entry"))).toBe(false);

    await closeSettings();
  });

  test("7. Invalid CCR JSON does not crash the app", async () => {
    writeCcrConfig([{ id: "before" }] as import("../../helpers/presets").CcrModelEntry[]);
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    const configPath = process.env.DAINTREE_CCR_CONFIG_PATH;
    if (configPath) {
      mkdirSync(dirname(configPath), { recursive: true });
      writeFileSync(configPath, "not valid json {{{", "utf-8");
    }
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_CCR });

    await closeSettings();
  });

  test("8. CCR presets show 'auto' badge", async () => {
    writeCcrConfig([{ id: "autobadge", name: "Autobadge Test", model: "auto-model" }]);
    await waitForCcrPresets(ctx.window, ["Autobadge Test"]);
    await selectClaudePresetDirectly("ccr-autobadge");
    await navigateToAgentSettings(ctx.window, "claude");
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_CCR });
    await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toContainText("Autobadge Test", {
      timeout: T_SHORT,
    });
    await expect(section.locator(SEL.preset.autoBadge)).toBeVisible({ timeout: T_SHORT });

    await closeSettings();
  });

  test("9. CCR presets are read-only (no Edit/Delete buttons)", async () => {
    writeCcrConfig([{ id: "readonly-test", name: "Readonly Test", model: "ro-model" }]);
    await waitForCcrPresets(ctx.window, ["Readonly Test"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });
    const row = await getPresetRowByName(ctx.window, "Readonly Test");
    // CCR detail views only expose a Duplicate button; Edit/Delete are absent.
    await expect(row.locator(SEL.preset.editButton)).toHaveCount(0);
    await expect(row.locator(SEL.preset.deleteButton)).toHaveCount(0);

    await closeSettings();
  });

  test("10. Modifying CCR config while running updates presets within 30s", async () => {
    writeCcrConfig([{ id: "initial", name: "Initial", model: "init-model" }]);
    await waitForCcrPresets(ctx.window, ["Initial"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });
    const before = await getPresetOptionLabels(ctx.window);
    expect(before.some((l) => l.includes("Initial"))).toBe(true);
    expect(before.some((l) => l.includes("Added Live"))).toBe(false);

    // Mutate the config while the app is running; the running CCR poll cycle
    // must pick up the new model without a restart.
    writeCcrConfig([
      { id: "initial", name: "Initial", model: "init-model" },
      { id: "added-live", name: "Added Live", model: "added-model" },
    ]);
    await waitForCcrPresets(ctx.window, ["Initial", "Added Live"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });
    const after = await getPresetOptionLabels(ctx.window);
    expect(after.some((l) => l.includes("Initial"))).toBe(true);
    expect(after.some((l) => l.includes("Added Live"))).toBe(true);

    await closeSettings();
  });

  test("11. Removing a CCR model from config removes the preset within 30s", async () => {
    writeCcrConfig([
      { id: "kept", name: "Kept", model: "kept-model" },
      { id: "to-remove", name: "To Remove", model: "remove-model" },
    ]);
    await waitForCcrPresets(ctx.window, ["Kept", "To Remove"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });
    const before = await getPresetOptionLabels(ctx.window);
    expect(before.some((l) => l.includes("To Remove"))).toBe(true);

    // Drop one model from the config while running; the poll cycle must drop
    // the corresponding preset while keeping the surviving one.
    writeCcrConfig([{ id: "kept", name: "Kept", model: "kept-model" }]);
    await waitForCcrPresetsRemoved(ctx.window, ["To Remove"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });
    const after = await getPresetOptionLabels(ctx.window);
    expect(after.some((l) => l.includes("To Remove"))).toBe(false);
    expect(after.some((l) => l.includes("Kept"))).toBe(true);

    await closeSettings();
  });

  test("12. Multiple CCR models appear in file order", async () => {
    writeCcrConfig([
      { id: "alpha", name: "Alpha", model: "alpha-model" },
      { id: "beta", name: "Beta", model: "beta-model" },
      { id: "gamma", name: "Gamma", model: "gamma-model" },
    ]);
    await waitForCcrPresets(ctx.window, ["Alpha", "Beta", "Gamma"]);
    await navigateToAgentSettings(ctx.window, "claude");
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_CCR });

    const labels = await getPresetOptionLabels(ctx.window);
    const indices = ["Alpha", "Beta", "Gamma"].map((name) =>
      labels.findIndex((t) => t.includes(name))
    );
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect(indices[0]).toBeLessThan(indices[1]!);
    expect(indices[1]).toBeLessThan(indices[2]!);

    await closeSettings();
  });
});
