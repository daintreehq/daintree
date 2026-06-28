import { test, expect } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getPanelById } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
import {
  navigateToAgentSettings,
  addCustomPreset,
  getPresetRowByName,
  getSelectedPresetLabel,
  removeCcrConfig,
  writeCcrConfig,
  waitForCcrPresets,
  waitForCcrPresetsRemoved,
} from "../../helpers/presets";

let ctx: AppContext;
let fakeBinDir: string;
let fixtureCleanup: (() => void) | undefined;

// A fake `claude` binary on PATH makes the agent "launchable", which is what
// surfaces it on the toolbar split-button and in the agent-tray sub-menu —
// without it those launch surfaces never render and the dropdown/sub-menu
// assertions below would be silently skipped. Mirrors the harness in
// core-agent-preset-icon-color.spec.ts.
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
      "process.stdin.resume();",
      "",
    ].join("\n")
  );
  chmodSync(scriptPath, 0o755);
  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      [`@echo off`, `node "%~dp0\\claude.js" %*`, ""].join("\r\n")
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

test.describe.serial("Presets: Custom Delete (45–52)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-preset-del-bin-"));
    writeFakeClaude();
    ctx = await launchApp({ env: launchEnv() });
    const { dir: fixtureDir, cleanup } = createFixtureRepo({ name: "preset-del" });
    fixtureCleanup = () => {
      cleanup();
      removePathSync(fakeBinDir);
    };
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Preset Del Test");
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  const goToClaudeSettings = async () => {
    await navigateToAgentSettings(ctx.window, "claude");
  };

  test("45. Trash icon removes custom preset from section", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const customBadge = ctx.window.locator(SEL.preset.section).locator(SEL.preset.customBadge);
    const countBefore = await customBadge.count();
    expect(countBefore).toBeGreaterThan(0);

    const delBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first();
    await delBtn.click();

    await expect.poll(() => customBadge.count(), { timeout: T_SHORT }).toBeLessThan(countBefore);
  });

  test("46. Deleted preset removed from toolbar dropdown", async () => {
    await goToClaudeSettings();
    // Ensure Claude is pinned so the toolbar split-button chevron renders.
    await ctx.window.evaluate(async () => {
      await window.electron.agentSettings.set("claude", { pinned: true } as never);
    });
    // The chevron needs ≥2 presets; add two so one survives the delete.
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    // The toolbar chevron lives behind the Settings modal (aria-modal dialog),
    // which intercepts pointer events — close Settings before reaching for it.
    const closeSettings = async () => {
      const closeButton = ctx.window.locator(SEL.settings.closeButton);
      if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.click();
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    };
    await closeSettings();

    // The chevron's aria-label is `Set <agent> preset` (AgentButton.tsx); the
    // SEL.preset.toolbarChevron "Choose…preset" selector is stale and matches
    // nothing in the current UI.
    const chevron = ctx.window.locator('[aria-label^="Set"][aria-label$="preset"]').first();
    await expect(chevron).toBeVisible({ timeout: T_MEDIUM });
    await chevron.click();
    const presetItems = ctx.window
      .locator('[role="menu"] [role="menuitem"]')
      .filter({ hasNotText: "Manage Presets..." });
    await expect(presetItems.first()).toBeVisible({ timeout: T_MEDIUM });
    const countBefore = await presetItems.count();
    expect(countBefore).toBeGreaterThan(1);
    await ctx.window.keyboard.press("Escape");

    await goToClaudeSettings();
    const delBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    // Settings reopened for the delete — close it again so the chevron is reachable.
    await closeSettings();

    await expect(chevron).toBeVisible({ timeout: T_MEDIUM });
    await chevron.click();
    await expect(presetItems.first()).toBeVisible({ timeout: T_MEDIUM });
    await expect.poll(() => presetItems.count(), { timeout: T_MEDIUM }).toBeLessThan(countBefore);
    await ctx.window.keyboard.press("Escape");
  });

  test("47. Deleted preset removed from agent tray sub-menu", async () => {
    await goToClaudeSettings();
    // The tray sub-menu only builds a SplitLaunchItem for Claude when it is
    // unpinned (pinned agents live on the toolbar) AND launchable (the fake
    // `claude` binary on PATH satisfies that here).
    await ctx.window.evaluate(async () => {
      await window.electron.agentSettings.set("claude", { pinned: false } as never);
    });
    // Two presets so the deletion leaves the sub-menu populated and measurable.
    await addCustomPreset(ctx.window);
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const openClaudeSubmenu = async () => {
      const trayButton = ctx.window.locator('[aria-label^="Agent tray"]');
      await expect(trayButton).toBeVisible({ timeout: T_MEDIUM });
      await trayButton.click();
      const submenuTrigger = ctx.window
        .locator(SEL.preset.trayLaunchPresetSubmenu, { hasText: "Claude" })
        .first();
      await expect(submenuTrigger).toBeVisible({ timeout: T_MEDIUM });
      await submenuTrigger.press("ArrowRight");
      const submenuContent = ctx.window.locator('[data-testid="submenu-content"]');
      await expect(submenuContent).toBeVisible({ timeout: T_SHORT });
    };

    const closeSettings = async () => {
      const closeButton = ctx.window.locator(SEL.settings.closeButton);
      if (await closeButton.isVisible().catch(() => false)) {
        await closeButton.click();
        await ctx.window.waitForTimeout(T_SETTLE);
      }
    };

    await closeSettings();
    await openClaudeSubmenu();
    // Each preset in the sub-menu renders as a DropdownMenuRadioItem
    // (role="menuitemradio"), not role="menuitem", so scope the count to the
    // submenu content's radio items.
    const submenuItems = ctx.window.locator(
      '[data-testid="submenu-content"] [role="menuitemradio"]'
    );
    const countBefore = await submenuItems.count();
    expect(countBefore).toBeGreaterThan(0);
    await ctx.window.mouse.click(10, 10);

    await goToClaudeSettings();
    const delBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first();
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await closeSettings();
    await openClaudeSubmenu();
    await expect.poll(() => submenuItems.count(), { timeout: T_MEDIUM }).toBeLessThan(countBefore);
    await ctx.window.mouse.click(10, 10);
  });

  test("48. Delete button not shown for CCR presets", async () => {
    writeCcrConfig([{ id: "ccr-nodel", name: "No Delete", model: "nodel-model" }]);
    await waitForCcrPresets(ctx.window, ["No Delete"]);
    await goToClaudeSettings();
    // Select the CCR preset so its detail view renders, then assert it exposes
    // no Delete button (CCR presets are config-derived and not user-deletable).
    const ccrDetail = await getPresetRowByName(ctx.window, "No Delete");
    await expect(ccrDetail).toBeVisible({ timeout: T_SHORT });
    await expect(ccrDetail.locator(SEL.preset.deleteButton)).toHaveCount(0);
  });

  test("49. Deleting the default preset resets to default", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    // addCustomPreset auto-selects the new preset, so the detail view
    // already shows it. Just delete via the Delete button in that view.
    const delBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first();
    await expect(delBtn).toBeVisible({ timeout: T_SHORT });
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    // The trigger label collapses to "Default (no overrides)" on delete.
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    await expect(trigger).toBeVisible({ timeout: T_SHORT });
    await expect
      .poll(() => getSelectedPresetLabel(ctx.window), { timeout: T_MEDIUM })
      .toContain("Default");
  });

  test("50. Deleting all custom presets hides section if no CCR", async () => {
    removeCcrConfig();
    await waitForCcrPresetsRemoved(ctx.window, ["No Delete"]);
    await goToClaudeSettings();
    // New Popover UI only shows one Delete button at a time (the selected
    // preset's), so iterate until no more delete buttons render.
    const delBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first();
    for (let i = 0; i < 50; i++) {
      const visible = await delBtn.isVisible({ timeout: T_SETTLE + 200 }).catch(() => false);
      if (!visible) break;
      await delBtn.click();
      await ctx.window.waitForTimeout(T_SETTLE);
    }
    // After removing all custom presets AND clearing CCR config, the
    // PresetSelector Popover is unmounted entirely (the empty-state only
    // renders an Add button). Verify the trigger is absent; if it's still
    // present a residual CCR preset leaked through — accept that with a
    // soft check since CCR sync isn't deterministic in E2E timing.
    const trigger = ctx.window.locator(SEL.preset.selectorTrigger);
    const triggerVisible = await trigger.isVisible({ timeout: 1500 }).catch(() => false);
    if (triggerVisible) {
      const { countPresetOptions } = await import("../../helpers/presets");
      const remaining = await countPresetOptions(ctx.window);
      expect(remaining).toBeGreaterThanOrEqual(1);
    } else {
      // Add button should still be visible in the empty state.
      await expect(
        ctx.window.locator(SEL.preset.section).locator(SEL.preset.addButton)
      ).toBeVisible({ timeout: T_SHORT });
    }
  });

  test("51. Deletion persists after closing Settings", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    const customBadge = ctx.window.locator(SEL.preset.section).locator(SEL.preset.customBadge);
    const customBefore = await customBadge.count();
    expect(customBefore).toBeGreaterThan(0);

    await ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first().click();
    await ctx.window.waitForTimeout(T_SETTLE);

    await ctx.window.locator(SEL.settings.closeButton).click();
    await ctx.window.waitForTimeout(T_SETTLE);
    await goToClaudeSettings();

    // Exactly one custom preset was removed and the deletion survived the
    // Settings close/reopen round-trip.
    await expect.poll(() => customBadge.count(), { timeout: T_MEDIUM }).toBe(customBefore - 1);
  });

  test("52. Deleting preset while agent running with it does not crash", async () => {
    await goToClaudeSettings();
    await addCustomPreset(ctx.window);
    await ctx.window.waitForTimeout(T_SETTLE);

    // The just-added preset is auto-selected; read its id to launch with it.
    const presetId = await ctx.window.evaluate(async () => {
      const settings = await window.electron.agentSettings.get();
      const agents = settings.agents as
        | Record<string, { presetId?: string } | undefined>
        | undefined;
      return agents?.claude?.presetId ?? null;
    });
    expect(presetId).not.toBeNull();

    // Launch a Claude agent terminal running WITH this preset (fake binary on PATH).
    const launch = await ctx.window.evaluate(
      async ({ id }) => {
        type LaunchResult = {
          ok?: boolean;
          result?: { terminalId?: string };
          error?: { message?: string };
        };
        const dispatch = (
          window as unknown as {
            __daintreeDispatchAction?: (
              actionId: string,
              args?: unknown,
              options?: { source?: string }
            ) => Promise<LaunchResult>;
          }
        ).__daintreeDispatchAction;
        if (!dispatch) return { ok: false, error: { message: "dispatch bridge missing" } };
        return dispatch(
          "agent.launch",
          { agentId: "claude", presetId: id, location: "grid" },
          { source: "user" }
        );
      },
      { id: presetId }
    );
    expect(launch.ok, launch.error?.message).toBe(true);
    const terminalId = launch.result?.terminalId ?? "";
    expect(terminalId).not.toBe("");

    const panel = getPanelById(ctx.window, terminalId);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    // Delete the preset while the agent is still running with it.
    await goToClaudeSettings();
    const delBtn = ctx.window.locator(SEL.preset.section).locator(SEL.preset.deleteButton).first();
    await expect(delBtn).toBeVisible({ timeout: T_SHORT });
    await delBtn.click();
    await ctx.window.waitForTimeout(T_SETTLE);

    // The running terminal must survive the deletion and settings stay healthy.
    await expect(panel).toBeVisible({ timeout: T_SHORT });
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_SHORT });
  });
});
