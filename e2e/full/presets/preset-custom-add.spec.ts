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
  removeCcrConfig,
  waitForCcrPresets,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
let fakeBinDir: string;

// A fake `claude` binary on PATH makes Claude `launchable`, which is the
// precondition for the toolbar split-button chevron and the agent-tray
// submenu trigger to render. Without it those surfaces never mount and the
// tests asserting them would silently pass.
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

async function setClaudePinned(window: Page, pinned: boolean): Promise<void> {
  await window.evaluate(async (value) => {
    await window.electron.agentSettings.set("claude", { pinned: value } as never);
  }, pinned);
}

async function getClaudeCustomPresetCount(window: Page): Promise<number> {
  return window.evaluate(async () => {
    const settings = await window.electron.agentSettings.get();
    const agents = settings.agents as
      | Record<string, { customPresets?: unknown[] } | undefined>
      | undefined;
    const entry = agents?.claude;
    return Array.isArray(entry?.customPresets) ? entry.customPresets.length : 0;
  });
}

test.describe.serial("Presets: Custom Add (13–24)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-preset-bin-"));
    writeFakeClaude();
    ctx = await launchApp({ env: launchEnv() });
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-add" });
    fixtureCleanup = () => {
      cleanup();
      removePathSync(fakeBinDir);
    };
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Add Test");
    // Pin Claude so the toolbar split-button renders for test 14.
    await setClaudePinned(ctx.window, true);
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("13. Clicking Add creates a new custom preset", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: "New preset" }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("14. New custom preset appears in toolbar split-button", async () => {
    await setClaudePinned(ctx.window, true);
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);

    // Close settings so the toolbar split-button is reachable. The chevron's
    // label is the launchable-state tooltip ("Set Claude preset"); the stale
    // SEL.preset.toolbarChevron selector matches nothing in the current UI.
    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
    }

    const chevron = ctx.window.locator('[aria-label="Set Claude preset"]');
    await expect(chevron).toBeVisible({ timeout: T_LONG });
    await chevron.click();
    const dropdown = ctx.window.locator('[role="menu"]');
    await expect(dropdown).toBeVisible({ timeout: T_MEDIUM });
    await expect(dropdown.getByText("New preset").first()).toBeVisible({ timeout: T_SHORT });
    await ctx.window.keyboard.press("Escape");
  });

  test("15. New custom preset appears in agent tray sub-menu", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window); // Add second preset for submenu to appear
    await ctx.window.waitForTimeout(T_SETTLE);

    // Submenu-trigger rows render in the tray only for unpinned, launchable
    // agents. The fake `claude` binary on PATH (beforeAll) makes Claude
    // launchable; unpin it here so the tray builds a SplitLaunchItem rather
    // than routing Claude to the main toolbar.
    await setClaudePinned(ctx.window, false);

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
    }

    const trayButton = ctx.window.locator('[aria-label^="Agent tray"]');
    await trayButton.click();
    const submenuTrigger = ctx.window.locator('[data-testid="submenu-trigger"]', {
      hasText: "Claude",
    });
    await expect(submenuTrigger).toBeVisible({ timeout: T_LONG });
    await submenuTrigger.press("ArrowRight");
    const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
    await expect(submenuContent).toBeVisible({ timeout: T_SHORT });
    // Preset name renders as a text node inside DropdownMenuItem (not inside
    // a span). Use getByText so the matcher walks both nodes and spans.
    await expect(submenuContent.getByText("New preset").first()).toBeVisible({
      timeout: T_SHORT,
    });

    await ctx.window.mouse.click(10, 10);
    await setClaudePinned(ctx.window, true);
  });

  test("16. Custom preset shows 'custom' badge", async () => {
    await goToClaudeSettings();
    const customBadge = ctx.window.locator(SEL.preset.section).locator(SEL.preset.customBadge);
    const count = await customBadge.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("17. Add preset works when no CCR presets exist", async () => {
    removeCcrConfig();
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("18. Adding multiple presets creates distinct entries", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window);
    const { countPresetOptions } = await import("../../helpers/presets");
    const count = await countPresetOptions(ctx.window);
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test("19. Added preset persists after closing and reopening Settings", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const name = "New preset";
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: name }).first()
    ).toBeVisible({
      timeout: T_SHORT,
    });
    const countBefore = await getClaudeCustomPresetCount(ctx.window);
    expect(countBefore).toBeGreaterThanOrEqual(1);

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    await closeButton.click();
    await expect(closeButton).not.toBeVisible({ timeout: T_MEDIUM });

    await goToClaudeSettings();
    // Persistence: the reopened settings must still render the named preset and
    // the persisted custom-preset count must not have dropped.
    await expect(
      ctx.window.locator(SEL.preset.section).locator("span", { hasText: name }).first()
    ).toBeVisible({ timeout: T_SHORT });
    await expect
      .poll(() => getClaudeCustomPresetCount(ctx.window), { timeout: T_MEDIUM })
      .toBeGreaterThanOrEqual(countBefore);
  });

  test("20. Preset with empty env is valid", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const lastRow = ctx.window.locator(SEL.preset.section).locator(SEL.preset.customBadge).last();
    await expect(lastRow).toBeVisible({ timeout: T_SHORT });
  });

  test("21. Add then delete leaves no orphan", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    const presetsBefore = await getClaudeCustomPresetCount(ctx.window);
    expect(presetsBefore).toBeGreaterThanOrEqual(1);

    const deleteButtons = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton);
    await expect(deleteButtons.first()).toBeVisible({ timeout: T_MEDIUM });
    ctx.window.once("dialog", (dialog) => dialog.accept());
    await deleteButtons.last().click();

    // No orphan: the persisted custom-preset count drops by exactly one and the
    // section still renders (didn't crash or vanish).
    await expect
      .poll(() => getClaudeCustomPresetCount(ctx.window), { timeout: T_MEDIUM })
      .toBe(presetsBefore - 1);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
  });

  test("22. Add button visible alongside CCR presets", async () => {
    const { writeCcrConfig } = await import("../../helpers/presets");
    writeCcrConfig([{ id: "ccr-adj", name: "CCR Adj", model: "adj-model" }]);
    await waitForCcrPresets(ctx.window, ["CCR Adj"]);
    await goToClaudeSettings();
    await expect(ctx.window.locator(SEL.preset.section).locator(SEL.preset.addButton)).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("23. Adding preset to Claude does not affect Gemini", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await navigateToAgentSettings(ctx.window, "gemini");
    const geminiCustomBadges = ctx.window
      .locator(SEL.preset.section)
      .locator(SEL.preset.customBadge);
    const count = await geminiCustomBadges.count();
    expect(count).toBe(0);
  });

  test("24. Add preset works when agent is not pinned", async () => {
    // Enter the unpinned scenario the test name promises by driving the actual
    // toggle. A direct `agentSettings.set` IPC write doesn't update the
    // renderer store the settings UI reads from, so the toggle must be clicked
    // to flip both store and persisted state.
    await goToClaudeSettings();
    const pinToggle = ctx.window.locator("#agents-enable button");
    await expect(pinToggle).toBeVisible({ timeout: T_MEDIUM });
    if ((await pinToggle.getAttribute("aria-checked")) === "true") {
      await pinToggle.click();
    }
    await expect(pinToggle).toHaveAttribute("aria-checked", "false", { timeout: T_MEDIUM });

    const countBefore = await getClaudeCustomPresetCount(ctx.window);
    await addCustomPreset(ctx.window);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_SHORT });
    await expect
      .poll(() => getClaudeCustomPresetCount(ctx.window), { timeout: T_MEDIUM })
      .toBe(countBefore + 1);
    await setClaudePinned(ctx.window, true);
  });
});
