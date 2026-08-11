import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
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
} from "../../helpers/presets";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;
let fixtureCleanup: (() => void) | undefined;

// The settings-side chevron uses `Set <agent> preset`; the shared
// SEL.preset.toolbarChevron (`Choose…preset`) does not match the current
// AgentButton aria-label, so anchor the toolbar split-button chevron locally.
const TOOLBAR_CHEVRON = '[aria-label="Set Claude preset"]';

// Write a fake `claude` binary onto the launch PATH so Claude resolves as a
// launchable agent. Without it the toolbar split-button and tray submenu
// trigger never render and the preset-sync assertions cannot run.
function writeFakeClaude(): void {
  fakeBinDir = path.join(fixtureDir, ".e2e-bin");
  mkdirSync(fakeBinDir, { recursive: true });
  const implName = process.platform === "win32" ? "claude.js" : "claude";
  const impl = path.join(fakeBinDir, implName);
  writeFileSync(
    impl,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude fake v9.9.9');",
      "  process.exit(0);",
      "}",
      "console.log('FAKE_CLAUDE_READY pid=' + process.pid);",
      "process.stdin.resume();",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n")
  );
  chmodSync(impl, 0o755);
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

interface DispatchResult {
  ok?: boolean;
  error?: { message?: string };
}

async function pinClaude(page: Page): Promise<void> {
  const result = await page.evaluate(async () => {
    type Dispatch = (
      actionId: string,
      args?: unknown,
      options?: { source?: string }
    ) => Promise<DispatchResult>;
    const dispatch = (window as unknown as { __daintreeDispatchAction?: Dispatch })
      .__daintreeDispatchAction;
    if (!dispatch) return { ok: false, error: { message: "dispatch bridge missing" } };
    return dispatch(
      "agentSettings.set",
      { agentId: "claude", settings: { pinned: true } },
      {
        source: "test",
      }
    );
  });
  expect(result.ok, result.error?.message).toBe(true);
}

test.describe.serial("Presets: IPC Sync — Main ↔ Renderer (77–82)", () => {
  test.beforeAll(async () => {
    removeCcrConfig();
    const { dir, cleanup } = createFixtureRepo({ name: "preset-ipc-sync" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    writeFakeClaude();
    ctx = await launchApp({ env: launchEnv() });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset IPC Sync Test"
    );
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("77. CCR config write triggers IPC event and presets appear in settings", async () => {
    // Write two CCR models so downstream tests in this serial block see the
    // split-button chevron and the launcher's preset disclosure (both require ≥2 presets).
    writeCcrConfig([
      { id: "ipc-sync-model", name: "IPC Sync Model", model: "ipc-model-v1" },
      { id: "ipc-sync-aux", name: "IPC Sync Aux", model: "ipc-model-v2" },
    ]);
    await waitForCcrPresets(ctx.window, ["IPC Sync Model"]);
    await expect(ctx.window.locator(SEL.preset.section)).toBeVisible({ timeout: T_MEDIUM });

    // With the Popover-based PresetSelector, preset names only render inside
    // the open listbox (or in the selected-preset detail view). Poll the
    // listbox until the new CCR preset appears as an option — a single-shot
    // read can race the renderer applying the IPC store update.
    await expect
      .poll(
        async () =>
          (await getPresetOptionLabels(ctx.window)).some((l) => l.includes("IPC Sync Model")),
        {
          timeout: T_MEDIUM,
          intervals: [250, 500, 1000],
        }
      )
      .toBe(true);
  });

  test("78. CCR presets store is populated — settings section shows auto badges", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    // The auto badge only renders once a CCR preset is selected — it lives in
    // the scope banner inside #agents-presets (not inside the per-preset detail
    // panel). Select the CCR preset, then assert the badge is visible in the
    // section.
    await getPresetRowByName(ctx.window, "IPC Sync Model");
    await expect(section.locator(SEL.preset.autoBadge)).toBeVisible({ timeout: T_SHORT });
  });

  test("79. CCR model sync makes toolbar chevron visible", async () => {
    // Pin Claude so the split-button (with its chevron) mounts on the toolbar.
    // The chevron renders whenever Claude is launchable and has ≥1 preset —
    // the two CCR models from test 77 satisfy that. The fake `claude` on PATH
    // makes Claude launchable, so this assertion is unconditional.
    await pinClaude(ctx.window);

    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
    }

    const chevron = ctx.window.locator(TOOLBAR_CHEVRON);
    await expect(chevron).toBeVisible({ timeout: T_LONG });
  });

  test("80. CCR model sync populates agent tray with Claude sub-menu trigger", async () => {
    // Test 79 already dismissed settings; it may still be mid-exit when this
    // test starts (serial tests run back-to-back). Drive settings to a fully
    // closed state by polling the heading, clicking Close only while it is
    // genuinely mounted — never clicking the dialog as it detaches.
    const heading = ctx.window.locator(SEL.settings.heading);
    const closeButton = ctx.window.locator(SEL.settings.closeButton);
    await expect
      .poll(
        async () => {
          if (!(await heading.isVisible().catch(() => false))) return false;
          await closeButton.click({ timeout: T_SHORT }).catch(() => {});
          return heading.isVisible().catch(() => false);
        },
        { timeout: T_MEDIUM, intervals: [100, 250, 500] }
      )
      .toBe(false);

    const trayButton = ctx.window.locator(SEL.agent.trayButton);
    await trayButton.click();

    // A launchable agent with ≥1 preset announces itself as expandable. Claude
    // is launchable (fake CLI on PATH) and has two CCR presets, so its row
    // carries the disclosure. Assert it unconditionally.
    const search = ctx.window.getByRole("combobox", {
      name: "Search agents, panels, and recipes",
    });
    await expect(search).toBeVisible({ timeout: T_MEDIUM });
    await search.fill("Claude");
    await expect(ctx.window.locator(SEL.preset.trayLaunchPresetParent).first()).toBeVisible({
      timeout: T_MEDIUM,
    });
    await ctx.window.keyboard.press("Escape");
  });

  test("81. Settings Presets section renders newly synced CCR entry", async () => {
    await navigateToAgentSettings(ctx.window, "claude");
    const section = ctx.window.locator(SEL.preset.section);
    await expect(section).toBeVisible({ timeout: T_MEDIUM });

    // Select the CCR preset via the Popover, then assert the section's scope
    // banner shows the `auto` badge that identifies a CCR entry.
    const detail = await getPresetRowByName(ctx.window, "IPC Sync Model");
    await expect(detail).toBeVisible({ timeout: T_SHORT });
    await expect(section.locator(SEL.preset.autoBadge)).toBeVisible({ timeout: T_SHORT });
  });

  test("82. Removing CCR config does not crash the app — settings still loads", async () => {
    removeCcrConfig();
    await waitForCcrPresetsRemoved(ctx.window, ["IPC Sync Model", "IPC Sync Aux"]);
    await expect(ctx.window.locator(SEL.settings.heading)).toBeVisible({ timeout: T_MEDIUM });
  });
});
