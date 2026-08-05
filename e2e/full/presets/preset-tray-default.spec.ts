import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  navigateToAgentSettings,
  waitForCcrPresets,
  addCustomPreset,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;
let fakeBinDir: string;

/**
 * Tests 101–106: launcher default-launch behavior.
 *
 * A fake `claude` binary is placed on PATH so Claude is detected as a
 * launchable agent and the tray actually renders its split-button — without
 * it the assertions would never run on CI (no real Claude install).
 *
 * These tests verify that:
 * - The tray shows a split-button (submenu trigger) when an agent has presets.
 * - Clicking the left-area text (not the chevron) dispatches a default launch
 *   and closes the tray without opening the submenu.
 * - Hovering the chevron area opens the submenu and lists all presets.
 */
function writeFakeAgent(): void {
  const scriptPath =
    process.platform === "win32"
      ? path.join(fakeBinDir, "claude.js")
      : path.join(fakeBinDir, "claude");
  writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      "console.log('FAKE_CLAUDE_READY pid=' + process.pid);",
      "process.stdout.write('> ');",
      "process.stdin.resume();",
      "const keepAlive = setInterval(() => {}, 1000);",
      "function shutdown() { clearInterval(keepAlive); process.exit(0); }",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(scriptPath, 0o755);

  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
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

test.describe.serial("Presets: Tray Default Launch (101–106)", () => {
  // The open tray is the top-level role=menu that carries the always-present
  // "Manage Agents" item (the nested preset SubContent never has it). Radix's
  // DropdownMenuContent has no accessible name, so identify it by that item
  // rather than by role+name.
  const trayMenu = () => ctx.window.locator('[role="menu"]').filter({ hasText: "Manage Agents" });
  const submenuContent = () => ctx.window.locator('[data-testid="submenu-content"]');
  const claudeSubmenuTrigger = () =>
    trayMenu().locator('[data-testid="submenu-trigger"]', { hasText: "Claude" });

  const closeTray = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const trayOpen = await trayMenu()
        .isVisible({ timeout: 250 })
        .catch(() => false);
      const submenuOpen = await submenuContent()
        .isVisible({ timeout: 250 })
        .catch(() => false);
      if (!trayOpen && !submenuOpen) return;

      await ctx.window.keyboard.press("Escape");
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    await ctx.window.mouse.click(10, 10).catch(() => undefined);
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  const openTray = async () => {
    await closeTray();
    const btn = ctx.window.locator(SEL.agent.trayButton);
    await btn.click();
    await expect(trayMenu()).toBeVisible({ timeout: T_MEDIUM });
  };

  // Opens the tray and waits until Claude renders as a launchable split-button.
  const openTrayWithClaudePresets = async () => {
    await openTray();
    await expect(claudeSubmenuTrigger()).toBeVisible({ timeout: T_MEDIUM });
  };

  test.beforeAll(async () => {
    removeCcrConfig();
    fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-tray-bin-"));
    writeFakeAgent();
    ctx = await launchApp({ env: launchEnv() });
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-tray-default" });
    fixtureCleanup = () => {
      cleanup();
      removePathSync(fakeBinDir);
    };
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Tray Default Test"
    );

    // Gate the whole suite on Claude actually being launchable from the fake
    // binary. A hard failure here (rather than a silent per-test skip) means a
    // broken harness can never masquerade as a passing run.
    await openTray();
    await expect(trayMenu().locator('[data-testid="launcher-row-claude"]')).toBeVisible({
      timeout: T_LONG,
    });
    await closeTray();
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("101. Without presets: Claude appears as a plain menu item (no chevron)", async () => {
    removeCcrConfig();
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTray();

    // Claude is launchable, so it renders as a plain launch row...
    await expect(trayMenu().locator('[data-testid="launcher-row-claude"]')).toBeVisible({
      timeout: T_MEDIUM,
    });
    // ...and with no presets there must be no split-button submenu trigger.
    await expect(claudeSubmenuTrigger()).toHaveCount(0);

    await closeTray();
  });

  test("102. With CCR presets: Claude appears as a split-button (submenu trigger)", async () => {
    writeCcrConfig([
      { id: "tray-a", name: "Tray Model A", model: "tray-model-a" },
      { id: "tray-b", name: "Tray Model B", model: "tray-model-b" },
    ]);
    await waitForCcrPresets(ctx.window, ["Tray Model A", "Tray Model B"]);
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTray();

    await expect(claudeSubmenuTrigger()).toBeVisible({ timeout: T_MEDIUM });

    await closeTray();
  });

  test("103. Hovering the chevron area opens the submenu", async () => {
    await openTrayWithClaudePresets();

    // Hover the trigger to open the submenu.
    await claudeSubmenuTrigger().hover();
    await expect(submenuContent()).toBeVisible({ timeout: T_MEDIUM });

    // "Default" is the first item — its position is a deliberate contract
    // (the default-launch radio always leads the preset list).
    const items = submenuContent().locator('[role^="menuitem"]');
    await expect(items.first()).toContainText(/default/i, { timeout: T_MEDIUM });

    await closeTray();
  });

  test("104. Submenu lists all available CCR presets", async () => {
    await openTrayWithClaudePresets();

    await claudeSubmenuTrigger().hover();
    await expect(submenuContent()).toBeVisible({ timeout: T_MEDIUM });

    const items = submenuContent().locator('[role^="menuitem"]');
    await expect
      .poll(async () => (await items.allTextContents()).map((t) => t.trim()), { timeout: T_MEDIUM })
      .toEqual(
        expect.arrayContaining([
          expect.stringContaining("Tray Model A"),
          expect.stringContaining("Tray Model B"),
        ])
      );

    await closeTray();
  });

  test("105. Clicking agent name (left area) closes tray without opening submenu", async () => {
    await openTrayWithClaudePresets();

    // Click the left-area span (text + icon, NOT the chevron).
    const leftArea = claudeSubmenuTrigger().locator("span").first();
    await leftArea.click({ force: true, noWaitAfter: true });

    // Tray dropdown should be gone.
    await expect(trayMenu()).not.toBeVisible({ timeout: T_MEDIUM });

    // Submenu content should never have opened.
    await expect(submenuContent()).toHaveCount(0);
  });

  test("106. Tray submenu also shows custom presets alongside CCR presets", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTrayWithClaudePresets();

    await claudeSubmenuTrigger().hover();
    await expect(submenuContent()).toBeVisible({ timeout: T_MEDIUM });

    const items = submenuContent().locator('[role^="menuitem"]');
    const texts = await items.allTextContents();
    // Default + 2 CCR + 1 custom = at least 4 items...
    expect(texts.length).toBeGreaterThanOrEqual(4);
    // ...and the custom preset must appear by name, not just inflate the count.
    // addCustomPreset() creates a blank preset named "New preset" (AddPresetDialog
    // default); the direct-persist fallback names it "Custom Preset N".
    expect(texts.some((t) => /New preset|Custom Preset/i.test(t))).toBe(true);
    expect(texts.some((t) => t.includes("Tray Model A"))).toBe(true);

    await closeTray();
  });
});
