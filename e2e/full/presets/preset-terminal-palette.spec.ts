import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import {
  writeCcrConfig,
  removeCcrConfig,
  navigateToAgentSettings,
  waitForCcrPresets,
  addCustomPreset,
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir = "";
let fixtureCleanup: (() => void) | undefined;

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "preset-palette" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-preset-palette-bin-"));

  const fakeClaude = path.join(fakeBinDir, "claude");
  const fakeClaudeJs = path.join(fakeBinDir, "claude.js");
  const fakeClaudeCmd = path.join(fakeBinDir, "claude.cmd");
  writeFileSync(
    fakeClaude,
    ["#!/bin/sh", `exec '${process.execPath}' "$(dirname "$0")/claude.js" "$@"`, ""].join("\n")
  );
  writeFileSync(
    fakeClaudeJs,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      "console.log('claude code v9.9.9');",
      "console.log('FAKE_CLAUDE_READY pid=' + process.pid);",
      "process.stdout.write('> ');",
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "const keepAlive = setInterval(() => {}, 1000);",
      "function shutdown() { clearInterval(keepAlive); process.exit(0); }",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(fakeClaude, 0o755);
  writeFileSync(fakeClaudeCmd, `@echo off\r\n"${process.execPath}" "%~dp0\\claude.js" %*\r\n`);
}

/**
 * Open the new-terminal palette via its dedicated event — it has no production
 * keyboard/toolbar trigger (see useAppEventListeners) — and wait for the dialog
 * to actually render before returning.
 */
async function openNewTerminalPalette(page: Page) {
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("daintree:open-new-terminal-palette"))
  );
  const dialog = page.locator(SEL.newTerminalPalette.dialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  return dialog;
}

async function closeNewTerminalPalette(page: Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator(SEL.newTerminalPalette.dialog)).not.toBeVisible({ timeout: T_MEDIUM });
}

test.describe.serial("Presets: Terminal Palette Integration (89–92)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    prepareFixture();
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
        ANTHROPIC_API_KEY: "e2e-fake-key",
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Palette Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
    if (fakeBinDir) removePathSync(fakeBinDir);
  });

  test("89. New terminal palette lists the installed Claude agent option", async () => {
    writeCcrConfig([
      { id: "pal-a", name: "Palette Model A", model: "pal-model-a" },
      { id: "pal-b", name: "Palette Model B", model: "pal-model-b" },
    ]);
    await waitForCcrPresets(ctx.window, ["Palette Model A", "Palette Model B"]);
    await ctx.window.locator(SEL.settings.closeButton).click();
    await expect(ctx.window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_MEDIUM });

    const dialog = await openNewTerminalPalette(ctx.window);

    const claudeOption = dialog.locator("#new-terminal-option-claude");
    await expect(claudeOption).toBeVisible({ timeout: T_MEDIUM });
    await expect(claudeOption).toContainText(/Claude/i);

    await closeNewTerminalPalette(ctx.window);
  });

  test("90. Palette always lists the plain terminal and browser launch options", async () => {
    const dialog = await openNewTerminalPalette(ctx.window);

    await expect(dialog.locator(SEL.newTerminalPalette.terminalOption)).toBeVisible({
      timeout: T_MEDIUM,
    });
    await expect(dialog.locator(SEL.newTerminalPalette.browserOption)).toBeVisible({
      timeout: T_SHORT,
    });

    // The palette advertises agent launch options, not CCR/custom preset
    // counts — assert no option misleadingly claims a preset count in its row.
    await expect(dialog.locator(SEL.newTerminalPalette.options).getByText(/preset/i)).toHaveCount(
      0
    );

    await closeNewTerminalPalette(ctx.window);
  });

  test("91. Launching Claude from the palette spawns a panel and closes the dialog", async () => {
    const dialog = await openNewTerminalPalette(ctx.window);

    const claudeOption = dialog.locator("#new-terminal-option-claude");
    await expect(claudeOption).toBeVisible({ timeout: T_MEDIUM });
    await claudeOption.click();

    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    const claudePanel = ctx.window.locator(`${SEL.panel.gridPanel}[data-launch-agent-id="claude"]`);
    await expect(claudePanel.first()).toBeVisible({ timeout: T_LONG });
  });

  test("92. Adding custom presets keeps Claude launchable from the palette", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await expect(ctx.window.locator(SEL.settings.heading)).not.toBeVisible({ timeout: T_MEDIUM });

    const dialog = await openNewTerminalPalette(ctx.window);

    const claudeOption = dialog.locator("#new-terminal-option-claude");
    await expect(claudeOption).toBeVisible({ timeout: T_MEDIUM });
    await claudeOption.click();

    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    const claudePanels = ctx.window.locator(
      `${SEL.panel.gridPanel}[data-launch-agent-id="claude"]`
    );
    await expect
      .poll(() => claudePanels.count(), { timeout: T_LONG, intervals: [100, 250, 500] })
      .toBeGreaterThanOrEqual(1);
  });
});
