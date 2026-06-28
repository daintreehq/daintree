import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getFocusedPanelId, getPanelById } from "../../helpers/panels";
import { waitForTerminalPty, waitForTerminalText } from "../../helpers/terminal";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";

interface ActionResult<T = unknown> {
  ok?: boolean;
  result?: T;
  error?: { message?: string };
}

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir = "";
let fixtureCleanup: (() => void) | undefined;

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

async function startClaudeAgentFromTerminal(page: Page): Promise<{ id: string; panel: Locator }> {
  const result = await dispatchAction<{ terminalId?: string | null }>(
    page,
    "agent.launch",
    {
      agentId: "claude",
      cwd: fixtureDir,
      location: "grid",
      force: true,
    },
    { source: "user" }
  );
  expect(result.ok, result.error?.message).toBe(true);

  const terminalId = result.result?.terminalId ?? "";
  expect(terminalId).not.toBe("");

  const panel = getPanelById(page, terminalId);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  await expect(panel).toHaveAttribute("data-launch-agent-id", "claude", { timeout: T_LONG });
  await waitForTerminalText(panel, "FAKE_FLEET_AGENT_READY", T_LONG);
  await expect(panel).toHaveAttribute("data-ever-detected-agent", "true", { timeout: T_LONG });
  return { id: terminalId, panel };
}

async function armFleet(page: Page, terminalIds: string[]): Promise<void> {
  for (const terminalId of terminalIds) {
    const result = await dispatchAction(page, "terminal.arm", { terminalId }, { source: "user" });
    expect(result.ok, result.error?.message).toBe(true);
  }

  await expect(page.locator('[data-testid="fleet-arming-ribbon"]')).toBeVisible({
    timeout: T_MEDIUM,
  });
  await expect(page.locator('[data-testid="fleet-armed-count-chip"]')).toContainText("3", {
    timeout: T_MEDIUM,
  });
}

async function resetClaudeLaunchSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type AgentSettingsEntry = {
      customFlags?: string;
      dangerousEnabled?: boolean;
      presetId?: string;
    } & Record<string, unknown>;
    type AgentSettings = { agents?: Record<string, AgentSettingsEntry | undefined> };

    const settings = (await window.electron.agentSettings.get()) as AgentSettings;
    const entry = settings.agents?.claude ?? {};
    await window.electron.agentSettings.set("claude", {
      ...entry,
      customFlags: undefined,
      dangerousEnabled: false,
      presetId: undefined,
    });
  });
}

async function ensureFleetProjectOpen(): Promise<void> {
  const projectName = path.basename(fixtureDir);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    ctx.window = await getActiveAppWindow(ctx.app);
    if (
      await ctx.window
        .locator("[data-worktree-branch]")
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      return;
    }

    if (
      await ctx.window
        .getByRole("button", { name: "Open folder" })
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Broadcast");
      continue;
    }

    const recentProject = ctx.window.locator("button", { hasText: projectName }).first();
    if (await recentProject.isVisible({ timeout: 500 }).catch(() => false)) {
      await recentProject.click();
      await ctx.window.waitForTimeout(1000);
      continue;
    }

    await ctx.window.waitForTimeout(250);
  }

  await expect(ctx.window.locator("[data-worktree-branch]").first()).toBeVisible({
    timeout: T_LONG,
  });
}

async function getVisibleGridPanelIds(page: Page): Promise<string[]> {
  return page.locator(SEL.panel.gridPanel).evaluateAll((elements) =>
    elements
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.display !== "none";
      })
      .map((element) => element.getAttribute("data-panel-id") ?? "")
      .filter(Boolean)
  );
}

async function ensureFleetGridPanels(count: number): Promise<string[]> {
  await ensureFleetProjectOpen();

  for (let attempt = 0; attempt < count; attempt += 1) {
    const gridIds = await getVisibleGridPanelIds(ctx.window);
    if (gridIds.length >= count) return gridIds;

    const result = await dispatchAction<{ terminalId?: string }>(
      ctx.window,
      "terminal.new",
      undefined,
      { source: "test" }
    );
    expect(result.ok, result.error?.message).toBe(true);

    await expect
      .poll(() => getVisibleGridPanelIds(ctx.window).then((ids) => ids.length), {
        timeout: T_LONG,
        intervals: [100, 250, 500],
      })
      .toBeGreaterThan(gridIds.length);
  }

  const gridIds = await getVisibleGridPanelIds(ctx.window);
  expect(gridIds.length).toBeGreaterThanOrEqual(count);
  return gridIds;
}

async function createFreshFleetGridPanels(count: number): Promise<string[]> {
  await ensureFleetProjectOpen();

  const createdIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await dispatchAction<{ terminalId?: string }>(
      ctx.window,
      "terminal.new",
      undefined,
      { source: "test" }
    );
    expect(result.ok, result.error?.message).toBe(true);
    const id = result.result?.terminalId ?? "";
    expect(id).not.toBe("");
    const panel = getPanelById(ctx.window, id);
    await expect(panel).toBeVisible({ timeout: T_LONG });
    await waitForTerminalPty(ctx.window, getPanelById(ctx.window, id), T_LONG);
    createdIds.push(id);
  }

  return createdIds;
}

async function typeDirectlyIntoTerminal(
  page: Page,
  panel: Locator,
  terminalId: string,
  command: string
): Promise<void> {
  const xterm = panel.locator(SEL.terminal.xtermRows);
  const helperTextarea = panel.locator(SEL.terminal.xtermHelperTextarea).first();

  for (let attempt = 0; attempt < 2; attempt++) {
    await dismissBlockingPalette(page);
    await expect(xterm).toBeVisible({ timeout: T_MEDIUM });
    await xterm.click({ force: true });
    const targetFocused = await expect
      .poll(() => getFocusedPanelId(page), { timeout: 2_000, intervals: [100, 250] })
      .toBe(terminalId)
      .then(() => true)
      .catch(() => false);

    if (!targetFocused) {
      const focusResult = await dispatchAction(
        page,
        "panel.focus",
        { panelId: terminalId },
        { source: "test" }
      );
      expect(focusResult.ok, focusResult.error?.message).toBe(true);
      await xterm.click({ force: true });
    }

    await expect
      .poll(() => getFocusedPanelId(page), { timeout: T_MEDIUM, intervals: [100, 250] })
      .toBe(terminalId);

    await expect(helperTextarea).toBeAttached({ timeout: T_MEDIUM });
    await helperTextarea.evaluate((el) => {
      if (el instanceof HTMLElement) el.focus();
    });
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const active = document.activeElement;
            if (!(active instanceof HTMLElement)) return false;
            return Array.from(document.querySelectorAll("[data-panel-id]")).some(
              (panelEl) => panelEl.getAttribute("data-panel-id") === id && panelEl.contains(active)
            );
          }, terminalId),
        { timeout: T_MEDIUM, intervals: [100, 250] }
      )
      .toBe(true);

    await page.waitForTimeout(100);
    await page.keyboard.type(command, { delay: process.platform === "darwin" ? 8 : 0 });
    await page.keyboard.press("Enter");

    if (attempt === 1) return;

    const responded = await waitForTerminalText(panel, `text=${command}`, 5_000)
      .then(() => true)
      .catch(() => false);
    if (responded) return;
  }
}

async function focusPanelHybridInput(
  page: Page,
  panel: Locator,
  terminalId: string
): Promise<Locator> {
  await dismissBlockingPalette(page);
  await panel.click();
  await expect
    .poll(() => getFocusedPanelId(page), { timeout: T_MEDIUM, intervals: [100, 250] })
    .toBe(terminalId);
  const editor = panel.locator(SEL.terminal.cmEditor).first();
  await expect(editor).toBeVisible({ timeout: T_MEDIUM });
  await editor.click();
  return editor;
}

async function replaceHybridInput(page: Page, editor: Locator, text: string): Promise<void> {
  await editor.click();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await editor.pressSequentially(text);
}

function destructiveAppendCommand(targetName: string, runLogName: string): string {
  if (process.platform === "win32") {
    return `rm -rf ./${targetName}; Add-Content -Path ./${runLogName} -Value ran`;
  }

  return `rm -rf ./${targetName}; printf 'ran\\n' >> ./${runLogName}`;
}

function readRunCount(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() === "ran").length;
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "fleet-broadcast" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-fleet-bin-"));
  mkdirSync(fakeBinDir, { recursive: true });

  const fakeClaude = path.join(fakeBinDir, "claude");
  const fakeClaudeJs = path.join(fakeBinDir, "claude.js");
  const fakeClaudeCmd = path.join(fakeBinDir, "claude.cmd");
  writeFileSync(
    fakeClaude,
    [
      "#!/bin/sh",
      `exec ${quotePosixShellArg(process.execPath)} "$(dirname "$0")/claude.js" "$@"`,
      "",
    ].join("\n")
  );
  writeFileSync(
    fakeClaudeJs,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      "console.log('claude code v9.9.9 FAKE_FLEET_AGENT_READY pid=' + process.pid);",
      "process.stdout.write('> ');",
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "let buffer = '';",
      "const keepAlive = setInterval(() => {}, 1000);",
      "function shutdown() {",
      "  console.log('FAKE_FLEET_AGENT_EXIT pid=' + process.pid);",
      "  clearInterval(keepAlive);",
      "  process.exit(0);",
      "}",
      "function handleLine(raw) {",
      "  const line = raw.trim();",
      "  if (!line) {",
      "    process.stdout.write('> ');",
      "    return;",
      "  }",
      "  if (line === '/quit') shutdown();",
      "  console.log('FLEET_RESPONSE pid=' + process.pid + ' text=' + line);",
      "  console.log('FLEET_DONE ' + line);",
      "  process.stdout.write('> ');",
      "}",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += String(chunk).replace(/\\r/g, '\\n');",
      "  let idx = buffer.indexOf('\\n');",
      "  while (idx >= 0) {",
      "    const line = buffer.slice(0, idx);",
      "    buffer = buffer.slice(idx + 1);",
      "    handleLine(line);",
      "    idx = buffer.indexOf('\\n');",
      "  }",
      "});",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(fakeClaude, 0o755);
  writeFileSync(fakeClaudeCmd, `@echo off\r\n"${process.execPath}" "%~dp0\\claude.js" %*\r\n`);
}

test.describe.serial("Core: Fleet terminal broadcast", () => {
  test.beforeAll(async () => {
    prepareFixture();
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
      },
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Broadcast");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
    if (fakeBinDir) removePathSync(fakeBinDir);
  });

  test("shift-click on panel title arms terminal in fleet (#7704)", async () => {
    test.setTimeout(60_000);
    await ctx.window.waitForTimeout(1000);
    const gridIds = await createFreshFleetGridPanels(2);
    const { window } = ctx;

    await test.step("Clear any prior arming so the ribbon transition is observable", async () => {
      await dispatchAction(window, "terminal.disarmAll", undefined, { source: "user" });
      await expect(window.locator('[data-testid="fleet-arming-ribbon"]')).toBeHidden({
        timeout: T_MEDIUM,
      });
    });

    expect(gridIds.length).toBeGreaterThanOrEqual(2);

    await test.step("Focus the first panel to seat the implicit fleet anchor", async () => {
      await dismissBlockingPalette(window);
      await getPanelById(window, gridIds[0]!).click();
      await expect
        .poll(() => getFocusedPanelId(window), { timeout: T_MEDIUM, intervals: [100, 250] })
        .toBe(gridIds[0]!);
    });

    await test.step("Shift-click the second panel's title and verify the fleet arms", async () => {
      const secondPanel = getPanelById(window, gridIds[1]!);
      const titleButton = secondPanel.locator(SEL.terminal.titleButton).first();
      await expect(titleButton).toBeVisible({ timeout: T_MEDIUM });
      await titleButton.click({ modifiers: ["Shift"] });

      await expect(window.locator('[data-testid="fleet-arming-ribbon"]')).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(window.locator('[data-testid="fleet-armed-count-chip"]')).toHaveAttribute(
        "aria-label",
        /^2 in fleet/,
        { timeout: T_MEDIUM }
      );
    });
  });

  test("active xterm selection does not block shift-click on panel title (#7704)", async () => {
    test.setTimeout(60_000);
    await ctx.window.waitForTimeout(1000);
    const gridIds = await createFreshFleetGridPanels(2);
    const { window } = ctx;

    await test.step("Clear any prior arming so the ribbon transition is observable", async () => {
      await dispatchAction(window, "terminal.disarmAll", undefined, { source: "user" });
      await expect(window.locator('[data-testid="fleet-arming-ribbon"]')).toBeHidden({
        timeout: T_MEDIUM,
      });
    });

    expect(gridIds.length).toBeGreaterThanOrEqual(2);

    await test.step("Focus first panel as anchor, then seed selection on the panel we will click", async () => {
      await dismissBlockingPalette(window);
      const firstPanel = getPanelById(window, gridIds[0]!);
      await firstPanel.click();
      await expect
        .poll(() => getFocusedPanelId(window), { timeout: T_MEDIUM, intervals: [100, 250] })
        .toBe(gridIds[0]!);

      // selectAll() leaves hasSelection() === true on the second panel.
      // handleClick queries the clicked pane's own terminal, so the selection
      // must live on the same panel whose title we shift-click — otherwise
      // the pre-fix early-return path is never exercised.
      const selected = await window.evaluate(
        (panelId) =>
          (
            window as unknown as {
              __daintreeSelectTerminalAll?: (id: string) => boolean;
            }
          ).__daintreeSelectTerminalAll?.(panelId) ?? false,
        gridIds[1]!
      );
      expect(selected).toBe(true);
    });

    await test.step("Shift-click the selected panel's title — fleet should arm despite its own selection", async () => {
      const secondPanel = getPanelById(window, gridIds[1]!);
      const titleButton = secondPanel.locator(SEL.terminal.titleButton).first();
      await expect(titleButton).toBeVisible({ timeout: T_MEDIUM });
      await titleButton.click({ modifiers: ["Shift"] });

      await expect(window.locator('[data-testid="fleet-arming-ribbon"]')).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(window.locator('[data-testid="fleet-armed-count-chip"]')).toHaveAttribute(
        "aria-label",
        /^2 in fleet/,
        { timeout: T_MEDIUM }
      );
    });
  });

  test("Cmd+Alt+Arrow cycles focus across the fleet grid (#5989)", async () => {
    test.setTimeout(60_000);

    let window = ctx.window;
    let fleetIds: string[] = [];
    let firstId = "";

    await test.step("Arm existing grid panels and enter fleet scope", async () => {
      // Self-contained: arm whatever grid panels exist (idempotent if a prior
      // test already armed them) so this test passes when run in isolation
      // (e.g., `playwright test --grep "#5989"`).
      const gridIds = await ensureFleetGridPanels(2);
      window = ctx.window;
      expect(gridIds.length).toBeGreaterThanOrEqual(2);
      for (const id of gridIds) {
        await dispatchAction(window, "terminal.arm", { terminalId: id }, { source: "user" });
      }

      // Activate fleet scope so ContentGrid renders the flat fleet grid —
      // the path where useGridNavigation regressed in #5989.
      const enter = await dispatchAction(window, "fleet.scope.enter", undefined, {
        source: "user",
      });
      expect(enter.ok, enter.error?.message).toBe(true);

      fleetIds = await getVisibleGridPanelIds(window);
      expect(fleetIds.length).toBeGreaterThanOrEqual(2);
    });

    await test.step("Click first fleet panel to anchor focus", async () => {
      firstId = fleetIds[0]!;
      await dismissBlockingPalette(window);
      await getPanelById(window, firstId).click();
      await expect
        .poll(() => getFocusedPanelId(window), { timeout: T_MEDIUM, intervals: [100, 250] })
        .toBe(firstId);
    });

    await test.step("Dispatch terminal.focusRight and verify focus moves to next fleet panel", async () => {
      // Pre-fix, this dispatch was a silent no-op because the nav model was
      // built from the active worktree's tab groups, not the fleet armOrder.
      const right = await dispatchAction(window, "terminal.focusRight", undefined, {
        source: "keybinding",
      });
      expect(right.ok, right.error?.message).toBe(true);

      await expect
        .poll(() => getFocusedPanelId(window), { timeout: T_MEDIUM, intervals: [100, 250] })
        .toBe(fleetIds[1]!);
    });

    await test.step("Exit fleet scope", async () => {
      const exit = await dispatchAction(window, "fleet.scope.exit", undefined, { source: "user" });
      expect(exit.ok, exit.error?.message).toBe(true);
    });
  });

  test("direct xterm typing into one armed agent terminal reaches the whole fleet", async () => {
    test.setTimeout(180_000);

    const { window } = ctx;

    await test.step("Clear any existing fleet state", async () => {
      await dispatchAction(window, "terminal.disarmAll", undefined, { source: "test" });
      await expect(window.locator('[data-testid="fleet-arming-ribbon"]')).toBeHidden({
        timeout: T_MEDIUM,
      });
    });

    await test.step("Disable hybrid input so xterm typing reaches the PTY directly", async () => {
      const disableHybrid = await dispatchAction(
        window,
        "terminalConfig.setHybridInputEnabled",
        { enabled: false },
        { source: "user" }
      );
      expect(disableHybrid.ok, disableHybrid.error?.message).toBe(true);
    });

    await test.step("Reset Claude launch flags for the fake CLI", async () => {
      await resetClaudeLaunchSettings(window);
    });

    let agents: Array<{ id: string; panel: Locator }> = [];
    let terminalIds: string[] = [];
    await test.step("Start three fake Claude agents in fresh terminals", async () => {
      agents = [
        await startClaudeAgentFromTerminal(window),
        await startClaudeAgentFromTerminal(window),
        await startClaudeAgentFromTerminal(window),
      ];
      terminalIds = agents.map((agent) => agent.id);
      expect(new Set(terminalIds).size).toBe(3);
    });

    await test.step("Arm the fleet across all three terminals", async () => {
      await armFleet(window, terminalIds);
    });

    await test.step("Verify each panel is armed for broadcast", async () => {
      for (const { panel } of agents) {
        await expect(panel).toHaveAttribute("data-selected", "true", { timeout: T_MEDIUM });
      }
    });

    const command = `fleet-direct-${Date.now()}`;
    await test.step("Type directly into the first armed terminal and verify all three respond", async () => {
      await typeDirectlyIntoTerminal(window, agents[0]!.panel, agents[0]!.id, command);

      for (const { panel } of agents) {
        await waitForTerminalText(panel, `FLEET_RESPONSE`, T_LONG);
        await waitForTerminalText(panel, `text=${command}`, T_LONG);
        await waitForTerminalText(panel, `FLEET_DONE ${command}`, T_LONG);
      }
    });

    await test.step("Verify arming ribbon stays and HybridInputBar is absent", async () => {
      await expect(window.locator('[data-testid="fleet-arming-ribbon"]')).toBeVisible({
        timeout: T_MEDIUM,
      });
      await expect(agents[0]!.panel.locator(SEL.terminal.cmEditor)).toHaveCount(0);
    });

    await test.step("Disarm and verify the armed state clears one panel at a time", async () => {
      // Disarm the first panel and verify its armed state clears but the
      // other two stay armed — guards against store bugs that clear the
      // entire armedIds set on a single disarm.
      const disarm0 = await dispatchAction(
        window,
        "terminal.disarm",
        { terminalId: agents[0]!.id },
        { source: "user" }
      );
      expect(disarm0.ok, disarm0.error?.message).toBe(true);
      await expect(agents[0]!.panel).not.toHaveAttribute("data-selected", "true", {
        timeout: T_MEDIUM,
      });
      await expect(agents[1]!.panel).toHaveAttribute("data-selected", "true", {
        timeout: T_MEDIUM,
      });
      await expect(agents[2]!.panel).toHaveAttribute("data-selected", "true", {
        timeout: T_MEDIUM,
      });

      // Disarm the remaining two.
      for (let i = 1; i < agents.length; i++) {
        const disarm = await dispatchAction(
          window,
          "terminal.disarm",
          { terminalId: agents[i]!.id },
          { source: "user" }
        );
        expect(disarm.ok, disarm.error?.message).toBe(true);
        await expect(agents[i]!.panel).not.toHaveAttribute("data-selected", "true", {
          timeout: T_MEDIUM,
        });
      }
    });
  });

  test("destructive broadcast via hybrid input sends immediately to the armed fleet", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    await test.step("Clear any existing fleet state", async () => {
      await dispatchAction(window, "terminal.disarmAll", undefined, { source: "test" });
      await expect(window.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });
    });

    await test.step("Re-enable hybrid input so Enter routes through the editor broadcast path", async () => {
      const enableHybrid = await dispatchAction(
        window,
        "terminalConfig.setHybridInputEnabled",
        { enabled: true },
        { source: "user" }
      );
      expect(enableHybrid.ok, enableHybrid.error?.message).toBe(true);
    });

    let gridIds: string[] = [];
    await test.step("Create and arm two fresh fleet panels", async () => {
      gridIds = await createFreshFleetGridPanels(2);
      expect(gridIds.length).toBeGreaterThanOrEqual(2);
      for (const id of gridIds.slice(0, 2)) {
        const arm = await dispatchAction(
          window,
          "terminal.arm",
          { terminalId: id },
          { source: "user" }
        );
        expect(arm.ok, arm.error?.message).toBe(true);
      }
      await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
      await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
        "aria-label",
        /^2 in fleet/,
        { timeout: T_MEDIUM }
      );
    });

    const sendTarget = `fleet-e2e-send-${Date.now()}`;
    const sendRunLog = `${sendTarget}.ran`;
    const sendRunLogPath = path.join(fixtureDir, sendRunLog);
    const sendCommand = destructiveAppendCommand(sendTarget, sendRunLog);

    await test.step("Typing a destructive command and pressing Enter broadcasts immediately", async () => {
      const editor = await focusPanelHybridInput(
        window,
        getPanelById(window, gridIds[0]!),
        gridIds[0]!
      );
      await replaceHybridInput(window, editor, sendCommand);
      await window.keyboard.press("Enter");

      await expect(window.locator(SEL.fleet.pasteConfirm)).toBeHidden({ timeout: T_MEDIUM });
      await expect
        .poll(() => readRunCount(sendRunLogPath), {
          timeout: T_LONG,
          intervals: [250, 500, 1000],
        })
        .toBeGreaterThanOrEqual(2);
    });
  });
});
