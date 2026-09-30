import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
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
  getSelectedPresetLabel,
  type CcrModelEntry,
} from "../../helpers/presets";
import {
  installPresetAgents,
  closeSettings,
  setAgentPinned,
  type FakeAgents,
} from "./presetHarness";

// Claude Code Router models become read-only Claude presets. Every test writes
// the config it needs, so the tests stand alone. The launcher/toolbar checks
// need a launchable Claude, hence the fake CLI on PATH.

const TOOLBAR_CHEVRON = '[aria-label="Set Claude preset"]';

let ctx: AppContext;
let agents: FakeAgents;
let fixtureCleanup: (() => void) | undefined;

const section = () => ctx.window.locator(SEL.preset.section);
const goToClaudeSettings = () => navigateToAgentSettings(ctx.window, "claude");

async function pickDefaultOption(): Promise<void> {
  await ctx.window.locator(SEL.preset.selectorTrigger).click();
  const listbox = ctx.window.locator(SEL.preset.selectorListbox);
  await expect(listbox).toBeVisible({ timeout: T_SHORT });
  const defaultOption = listbox.locator(SEL.preset.defaultOption);
  await expect(defaultOption).toBeVisible({ timeout: T_SHORT });
  await defaultOption.click();
  await expect(listbox).toBeHidden({ timeout: T_SHORT });
}

test.describe("Presets: CCR discovery and sync", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    const { dir, cleanup } = createFixtureRepo({ name: "preset-ccr" });
    agents = installPresetAgents(dir);
    fixtureCleanup = () => {
      cleanup();
      agents.dispose();
    };
    ctx = await launchApp({ env: agents.env });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Preset CCR Test");
  });

  test.afterEach(async () => {
    await closeSettings(ctx.window).catch(() => undefined);
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.describe("discovery", () => {
    test("1. CCR config with models shows presets in the settings selector", async () => {
      writeCcrConfig([
        { id: "deepseek", name: "DeepSeek V3", model: "deepseek-v3" },
        { id: "gpt5", name: "GPT-5", model: "gpt-5.4" },
      ]);
      await waitForCcrPresets(ctx.window, ["DeepSeek V3", "GPT-5"]);
      await expect(section()).toBeVisible({ timeout: T_LONG });

      // The selector strips the "CCR: " prefix from the model names.
      const labels = await getPresetOptionLabels(ctx.window);
      expect(labels.some((l) => l.includes("DeepSeek V3"))).toBe(true);
      expect(labels.some((l) => l.includes("GPT-5"))).toBe(true);
    });

    test("2. No CCR config means no preset chevron on the Claude button", async () => {
      writeCcrConfig([{ id: "chev", name: "Chevron Probe", model: "chev-model" }]);
      await waitForCcrPresets(ctx.window, ["Chevron Probe"]);
      await setAgentPinned(ctx.window, "claude", true);
      await closeSettings(ctx.window);
      const chevron = ctx.window.locator(TOOLBAR_CHEVRON);
      // Control: with a CCR preset and nothing else, the chevron is there.
      await expect(chevron).toBeVisible({ timeout: T_LONG });

      removeCcrConfig();
      await waitForCcrPresetsRemoved(ctx.window, ["Chevron Probe"]);
      await expect(section().locator(SEL.preset.autoBadge)).toHaveCount(0);
      expect(await getPresetOptionLabels(ctx.window)).toEqual(["Default settings"]);
      await closeSettings(ctx.window);
      await expect(chevron).toHaveCount(0, { timeout: T_LONG });
    });

    test("3. Empty CCR config {} produces no presets", async () => {
      writeCcrConfig([{ id: "transient", name: "Transient", model: "transient-model" }]);
      await waitForCcrPresets(ctx.window, ["Transient"]);
      writeCcrConfig([]);
      await waitForCcrPresetsRemoved(ctx.window, ["Transient"]);
      await expect(section().locator(SEL.preset.autoBadge)).toHaveCount(0);
      expect(await getPresetOptionLabels(ctx.window)).toEqual(["Default settings"]);
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
      const row = await getPresetRowByName(ctx.window, "Routed Model");
      await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
      await expect(row.getByText("ANTHROPIC_BASE_URL")).toBeVisible({ timeout: T_SHORT });
      await expect(row.getByText("custom-model")).toBeVisible({ timeout: T_SHORT });
      await expect(row.getByText("https://router.local/v1")).toBeVisible({ timeout: T_SHORT });
    });

    test("5. CCR model with apiKeyEnv sets ANTHROPIC_API_KEY template", async () => {
      writeCcrConfig([
        { id: "keyed", name: "Keyed Model", model: "test-model", apiKeyEnv: "MY_API_KEY" },
      ]);
      await waitForCcrPresets(ctx.window, ["Keyed Model"]);
      const row = await getPresetRowByName(ctx.window, "Keyed Model");
      await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
      await expect(row.getByText("ANTHROPIC_API_KEY")).toBeVisible({ timeout: T_SHORT });
      await expect(row.getByText("test-model")).toBeVisible({ timeout: T_SHORT });
      await expect(row.getByText("${MY_API_KEY}")).toBeVisible({ timeout: T_SHORT });
    });

    test("6. CCR entry without id or model is skipped", async () => {
      writeCcrConfig([
        { name: "Bad Entry" } as CcrModelEntry,
        { id: "valid", name: "Valid", model: "valid-model" },
      ]);
      await waitForCcrPresets(ctx.window, ["Valid"]);
      const labels = await getPresetOptionLabels(ctx.window);
      expect(labels.some((l) => l.includes("Valid"))).toBe(true);
      expect(labels.some((l) => l.includes("Bad Entry"))).toBe(false);
    });

    test("7. Invalid CCR JSON does not crash the app", async () => {
      writeCcrConfig([{ id: "before-corrupt", name: "Before Corrupt", model: "bc-model" }]);
      await waitForCcrPresets(ctx.window, ["Before Corrupt"]);
      const configPath = process.env.DAINTREE_CCR_CONFIG_PATH;
      expect(configPath, "presets helper sets the per-worker CCR path").toBeTruthy();
      mkdirSync(dirname(configPath as string), { recursive: true });
      writeFileSync(configPath as string, "not valid json {{{", "utf-8");
      // The unparseable file is read (it drops the earlier preset), and Settings survives it.
      await waitForCcrPresetsRemoved(ctx.window, ["Before Corrupt"]);
      await goToClaudeSettings();
      await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_LONG });
      await expect(section()).toBeVisible();
      await expect(ctx.window.locator(SEL.errorBoundary.fallback)).toHaveCount(0);
    });

    test("8. A selected CCR preset shows the 'auto' badge", async () => {
      writeCcrConfig([{ id: "autobadge", name: "Autobadge Test", model: "auto-model" }]);
      await waitForCcrPresets(ctx.window, ["Autobadge Test"]);
      await getPresetRowByName(ctx.window, "Autobadge Test");
      await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toContainText("Autobadge Test", {
        timeout: T_SHORT,
      });
      await expect(section().locator(SEL.preset.autoBadge)).toBeVisible({ timeout: T_SHORT });
    });

    test("9. CCR presets are read-only (no Edit/Delete buttons)", async () => {
      writeCcrConfig([{ id: "readonly-test", name: "Readonly Test", model: "ro-model" }]);
      await waitForCcrPresets(ctx.window, ["Readonly Test"]);
      const row = await getPresetRowByName(ctx.window, "Readonly Test");
      // A CCR detail view only offers Duplicate.
      await expect(row.locator(SEL.preset.duplicateButton).first()).toBeVisible();
      await expect(row.locator(SEL.preset.editButton)).toHaveCount(0);
      await expect(row.locator(SEL.preset.deleteButton)).toHaveCount(0);
    });

    test("10. A model added to the config while running appears", async () => {
      writeCcrConfig([{ id: "initial", name: "Initial", model: "init-model" }]);
      await waitForCcrPresets(ctx.window, ["Initial"]);
      const before = await getPresetOptionLabels(ctx.window);
      expect(before.some((l) => l.includes("Initial"))).toBe(true);
      expect(before.some((l) => l.includes("Added Live"))).toBe(false);

      writeCcrConfig([
        { id: "initial", name: "Initial", model: "init-model" },
        { id: "added-live", name: "Added Live", model: "added-model" },
      ]);
      await waitForCcrPresets(ctx.window, ["Initial", "Added Live"]);
      const after = await getPresetOptionLabels(ctx.window);
      expect(after.some((l) => l.includes("Initial"))).toBe(true);
      expect(after.some((l) => l.includes("Added Live"))).toBe(true);
    });

    test("11. A model removed from the config while running disappears", async () => {
      writeCcrConfig([
        { id: "kept", name: "Kept", model: "kept-model" },
        { id: "to-remove", name: "To Remove", model: "remove-model" },
      ]);
      await waitForCcrPresets(ctx.window, ["Kept", "To Remove"]);
      const before = await getPresetOptionLabels(ctx.window);
      expect(before.some((l) => l.includes("To Remove"))).toBe(true);

      writeCcrConfig([{ id: "kept", name: "Kept", model: "kept-model" }]);
      await waitForCcrPresetsRemoved(ctx.window, ["To Remove"]);
      const after = await getPresetOptionLabels(ctx.window);
      expect(after.some((l) => l.includes("To Remove"))).toBe(false);
      expect(after.some((l) => l.includes("Kept"))).toBe(true);
    });

    test("12. Multiple CCR models appear in file order", async () => {
      writeCcrConfig([
        { id: "alpha", name: "Alpha", model: "alpha-model" },
        { id: "beta", name: "Beta", model: "beta-model" },
        { id: "gamma", name: "Gamma", model: "gamma-model" },
      ]);
      await waitForCcrPresets(ctx.window, ["Alpha", "Beta", "Gamma"]);
      const labels = await getPresetOptionLabels(ctx.window);
      const indices = ["Alpha", "Beta", "Gamma"].map((name) =>
        labels.findIndex((t) => t.includes(name))
      );
      expect(indices.every((i) => i >= 0)).toBe(true);
      expect(indices[0]).toBeLessThan(indices[1]!);
      expect(indices[1]).toBeLessThan(indices[2]!);
    });
  });

  test.describe("env overrides in the detail view", () => {
    test("63. CCR preset with model shows ANTHROPIC_MODEL env key", async () => {
      writeCcrConfig([{ id: "env-model", name: "Env Model", model: "claude-sonnet-4" }]);
      await waitForCcrPresets(ctx.window, ["Env Model"]);
      const row = await getPresetRowByName(ctx.window, "Env Model");
      await expect(row).toBeVisible({ timeout: T_MEDIUM });
      await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
    });

    test("64. CCR preset with baseUrl shows ANTHROPIC_BASE_URL env key", async () => {
      writeCcrConfig([
        {
          id: "env-url",
          name: "Env Url",
          model: "test-model",
          baseUrl: "https://proxy.internal/v1",
        },
      ]);
      await waitForCcrPresets(ctx.window, ["Env Url"]);
      const row = await getPresetRowByName(ctx.window, "Env Url");
      await expect(row).toBeVisible({ timeout: T_MEDIUM });
      await expect(row.getByText("ANTHROPIC_BASE_URL")).toBeVisible({ timeout: T_SHORT });
    });

    test("65/67. Choosing Default after a CCR preset clears the selection", async () => {
      writeCcrConfig([
        { id: "default-test", name: "Default Test", model: "default-model" },
        { id: "select-a", name: "Select A", model: "select-a-model" },
      ]);
      await waitForCcrPresets(ctx.window, ["Default Test", "Select A"]);

      await getPresetRowByName(ctx.window, "Default Test");
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Default Test");
      await pickDefaultOption();
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Default");

      await getPresetRowByName(ctx.window, "Select A");
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Select A");
      await pickDefaultOption();
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Default");
      await expect(section().locator(SEL.preset.autoBadge)).toHaveCount(0);
    });

    test("66/70. Preset with 3 env vars shows all keys", async () => {
      writeCcrConfig([
        {
          id: "multi-env",
          name: "Multi Env",
          model: "multi-model",
          baseUrl: "https://multi.local",
          apiKeyEnv: "MY_SECRET_KEY",
        },
      ]);
      await waitForCcrPresets(ctx.window, ["Multi Env"]);
      const row = await getPresetRowByName(ctx.window, "Multi Env");
      await expect(row).toBeVisible({ timeout: T_MEDIUM });
      await expect(row.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
      await expect(row.getByText("ANTHROPIC_BASE_URL")).toBeVisible({ timeout: T_SHORT });
      await expect(row.getByText("ANTHROPIC_API_KEY")).toBeVisible({ timeout: T_SHORT });
      const rowText = await row.textContent();
      expect(rowText).toContain("ANTHROPIC_MODEL");
      expect(rowText).toContain("ANTHROPIC_BASE_URL");
      expect(rowText).toContain("ANTHROPIC_API_KEY");
    });

    test("68. Env var display uses font-mono text in the detail view", async () => {
      writeCcrConfig([
        {
          id: "mono-env",
          name: "Mono Env",
          model: "mono-model",
          baseUrl: "https://very-long-base-url.example.com/api/v1/longer-path",
        },
      ]);
      await waitForCcrPresets(ctx.window, ["Mono Env"]);
      const row = await getPresetRowByName(ctx.window, "Mono Env");
      const envMono = row.locator(".font-mono", { hasText: "ANTHROPIC_MODEL" });
      await expect(envMono.first()).toBeVisible({ timeout: T_SHORT });
      await expect(envMono.first()).toContainText("ANTHROPIC_MODEL");
    });

    test("69. Two presets with same env key — select each and verify", async () => {
      writeCcrConfig([
        { id: "dup-first", name: "Dup First", model: "dup-model-a" },
        { id: "dup-second", name: "Dup Second", model: "dup-model-b" },
      ]);
      await waitForCcrPresets(ctx.window, ["Dup First", "Dup Second"]);

      const row1 = await getPresetRowByName(ctx.window, "Dup First");
      await expect(row1.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
      await expect(row1.getByText("dup-model-a")).toBeVisible({ timeout: T_SHORT });
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Dup First");

      const row2 = await getPresetRowByName(ctx.window, "Dup Second");
      await expect(row2.getByText("ANTHROPIC_MODEL")).toBeVisible({ timeout: T_SHORT });
      await expect(row2.getByText("dup-model-b")).toBeVisible({ timeout: T_SHORT });
      await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Dup Second");
    });
  });

  test("75. Removing CCR config with a CCR preset selected falls back to Default", async () => {
    writeCcrConfig([{ id: "ccr-stale", name: "CCR Stale", model: "stale-model" }]);
    await waitForCcrPresets(ctx.window, ["CCR Stale"]);
    await getPresetRowByName(ctx.window, "CCR Stale");
    await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("CCR Stale");

    removeCcrConfig();
    await waitForCcrPresetsRemoved(ctx.window, ["CCR Stale"]);
    await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({ timeout: T_MEDIUM });
    await expect.poll(() => getSelectedPresetLabel(ctx.window)).toContain("Default");
  });

  // Main writes the config-derived presets and pushes them to the renderer;
  // these check the surfaces outside Settings pick them up.
  test.describe.serial("sync to launch surfaces", () => {
    test.beforeAll(async () => {
      writeCcrConfig([
        { id: "ipc-sync-model", name: "IPC Sync Model", model: "ipc-model-v1" },
        { id: "ipc-sync-aux", name: "IPC Sync Aux", model: "ipc-model-v2" },
      ]);
    });

    test.afterAll(() => {
      removeCcrConfig();
    });

    test("77. CCR config write reaches the settings selector", async () => {
      await waitForCcrPresets(ctx.window, ["IPC Sync Model"]);
      await expect(section()).toBeVisible({ timeout: T_MEDIUM });
      await expect
        .poll(async () =>
          (await getPresetOptionLabels(ctx.window)).some((l) => l.includes("IPC Sync Model"))
        )
        .toBe(true);
    });

    test("78/81. Selecting a synced CCR entry shows the auto badge", async () => {
      await goToClaudeSettings();
      const detail = await getPresetRowByName(ctx.window, "IPC Sync Model");
      await expect(detail).toBeVisible({ timeout: T_SHORT });
      await expect(section().locator(SEL.preset.autoBadge)).toBeVisible({ timeout: T_SHORT });
    });

    test("79. CCR model sync makes the toolbar chevron visible", async () => {
      await setAgentPinned(ctx.window, "claude", true);
      await closeSettings(ctx.window);
      await expect(ctx.window.locator(TOOLBAR_CHEVRON)).toBeVisible({ timeout: T_LONG });
    });

    test("80. CCR model sync gives Claude's launcher row a preset disclosure", async () => {
      await setAgentPinned(ctx.window, "claude", false);
      try {
        await closeSettings(ctx.window);
        await ctx.window.locator(SEL.agent.trayButton).click();
        const search = ctx.window.getByRole("combobox", {
          name: "Search agents, panels, and recipes",
        });
        await expect(search).toBeVisible({ timeout: T_MEDIUM });
        await search.fill("Claude");
        await expect(ctx.window.locator(SEL.preset.trayLaunchPresetParent).first()).toBeVisible({
          timeout: T_MEDIUM,
        });
        await ctx.window.keyboard.press("Escape");
        await ctx.window.keyboard.press("Escape");
        await expect(ctx.window.getByRole("dialog", { name: "Launch" })).toBeHidden();
      } finally {
        await setAgentPinned(ctx.window, "claude", true);
      }
    });

    test("82. Removing CCR config does not crash the app — settings still loads", async () => {
      removeCcrConfig();
      await waitForCcrPresetsRemoved(ctx.window, ["IPC Sync Model", "IPC Sync Aux"]);
      await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
      await expect(ctx.window.locator(SEL.errorBoundary.fallback)).toHaveCount(0);
    });
  });
});
