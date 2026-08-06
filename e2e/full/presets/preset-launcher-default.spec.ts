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
  // The launcher is a search-first popover now (#11691), not a Radix menu: it is
  // the dialog named after its own header, and every row is an option in one
  // flat list — presets included, once their agent is expanded.
  const launcher = () => ctx.window.getByRole("dialog", { name: "Launch" });
  const search = () =>
    ctx.window.getByRole("combobox", { name: "Search agents, panels, and recipes" });
  const claudeRow = () => launcher().locator('[role="option"][aria-label^="Claude,"]');
  const claudeExpandable = () =>
    launcher().locator(
      '[role="option"][data-row-kind="item"][aria-expanded][aria-label^="Claude,"]'
    );
  const presetRows = () => launcher().locator(SEL.preset.trayLaunchPresetItem);

  const closeTray = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const open = await launcher()
        .isVisible({ timeout: 250 })
        .catch(() => false);
      if (!open) return;
      // Two presses: the first spends itself clearing a non-empty query.
      await ctx.window.keyboard.press("Escape");
      await ctx.window.keyboard.press("Escape");
      await ctx.window.waitForTimeout(T_SETTLE);
    }

    await ctx.window.mouse.click(10, 10).catch(() => undefined);
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  // Opens the launcher and narrows to Claude, so the row under test is the only
  // agent in the list regardless of what else is installed.
  const openTray = async () => {
    await closeTray();
    await ctx.window.locator(SEL.agent.trayButton).click();
    await expect(launcher()).toBeVisible({ timeout: T_MEDIUM });
    await expect(search()).toBeVisible({ timeout: T_MEDIUM });
    await search().fill("Claude");
    await expect(claudeRow().first()).toBeVisible({ timeout: T_MEDIUM });
  };

  // Opens the launcher and expands Claude's presets into sibling rows.
  const openTrayWithClaudePresets = async () => {
    await openTray();
    await expect(claudeExpandable()).toBeVisible({ timeout: T_MEDIUM });
    await search().press("ArrowRight");
    await expect(presetRows().first()).toBeVisible({ timeout: T_MEDIUM });
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
    await ctx.window.locator(SEL.agent.trayButton).click();
    await expect(launcher()).toBeVisible({ timeout: T_LONG });
    await search().fill("Claude");
    await expect(claudeRow().first()).toBeVisible({ timeout: T_LONG });
    await closeTray();
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("101. Without presets: Claude appears as a plain row (no disclosure)", async () => {
    removeCcrConfig();
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTray();

    // Claude is launchable, so it renders as a plain launch row...
    await expect(claudeRow().first()).toBeVisible({ timeout: T_MEDIUM });
    // ...and with no presets it must not advertise anything to expand.
    await expect(claudeExpandable()).toHaveCount(0);

    await closeTray();
  });

  test("102. With CCR presets: Claude's row advertises an expandable preset list", async () => {
    writeCcrConfig([
      { id: "tray-a", name: "Tray Model A", model: "tray-model-a" },
      { id: "tray-b", name: "Tray Model B", model: "tray-model-b" },
    ]);
    await waitForCcrPresets(ctx.window, ["Tray Model A", "Tray Model B"]);
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTray();

    await expect(claudeExpandable()).toBeVisible({ timeout: T_MEDIUM });

    await closeTray();
  });

  test("103. Right Arrow expands the preset list in place", async () => {
    await openTrayWithClaudePresets();

    // "Default" leads the preset list — its position is a deliberate contract.
    await expect(presetRows().first()).toContainText(/default/i, { timeout: T_MEDIUM });
    // The expansion is announced on the row it belongs to.
    await expect(claudeExpandable()).toHaveAttribute("aria-expanded", "true");

    await closeTray();
  });

  test("104. The expansion lists all available CCR presets", async () => {
    await openTrayWithClaudePresets();

    const items = presetRows();
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

  test("105. Activating the agent row launches without expanding its presets", async () => {
    await openTray();
    await expect(claudeExpandable()).toBeVisible({ timeout: T_MEDIUM });

    // The row itself launches the default — expanding is Right Arrow's job, so
    // a plain activation must never open the list first.
    await claudeRow().first().click({ force: true, noWaitAfter: true });

    await expect(launcher()).not.toBeVisible({ timeout: T_MEDIUM });
    await expect(presetRows()).toHaveCount(0);
  });

  test("106. The expansion also shows custom presets alongside CCR presets", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);
    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await openTrayWithClaudePresets();

    const items = presetRows();
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
