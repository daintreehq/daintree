import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  writeCcrConfig,
  removeCcrConfig,
  waitForCcrPresets,
  waitForCcrPresetsRemoved,
  getSelectedPresetLabel,
  countPresetOptions,
} from "../../helpers/presets";

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

// The settings-side chevron uses `Set <agent> preset`; the shared
// SEL.preset.toolbarChevron (`Choose…preset`) does not match the current
// AgentButton aria-label, so anchor the toolbar split-button chevron locally.
const TOOLBAR_CHEVRON = '[aria-label="Set Claude preset"]';

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
let fakeBinDir: string;

// A fake `claude` binary on PATH makes Claude `launchable`, the precondition
// for the toolbar split-button chevron to render. Without it the chevron never
// mounts and the chevron assertion in test 56 cannot run.
function writeFakeClaude(): void {
  const scriptPath =
    process.platform === "win32"
      ? path.join(fakeBinDir, "claude.js")
      : path.join(fakeBinDir, "claude");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude fake v9.9.9');",
      "  process.exit(0);",
      "}",
      "process.stdin.resume();",
      "",
    ].join("\n")
  );
  chmodSync(scriptPath, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0\\claude.js" %*', ""].join("\r\n")
    );
  }
}

function launchEnv(): Record<string, string> {
  return {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
    ANTHROPIC_API_KEY: "e2e-fake-key",
  };
}

// Pins Claude so its toolbar split-button (and preset chevron) renders.
async function setClaudePinned(window: Page, pinned: boolean): Promise<void> {
  await window.evaluate(async (value) => {
    await window.electron.agentSettings.set("claude", { pinned: value } as never);
  }, pinned);
}

test.describe.serial("Presets: Default Preset Selection (53–62)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-preset-default-bin-"));
    writeFakeClaude();
    ctx = await launchApp({ env: launchEnv() });
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-default" });
    fixtureCleanup = () => {
      cleanup();
      removePathSync(fakeBinDir);
    };
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
    fixtureCleanup?.();
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("53. Default preset selector appears in settings", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window); // Need 2 presets for selector to appear
    await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({ timeout: T_MEDIUM });
  });

  test("54. Default preset selector shows Default as default", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window); // Add second preset

    // Re-select Default, then confirm the trigger label reflects the selection.
    await selectPresetByIndex(ctx.window, 0);
    const label = await getSelectedPresetLabel(ctx.window);
    expect(label).toContain("Default");
  });

  test("55. Selector trigger reflects the configured default preset", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);

    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });

    const count = await countPresetOptions(ctx.window);
    expect(count).toBeGreaterThan(1);

    await selectPresetByIndex(ctx.window, 1);

    const firstCustom = await ctx.window
      .locator(SEL.preset.section)
      .locator(SEL.preset.customBadge)
      .first()
      .isVisible();
    expect(firstCustom).toBe(true);

    // The selected non-Default preset is reflected on the trigger label.
    const label = await getSelectedPresetLabel(ctx.window);
    expect(label).not.toContain("Default");
    expect(label.length).toBeGreaterThan(0);
  });

  test("56. Toolbar preset chevron lists the configured preset", async () => {
    await goToClaudeSettings();
    const settingsTrigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(settingsTrigger).toBeVisible({ timeout: T_SHORT });

    // Select a concrete custom preset so the chevron dropdown has a named
    // item to verify against.
    expect(await countPresetOptions(ctx.window)).toBeGreaterThan(1);
    await selectPresetByIndex(ctx.window, 1);
    const presetName = await getSelectedPresetLabel(ctx.window);
    expect(presetName).not.toContain("Default");
    expect(presetName.length).toBeGreaterThan(0);

    // Pin Claude so the toolbar launch button and its preset chevron render,
    // then close settings so the toolbar is reachable.
    await setClaudePinned(ctx.window, true);
    await ctx.window.locator(SEL.settings.closeButton).click();

    const chevron = ctx.window.locator(TOOLBAR_CHEVRON).first();
    await expect(chevron).toBeVisible({ timeout: T_LONG });
    await chevron.click();

    // The toolbar preset rows use menuitem plus a manual default gutter so the
    // configured preset must appear in the launch dropdown.
    const configuredItem = ctx.window.locator('[role="menuitem"]', { hasText: presetName }).first();
    await expect(configuredItem).toBeVisible({ timeout: T_MEDIUM });

    await ctx.window.keyboard.press("Escape");

    // Unpin Claude again so the toolbar launch split-button stops rendering.
    // Left pinned, it re-renders on every CCR config-file poll cycle once
    // test 59 writes a CCR config — that churn races the Add-preset flow and
    // makes addCustomPreset's create-and-persist poll time out. Restoring the
    // pre-pin state (Claude was never pinned before this test) keeps the serial
    // state clean for the later CCR tests.
    await setClaudePinned(ctx.window, false);
  });

  test("57. Selected default preset persists in settings select value", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);

    expect(await countPresetOptions(ctx.window)).toBeGreaterThan(1);
    await selectPresetByIndex(ctx.window, 1);
    const label = await getSelectedPresetLabel(ctx.window);
    expect(label).not.toContain("Default");
    expect(label.length).toBeGreaterThan(0);

    // Re-navigating to the agent settings re-reads persisted state; the same
    // preset must still be the selected one on the trigger.
    await navigateToAgentSettings(ctx.window, "gemini");
    await goToClaudeSettings();
    await expect.poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM }).toBe(label);
  });

  test("58. Default persists after closing and reopening settings", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);

    expect(await countPresetOptions(ctx.window)).toBeGreaterThan(1);
    await selectPresetByIndex(ctx.window, 1);
    const expectedLabel = await getSelectedPresetLabel(ctx.window);
    expect(expectedLabel).not.toContain("Default");
    expect(expectedLabel.length).toBeGreaterThan(0);

    await ctx.window.locator(SEL.settings.closeButton).click();

    await goToClaudeSettings();
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });

    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toBe(expectedLabel);
  });

  test("59. Dropdown includes both CCR and custom presets", async () => {
    writeCcrConfig([{ id: "ccr-default", name: "CCR Default", model: "ccr-default-model" }]);
    await waitForCcrPresets(ctx.window, ["CCR Default"]);

    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await goToClaudeSettings();

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
    await waitForCcrPresetsRemoved(ctx.window, ["CCR Default"]);

    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });
    await expect(ctx.window.locator(SEL.preset.selectorTrigger)).toBeVisible({ timeout: T_SHORT });
  });

  test("62. Setting default on Claude does not affect Gemini agent", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await goToClaudeSettings();

    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });
    expect(await countPresetOptions(ctx.window)).toBeGreaterThan(1);
    await selectPresetByIndex(ctx.window, 1);

    await navigateToAgentSettings(ctx.window, "gemini");
    // Every agent renders a preset section, so the section itself must be
    // visible. The Popover trigger is only present when there are ≥2 mergeable
    // presets; Gemini has none of Claude's custom presets, so it must show at
    // most one option (its own default) — proving per-agent isolation.
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });
    const geminiTrigger = ctx.window.locator(SEL.preset.selectorTrigger);
    const triggerVisible = await geminiTrigger.isVisible({ timeout: T_SHORT }).catch(() => false);
    if (triggerVisible) {
      expect(await countPresetOptions(ctx.window)).toBeLessThanOrEqual(1);
    }
  });
});
