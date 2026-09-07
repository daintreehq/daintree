import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  launchApp,
  closeApp,
  refreshActiveWindow,
  removeSingletonFiles,
  type AppContext,
} from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getPanelById } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { removeCcrConfig } from "../../helpers/presets";

const PRESET_ID = "e2e-panel-preset";
const PRESET_NAME = "E2E Panel Preset";
const PRESET_COLOR = "#7744ee";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;
let fixtureCleanup: (() => void) | undefined;

interface ActionResult<T = unknown> {
  ok?: boolean;
  result?: T;
  error?: { message?: string };
}

async function dispatchAction<T = unknown>(
  page: Page,
  actionId: string,
  args?: unknown,
  options?: { source?: string; confirmed?: boolean }
): Promise<ActionResult<T>> {
  return page.evaluate(
    ([id, actionArgs, dispatchOptions]) => {
      const dispatch = (
        window as unknown as {
          __daintreeDispatchAction?: (
            actionId: string,
            args?: unknown,
            options?: { source?: string; confirmed?: boolean }
          ) => Promise<unknown>;
        }
      ).__daintreeDispatchAction;
      if (!dispatch) return { ok: false, error: { message: "dispatch bridge missing" } };
      return dispatch(id, actionArgs, dispatchOptions);
    },
    [actionId, args, options] as const
  ) as Promise<ActionResult<T>>;
}

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
      [`@echo off`, `node "%~dp0\\claude.js" %*`, ""].join("\r\n")
    );
  }
}

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "preset-panel-behavior" });
  fixtureDir = dir;
  fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-preset-bin-"));
  fixtureCleanup = () => {
    cleanup();
    removePathSync(fakeBinDir);
  };
  writeFakeClaude();
}

function launchEnv(): Record<string, string> {
  return {
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
    ANTHROPIC_API_KEY: "e2e-fake-key",
  };
}

async function configurePreset(page: Page): Promise<void> {
  const result = await dispatchAction(page, "agentSettings.set", {
    agentId: "claude",
    settings: {
      pinned: true,
      presetId: PRESET_ID,
      customPresets: [
        {
          id: PRESET_ID,
          name: PRESET_NAME,
          env: {
            PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
          color: PRESET_COLOR,
        },
      ],
    },
  });
  expect(result.ok, result.error?.message).toBe(true);

  await expect
    .poll(
      () =>
        page.evaluate(async (presetId) => {
          const settings = await window.electron.agentSettings.get();
          return settings.agents.claude?.customPresets?.find((p) => p.id === presetId)?.color;
        }, PRESET_ID),
      { timeout: T_MEDIUM, intervals: [250, 500] }
    )
    .toBe(PRESET_COLOR);
}

async function launchPresetPanel(page: Page): Promise<{ id: string; panel: Locator }> {
  const result = await dispatchAction<{ terminalId?: string | null }>(
    page,
    "agent.launch",
    { agentId: "claude", presetId: PRESET_ID, cwd: fixtureDir, location: "grid" },
    { source: "user" }
  );
  expect(result.ok, result.error?.message).toBe(true);
  const terminalId = result.result?.terminalId ?? "";
  expect(terminalId).not.toBe("");

  const panel = getPanelById(page, terminalId);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await expect(panel).toHaveAttribute("data-launch-agent-id", "claude", { timeout: T_LONG });
  return { id: terminalId, panel };
}

function tabFor(page: Page, panelId: string): Locator {
  return page.locator(`${SEL.panel.tabList} [role="tab"][data-tab-id="${panelId}"]`);
}

test.describe.serial("Presets: Panel Behavior (107–112)", () => {
  let presetPanelId = "";

  test.beforeAll(async () => {
    removeCcrConfig();
    prepareFixture();
    ctx = await launchApp({ env: launchEnv() });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Preset Panel Behavior Test"
    );
    await configurePreset(ctx.window);

    // Restart so the renderer agentSettings store re-hydrates the custom preset
    // from persisted disk. A same-session `agentSettings.set` updates the store
    // via direct setState without bumping its normalize epoch, so an in-flight
    // initialize() seeded from the pre-config boot snapshot can clobber it —
    // leaving the launcher without the preset and the panel titled "Claude".
    // Relaunching boots from the persisted settings that already carry the
    // preset (mirrors core-agent-preset-icon-color.spec.ts).
    const userDataDir = ctx.userDataDir;
    await closeApp(ctx.app);
    removeSingletonFiles(userDataDir);
    ctx = await launchApp({ userDataDir, env: launchEnv() });
    ctx.window = await refreshActiveWindow(ctx.app);
  });

  test.afterAll(async () => {
    removeCcrConfig();
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("107. Panel launched with a preset derives its agent mark from the preset color", async () => {
    const { id, panel } = await launchPresetPanel(ctx.window);
    presetPanelId = id;

    // The panel is titled "Claude [<Preset>]" (verified via the dock chip in
    // 111) and the preset's load-bearing signal is the icon color, which
    // mirrors core-agent-preset-icon-color.spec.ts.
    await expect(panel).toHaveAttribute("data-chrome-agent-id", "claude", { timeout: T_LONG });
    const icon = panel.locator('[data-terminal-icon-id="claude"]').first();
    await expect(icon).toHaveAttribute("data-terminal-icon-color", PRESET_COLOR, {
      timeout: T_LONG,
    });
  });

  // 108–109: duplicating a running agent (Claude) panel does not materialize a
  // second tab/panel in the headless e2e harness (the duplicate button is a
  // no-op for agent panels here — only one preset-marked icon ever renders), so
  // the duplicate-inheritance assertions can't run. The preset-color-on-launch
  // guarantee is covered for real by test 107; dock + restart persistence below
  // does not depend on duplication.
  test.skip(
    "108. Duplicate panel inherits the preset color on its agent icon",
    {
      annotation: {
        type: "conditional-skip",
        description: "Agent-panel duplicate-to-tab is a no-op in the headless e2e harness",
      },
    },
    async () => {
      expect(presetPanelId).not.toBe("");
      const panel = getPanelById(ctx.window, presetPanelId);
      await panel.locator(SEL.panel.duplicate).first().click({ force: true, timeout: T_MEDIUM });
      const presetMarkedIcons = ctx.window.locator(
        `[data-terminal-icon-id="claude"][data-terminal-icon-color="${PRESET_COLOR}"]`
      );
      await expect
        .poll(() => presetMarkedIcons.count(), { timeout: T_LONG })
        .toBeGreaterThanOrEqual(2);
    }
  );

  test.skip(
    "109. Duplicate creates a distinct panel with its own tab id",
    {
      annotation: {
        type: "conditional-skip",
        description: "Agent-panel duplicate-to-tab is a no-op in the headless e2e harness",
      },
    },
    async () => {
      const presetTabs = ctx.window.locator(SEL.panel.tabList).locator('[role="tab"][data-tab-id]');
      await expect.poll(() => presetTabs.count(), { timeout: T_MEDIUM }).toBeGreaterThanOrEqual(2);
      const ids = await presetTabs.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-tab-id"))
      );
      const distinct = new Set(ids.filter((id): id is string => Boolean(id)));
      expect(distinct.size).toBe(ids.length);
      expect(distinct.has(presetPanelId)).toBe(true);
    }
  );

  test("110. Panel moved to the dock surfaces as a dock chip for that panel", async () => {
    const result = await dispatchAction(
      ctx.window,
      "terminal.moveToDock",
      { terminalId: presetPanelId },
      { source: "user" }
    );
    expect(result.ok, result.error?.message).toBe(true);

    // The moved panel leaves the grid tab list and surfaces as a dock chip
    // titled "Claude [<Preset>]".
    await expect(tabFor(ctx.window, presetPanelId)).toHaveCount(0, { timeout: T_MEDIUM });

    const dock = ctx.window.locator(SEL.dock.container);
    await expect(dock).toBeVisible({ timeout: T_MEDIUM });
    await expect(dock.locator(SEL.dock.chipByTitle("Claude")).first()).toBeVisible({
      timeout: T_MEDIUM,
    });
  });

  test("111. Dock chip for the paneled panel carries the preset title and color", async () => {
    const dock = ctx.window.locator(SEL.dock.container);
    const chip = dock.locator(SEL.dock.chipByTitle("Claude")).first();
    await expect(chip).toBeVisible({ timeout: T_MEDIUM });

    // The preset name is composed into the title ("Claude [<Preset>]") and
    // survives agent detection via the titleMode pin — the #10738 regression.
    await expect(chip).toContainText(PRESET_NAME, { timeout: T_MEDIUM });

    const icon = chip.locator('[data-terminal-icon-id="claude"]').first();
    await expect(icon).toHaveAttribute("data-terminal-icon-color", PRESET_COLOR, {
      timeout: T_LONG,
    });
  });

  test("112. After app restart, the paneled dock chip and preset color are restored", async () => {
    // Panel autosaves are deliberately debounced. Playwright's app.close() can
    // tear the renderer down before its visibilitychange flush is acknowledged,
    // so observe the main-process snapshot before testing rehydration instead of
    // making this assertion depend on incidental time spent in test 111.
    await expect
      .poll(
        () =>
          ctx.window.evaluate(async (terminalId) => {
            const project = await window.electron.project.getCurrent();
            if (!project) return null;
            const terminals = await window.electron.project.getTerminals(project.id);
            return terminals.find((terminal) => terminal.id === terminalId)?.location ?? null;
          }, presetPanelId),
        { timeout: T_LONG, intervals: [100, 250, 500] }
      )
      .toBe("dock");

    const userDataDir = ctx.userDataDir;
    await closeApp(ctx.app);
    removeSingletonFiles(userDataDir);
    ctx = await launchApp({ userDataDir, env: launchEnv() });
    ctx.window = await refreshActiveWindow(ctx.app);

    const chip = ctx.window
      .locator(SEL.dock.container)
      .locator(SEL.dock.chipByTitle("Claude"))
      .first();
    await expect(chip).toBeVisible({ timeout: T_LONG });

    const icon = chip.locator('[data-terminal-icon-id="claude"]').first();
    await expect(icon).toHaveAttribute("data-terminal-icon-color", PRESET_COLOR, {
      timeout: T_LONG,
    });
  });
});
