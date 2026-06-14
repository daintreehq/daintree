import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
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

test.describe.serial("Presets: Context Menu Integration (93–96)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-preset-ctx-bin-"));
    writeFakeClaude();
    ctx = await launchApp({ env: launchEnv() });
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-ctx-menu" });
    fixtureCleanup = () => {
      cleanup();
      removePathSync(fakeBinDir);
    };
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Context Menu Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const claudeToolbarButton = () =>
    ctx.window
      .getByRole("toolbar", { name: "Main toolbar" })
      .locator('[data-toolbar-button-id="claude"]')
      .getByRole("button", { name: /^Start Claude/i })
      .first();

  const rightClickClaudeToolbar = async () => {
    const button = claudeToolbarButton();
    await expect(button).toBeVisible({ timeout: T_LONG });
    await button.click({ button: "right" });
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  const openPresetSubmenu = async () => {
    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    await expect(contextMenu.getByText(/Launch with Preset/i)).toBeVisible({ timeout: T_MEDIUM });
    const presetTrigger = contextMenu.getByText(/Launch with Preset/i);
    await presetTrigger.hover();
    const submenuContent = ctx.window.locator('[data-testid="context-submenu-content"]');
    await expect(submenuContent).toBeVisible({ timeout: T_MEDIUM });
    return submenuContent;
  };

  const dismissContextMenu = async () => {
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);
  };

  test("93. Right-click Claude toolbar shows 'Launch with Preset' submenu", async () => {
    writeCcrConfig([
      { id: "ctx-a", name: "Ctx Model A", model: "ctx-model-a" },
      { id: "ctx-b", name: "Ctx Model B", model: "ctx-model-b" },
    ]);
    await waitForCcrPresets(ctx.window, ["Ctx Model A", "Ctx Model B"]);
    await ctx.window.keyboard.press("Escape");
    await ctx.window.waitForTimeout(T_SETTLE);

    await rightClickClaudeToolbar();

    const contextMenu = ctx.window.locator(SEL.contextMenu.content);
    await expect(contextMenu).toBeVisible({ timeout: T_MEDIUM });
    await expect(contextMenu.getByText(/Launch with Preset/i)).toBeVisible({ timeout: T_SHORT });

    await dismissContextMenu();
  });

  test("94. Context menu submenu lists all CCR and custom presets", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await rightClickClaudeToolbar();
    const submenuContent = await openPresetSubmenu();

    const labels = await submenuContent.locator('[role^="menuitem"]').allTextContents();
    const normalized = labels.map((l) => l.trim());
    // "Agent default" + 2 CCR presets + 1 custom preset = at least 4 items.
    // A blank custom preset is named "New preset" via AddPresetDialog; the
    // direct-persist fallback in addCustomPreset names it "Custom Preset N".
    expect(normalized.length).toBeGreaterThanOrEqual(4);
    expect(normalized).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Agent default"),
        expect.stringContaining("Ctx Model A"),
        expect.stringContaining("Ctx Model B"),
        expect.stringMatching(/New preset|Custom Preset/),
      ])
    );

    await dismissContextMenu();
  });

  test("95. Click a preset from context menu — no crash, panel opens", async () => {
    await rightClickClaudeToolbar();
    const submenuContent = await openPresetSubmenu();

    const presetItem = submenuContent
      .locator('[role^="menuitem"]')
      .filter({ hasText: "Ctx Model A" })
      .first();
    await expect(presetItem).toBeVisible({ timeout: T_MEDIUM });
    await presetItem.click();

    const agentPanel = ctx.window.locator(
      '[aria-label^="Claude agent:"], [aria-label^="Claude Agent"]'
    );
    await expect(agentPanel.first()).toBeVisible({ timeout: T_LONG });

    await dismissContextMenu();
  });

  test("96. Checkmark or highlight next to currently saved default preset", async () => {
    // Pin the agent-level default to a known CCR preset so the submenu's
    // RadioGroup `value` (resolveEffectivePresetId → entry.presetId) is
    // deterministic. Clear worktreePresets too — test 95's launch may have
    // persisted a worktree-scoped pick that would otherwise win the resolve.
    const setResult = await ctx.window.evaluate(async () => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            id: string,
            args?: unknown,
            options?: { source?: string }
          ) => Promise<{ ok?: boolean; error?: { message?: string } }>;
        }
      ).__daintreeDispatchAction;
      if (!dispatch) return { ok: false, error: { message: "dispatch bridge missing" } };
      return dispatch(
        "agentSettings.set",
        { agentId: "claude", settings: { presetId: "ccr-ctx-b", worktreePresets: {} } },
        { source: "test" }
      );
    });
    expect(setResult.ok, setResult.error?.message).toBe(true);

    await rightClickClaudeToolbar();
    const submenuContent = await openPresetSubmenu();

    const checkedItems = submenuContent.locator('[role^="menuitem"][aria-checked="true"]');
    await expect(checkedItems).toHaveCount(1, { timeout: T_MEDIUM });
    await expect(checkedItems.first()).toContainText("Ctx Model B");

    await dismissContextMenu();
  });
});
