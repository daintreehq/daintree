import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, getActiveAppWindow, type AppContext } from "../../helpers/launch";
import { createFixtureRepo, removePathSync } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getFocusedPanelId, getPanelById } from "../../helpers/panels";
import {
  getTerminalText,
  waitForTerminalPty,
  waitForTerminalText,
  writeTerminalInput,
} from "../../helpers/terminal";
import { injectFault, injectDelay, clearAllFaults } from "../../helpers/ipcFaults";
import { getPtyPid, isPidAlive } from "../../helpers/stress";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";

// Submit is the structured fleet-broadcast write path. Faulting this channel
// makes `terminalClient.submit` reject for every target so the renderer's
// transient/permanent classification (`classifyFleetRejectionReason`) runs.
const TERMINAL_SUBMIT_CHANNEL = "terminal:submit";

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

async function ensureProjectOpen(): Promise<void> {
  const projectName = path.basename(fixtureDir);
  const worktreeBranch = () => ctx.window.locator("[data-worktree-branch]").first();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    ctx.window = await getActiveAppWindow(ctx.app);
    if (await worktreeBranch().isVisible()) return;

    const openProjectButton = ctx.window.getByRole("button", {
      name: "Open project",
      exact: true,
    });
    const recentProject = ctx.window.locator("button", { hasText: projectName }).first();
    await expect(worktreeBranch().or(openProjectButton).or(recentProject).first()).toBeVisible({
      timeout: T_MEDIUM,
    });
    if (await worktreeBranch().isVisible()) return;

    if (await openProjectButton.isVisible()) {
      ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Broadcast");
      continue;
    }

    if (await recentProject.isVisible()) {
      await recentProject.click();
      await expect(worktreeBranch())
        .toBeVisible({ timeout: T_MEDIUM })
        .catch(() => undefined);
    }
  }

  await expect(worktreeBranch()).toBeVisible({ timeout: T_LONG });
}

async function createFreshGridPanels(count: number): Promise<string[]> {
  await ensureProjectOpen();
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
    await waitForTerminalPty(ctx.window, panel, T_LONG);
    createdIds.push(id);
  }
  return createdIds;
}

async function awaitPtyPid(page: Page, id: string): Promise<number> {
  let pid = 0;
  await expect
    .poll(
      async () => {
        pid = await getPtyPid(page, getPanelById(page, id)).catch(() => 0);
        return pid;
      },
      { timeout: T_LONG, message: `terminal ${id} should report its shell PID` }
    )
    .toBeGreaterThan(0);
  return pid;
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

async function armPanels(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) {
    const result = await dispatchAction(
      page,
      "terminal.arm",
      { terminalId: id },
      { source: "user" }
    );
    expect(result.ok, result.error?.message).toBe(true);
    await expect(getPanelById(page, id)).toHaveAttribute("data-selected", "true", {
      timeout: T_MEDIUM,
    });
  }
}

async function clearFleet(page: Page): Promise<void> {
  await dispatchAction(page, "terminal.disarmAll", undefined, { source: "test" });
  await expect(page.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });
}

async function setHybridInputEnabled(page: Page, enabled: boolean): Promise<void> {
  const result = await dispatchAction(
    page,
    "terminalConfig.setHybridInputEnabled",
    { enabled },
    { source: "user" }
  );
  expect(result.ok, result.error?.message).toBe(true);
}

/**
 * Every test starts from an empty grid, no faults, no fleet, and hybrid input
 * on. Killing (not trashing) keeps earlier tests' PTYs from piling up in the
 * trash while later tests spawn more.
 */
async function resetFleetGroup(): Promise<void> {
  await clearAllFaults(ctx.app);
  await ensureProjectOpen();
  const page = ctx.window;
  // A palette left open by an earlier test would block the overlay check below.
  await dismissBlockingPalette(page);
  // Check overlays while the fleet is still armed: the ribbon unmounts its
  // menu when disarmed, which would hide a menu left open by the last test.
  await expect.poll(() => describePointerBlockers(page), { timeout: T_MEDIUM }).toBe("");
  await dispatchAction(page, "fleet.scope.exit", undefined, { source: "test" });
  await clearFleet(page);
  const killAll = await dispatchAction(
    page,
    "terminal.killAll",
    { confirmed: true },
    { source: "test" }
  );
  expect(killAll.ok, killAll.error?.message).toBe(true);
  await expect(page.locator(SEL.panel.gridPanel)).toHaveCount(0, { timeout: T_LONG });
  await setHybridInputEnabled(page, true);
  await expect.poll(() => describePointerBlockers(page), { timeout: T_MEDIUM }).toBe("");
}

/** Anything that would swallow the next click: a modal-locked body or an open overlay. */
async function describePointerBlockers(page: Page): Promise<string> {
  return page.evaluate(() => {
    const blockers: string[] = [];
    const bodyPointer = getComputedStyle(document.body).pointerEvents;
    const htmlPointer = getComputedStyle(document.documentElement).pointerEvents;
    if (bodyPointer === "none") blockers.push("body pointer-events:none");
    if (htmlPointer === "none") blockers.push("html pointer-events:none");
    for (const el of document.querySelectorAll(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]'
    )) {
      const label =
        el.getAttribute("aria-label") ??
        el.getAttribute("data-testid") ??
        (el.textContent ?? "").slice(0, 60);
      blockers.push(`${el.getAttribute("role") ?? el.tagName}:${label}`);
    }
    return blockers.join(" | ");
  });
}

// ── Fake agent CLI ───────────────────────────────────────────────────────────
// The shared fake agent (helpers/fakeAgent.ts) never echoes what it is sent, so
// it cannot show each agent answering the broadcast in its own pane. This one
// replies per line with its own pid, which is what the direct-typing test reads.

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

  await expect(page.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
  await expect(page.locator(SEL.fleet.armedCountChip)).toContainText("3", {
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

async function typeDirectlyIntoTerminal(
  page: Page,
  panel: Locator,
  terminalId: string,
  command: string
): Promise<void> {
  const xterm = panel.locator(SEL.terminal.xtermRows);
  const helperTextarea = panel.locator(SEL.terminal.xtermHelperTextarea).first();

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
  await expect(helperTextarea).toBeFocused({ timeout: T_MEDIUM });

  // Submitted exactly once: a retype would hide a lost first delivery and
  // could double the command, so callers assert the single response.
  await page.keyboard.type(command, { delay: process.platform === "darwin" ? 8 : 0 });
  await page.keyboard.press("Enter");
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function installFleetFakeClaude(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const fakeClaude = path.join(binDir, "claude");
  const fakeClaudeJs = path.join(binDir, "claude.js");
  const fakeClaudeCmd = path.join(binDir, "claude.cmd");
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

// ── Hybrid input editor ──────────────────────────────────────────────────────

async function editorContains(locator: Locator, text: string): Promise<boolean> {
  return (await getEditorText(locator)).includes(text);
}

async function getEditorText(locator: Locator): Promise<string> {
  if (!(await locator.isVisible().catch(() => false))) return "";
  return locator.evaluate((element) => element.textContent ?? "").catch(() => "");
}

async function getHybridInputText(page: Page, terminalId: string): Promise<string> {
  return page.evaluate((id) => window.__daintreeHybridInputE2E?.getText(id) ?? "", terminalId);
}

async function setHybridInputText(page: Page, terminalId: string, text: string): Promise<void> {
  const assertion = expect
    .poll(
      () =>
        page.evaluate(
          ([id, nextText]) => window.__daintreeHybridInputE2E?.setText(id, nextText) ?? false,
          [terminalId, text] as const
        ),
      { timeout: T_MEDIUM, intervals: [100, 250] }
    )
    .toBe(true);
  await assertion.catch(async (error: unknown) => {
    const debug = await page.evaluate(
      (id) => ({
        mode: window.__DAINTREE_E2E_MODE__ === true,
        hasBridge: !!window.__daintreeHybridInputE2E,
        registeredIds: window.__daintreeHybridInputE2E?.listIds?.() ?? [],
        requestedId: id,
      }),
      terminalId
    );
    throw new Error(
      `Hybrid input E2E bridge did not accept text: ${JSON.stringify(debug)}\n${String(error)}`
    );
  });
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

async function broadcastViaEditor(
  page: Page,
  panel: Locator,
  terminalId: string,
  command: string
): Promise<void> {
  await dismissBlockingPalette(page);
  await panel.click();
  await expect
    .poll(() => getFocusedPanelId(page), { timeout: T_MEDIUM, intervals: [100, 250] })
    .toBe(terminalId);
  const editor = panel.locator(SEL.terminal.cmEditor).first();
  await expect(editor).toBeVisible({ timeout: T_MEDIUM });
  await editor.click();
  await editor.pressSequentially(command);
  await expect
    .poll(() => editorContains(editor, command), {
      timeout: T_MEDIUM,
      intervals: [100, 250],
    })
    .toBe(true);

  await editor.press("Enter");
  const consumed = await expect
    .poll(() => editorContains(editor, command), {
      timeout: T_MEDIUM,
      intervals: [100, 250],
    })
    .toBe(false)
    .then(
      () => true,
      () => false
    );

  if (!consumed) {
    await editor.click();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => editorContains(editor, command), {
        timeout: T_MEDIUM,
        intervals: [100, 250],
      })
      .toBe(false);
  }
}

async function focusHybridInput(page: Page, panel: Locator, terminalId: string): Promise<Locator> {
  await dismissBlockingPalette(page);
  await panel.click({ force: true, noWaitAfter: true });
  await expect
    .poll(() => getFocusedPanelId(page), { timeout: T_MEDIUM, intervals: [100, 250] })
    .toBe(terminalId);
  const editor = panel.locator(SEL.terminal.cmEditor).first();
  await expect(editor).toBeVisible({ timeout: T_MEDIUM });
  await editor.evaluate((node) => {
    if (node instanceof HTMLElement) node.focus();
  });
  await expect
    .poll(() => editor.evaluate((node) => document.activeElement === node).catch(() => false), {
      timeout: T_MEDIUM,
      intervals: [100, 250],
    })
    .toBe(true);
  return editor;
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

// ── Saved fleets and confirm keys ────────────────────────────────────────────

async function openSavedFleetRow(page: Page, fleetName: string) {
  const savedRow = page.locator(SEL.fleet.savedRow).filter({ hasText: fleetName });
  if (await savedRow.isVisible()) {
    return savedRow;
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.locator(SEL.fleet.selectionMenuTrigger).click({ timeout: T_MEDIUM });
    const opened = await expect(savedRow)
      .toBeVisible({ timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return savedRow;
  }
  await expect(savedRow).toBeVisible({ timeout: T_MEDIUM });
  return savedRow;
}

// Closed by toggling its trigger. Neither Escape nor a click outside reliably
// dismisses this menu here (a suspected product bug, not what these tests
// cover). It has to be really closed: the ribbon keeps its open state while
// hidden and would pop the menu back up when the next test arms a fleet. The
// open menu locks pointer events outside itself, so the trigger's own
// pointerdown handler is fired directly rather than through a hit-tested click.
async function closeSelectionMenu(page: Page): Promise<void> {
  const menu = page.getByRole("menu");
  await expect(menu).toHaveCount(1, { timeout: T_MEDIUM });
  await page
    .locator(SEL.fleet.selectionMenuTrigger)
    .dispatchEvent("pointerdown", { button: 0, pointerType: "mouse", isPrimary: true });
  await expect(menu).toHaveCount(0, { timeout: T_MEDIUM });
}

/**
 * Absence held across a window after a delivery barrier, not one lucky sample.
 * Reads back to back until the window closes, so a late delivery is caught.
 */
async function expectAbsentThroughout(
  read: () => Promise<string>,
  needle: string,
  what: string,
  windowMs = 2_000
): Promise<void> {
  const deadline = Date.now() + windowMs;
  let samples = 0;
  while (Date.now() < deadline || samples < 5) {
    expect(await read(), `${what} (sample ${samples})`).not.toContain(needle);
    samples += 1;
  }
}

async function requestSavedFleetDelete(page: Page, fleetName: string): Promise<void> {
  // Delete on a focused row is the menu's accelerator to the same delete the
  // saved-fleets dialog offers as a button.
  const savedRow = await openSavedFleetRow(page, fleetName);
  await savedRow.focus();
  await page.keyboard.press("Delete");
}

// These confirmation keys belong to window-level listeners. Dispatch from
// body so Electron's asynchronous xterm refocus cannot retarget the synthetic
// key into the terminal-only guard between blur and keyboard.press().
async function dispatchGlobalKey(page: Page, key: "Enter" | "Escape"): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await page.evaluate((value) => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: value,
        code: value,
        bubbles: true,
        cancelable: true,
      })
    );
  }, key);
}

test.describe("Core: Fleet terminal broadcast", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "fleet-broadcast" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    fakeBinDir = mkdtempSync(path.join(tmpdir(), "daintree-e2e-fleet-bin-"));
    installFleetFakeClaude(fakeBinDir);
    ctx = await launchApp({
      env: {
        DAINTREE_E2E_FAULT_MODE: "1",
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
      },
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Fleet Broadcast");
  });

  test.beforeEach(async () => {
    await resetFleetGroup();
  });

  test.afterEach(async () => {
    if (ctx?.app) await clearAllFaults(ctx.app);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
    if (fakeBinDir) removePathSync(fakeBinDir);
  });

  test.describe("arming and navigation", () => {
    test("shift-click on panel title arms terminal in fleet (#7704)", async () => {
      test.setTimeout(60_000);
      const gridIds = await createFreshGridPanels(2);
      const { window } = ctx;
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

        await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
        await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
          "aria-label",
          /^2 in fleet/,
          { timeout: T_MEDIUM }
        );
      });
    });

    test("active xterm selection does not block shift-click on panel title (#7704)", async () => {
      test.setTimeout(60_000);
      const gridIds = await createFreshGridPanels(2);
      const { window } = ctx;
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

        await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
        await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
          "aria-label",
          /^2 in fleet/,
          { timeout: T_MEDIUM }
        );
      });
    });

    test("Cmd+Alt+Arrow cycles focus across the fleet grid (#5989)", async () => {
      test.setTimeout(60_000);
      const window = ctx.window;
      let fleetIds: string[] = [];
      let firstId = "";

      await test.step("Arm two fresh grid panels and enter fleet scope", async () => {
        const gridIds = await createFreshGridPanels(2);
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
        const exit = await dispatchAction(window, "fleet.scope.exit", undefined, {
          source: "user",
        });
        expect(exit.ok, exit.error?.message).toBe(true);
      });
    });

    test("fleet.armAll arms every eligible terminal in the worktree", async () => {
      test.setTimeout(90_000);
      const { window } = ctx;

      const ids = await createFreshGridPanels(3);
      expect(ids.length).toBeGreaterThanOrEqual(3);

      const armAll = await dispatchAction(
        window,
        "fleet.armAll",
        { scope: "current" },
        { source: "user" }
      );
      expect(armAll.ok, armAll.error?.message).toBe(true);

      await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
      // Assert by identity rather than a tolerant count: every fresh eligible
      // panel must end up armed. A count regex would still pass if armAll
      // skipped one of these and armed an unrelated leftover instead.
      for (const id of ids) {
        await expect(getPanelById(window, id)).toHaveAttribute("data-selected", "true", {
          timeout: T_MEDIUM,
        });
      }
    });
  });

  test.describe("broadcast delivery", () => {
    test("direct xterm typing into one armed agent terminal reaches the whole fleet", async () => {
      test.setTimeout(180_000);

      const { window } = ctx;

      await test.step("Disable hybrid input so xterm typing reaches the PTY directly", async () => {
        await setHybridInputEnabled(window, false);
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
          const text = await getTerminalText(panel);
          expect(text.split(`FLEET_DONE ${command}`).length - 1).toBe(1);
        }
      });

      await test.step("Verify arming ribbon stays and HybridInputBar is absent", async () => {
        await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
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

      let gridIds: string[] = [];
      await test.step("Create and arm two fresh fleet panels", async () => {
        gridIds = await createFreshGridPanels(2);
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

        // No confirm step: both armed shells run the command on their own.
        await expect
          .poll(() => readRunCount(sendRunLogPath), {
            timeout: T_LONG,
            intervals: [250, 500, 1000],
          })
          .toBeGreaterThanOrEqual(2);
      });
    });
  });

  test.describe("kill confirm and saved fleets", () => {
    test("fleet.kill surfaces a pending confirm that Escape cancels without killing", async () => {
      test.setTimeout(90_000);
      const { window } = ctx;

      const ids = (await createFreshGridPanels(2)).slice(0, 2);
      const ptyPids: number[] = [];
      for (const id of ids) {
        ptyPids.push(await awaitPtyPid(window, id));
      }
      await armPanels(window, ids);
      await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });

      await test.step("Dispatching fleet.kill arms the confirm strip", async () => {
        const kill = await dispatchAction(window, "fleet.kill", undefined, { source: "user" });
        expect(kill.ok, kill.error?.message).toBe(true);
        await expect(window.locator(`${SEL.fleet.ribbon}[data-pending-action="kill"]`)).toBeVisible(
          {
            timeout: T_MEDIUM,
          }
        );
      });

      await test.step("Escape cancels the confirm — terminals survive, fleet stays armed", async () => {
        await dispatchGlobalKey(window, "Escape");
        await expect(window.locator(`${SEL.fleet.ribbon}[data-pending-action]`)).toBeHidden({
          timeout: T_MEDIUM,
        });
        await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });
        for (const id of ids) {
          await expect(getPanelById(window, id)).toBeVisible({ timeout: T_MEDIUM });
        }
      });

      await test.step("Both shells are still running and answer a fresh command", async () => {
        // A visible pane can outlive its PTY, so ask each shell to compute
        // something: only a live shell prints the expanded result.
        for (const [index, id] of ids.entries()) {
          const panel = getPanelById(window, id);
          await writeTerminalInput(window, panel, `echo SURVIVED_$((${index}+100))\r`);
          await waitForTerminalText(panel, `SURVIVED_${index + 100}`, T_LONG);
        }
        for (const pid of ptyPids) {
          expect(isPidAlive(pid), `shell pid ${pid} should survive a cancelled kill`).toBe(true);
        }
      });
    });

    test("fleet.kill confirmed with Enter removes every armed terminal", async () => {
      test.setTimeout(90_000);
      const { window } = ctx;

      const ids = (await createFreshGridPanels(2)).slice(0, 2);
      const ptyPids: number[] = [];
      for (const id of ids) {
        ptyPids.push(await awaitPtyPid(window, id));
      }
      await armPanels(window, ids);
      await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });

      const kill = await dispatchAction(window, "fleet.kill", undefined, { source: "user" });
      expect(kill.ok, kill.error?.message).toBe(true);
      await expect(window.locator(`${SEL.fleet.ribbon}[data-pending-action="kill"]`)).toBeVisible({
        timeout: T_MEDIUM,
      });

      await dispatchGlobalKey(window, "Enter");

      await test.step("Both armed panels are removed and the ribbon clears", async () => {
        for (const id of ids) {
          await expect(getPanelById(window, id)).toHaveCount(0, { timeout: T_LONG });
        }
        await expect(window.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });
      });

      await test.step("Each killed terminal's shell process is gone from the OS", async () => {
        for (const pid of ptyPids) {
          await expect
            .poll(() => isPidAlive(pid), {
              timeout: T_LONG,
              message: `shell pid ${pid} still alive`,
            })
            .toBe(false);
        }
      });
    });

    test("saved fleet snapshot save → recall → delete lifecycle", async () => {
      test.setTimeout(120_000);
      const { window } = ctx;

      const ids = (await createFreshGridPanels(3)).slice(0, 3);
      await armPanels(window, ids);
      await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
        "aria-label",
        /^3 in fleet/,
        { timeout: T_MEDIUM }
      );

      const fleetName = `E2E Snapshot ${Date.now()}`;

      await test.step("Save the current selection as a named snapshot", async () => {
        await dismissBlockingPalette(window);
        await window.locator(SEL.fleet.selectionMenuTrigger).click();
        await window.locator(SEL.fleet.saveOpen).click();
        await expect(window.locator(SEL.fleet.saveDialog)).toBeVisible({ timeout: T_MEDIUM });
        await window.locator(SEL.fleet.saveFormName).fill(fleetName);
        await window.keyboard.press("Enter");
        // The dialog closes itself once the fleet is stored.
        await expect(window.locator(SEL.fleet.saveDialog)).toBeHidden({ timeout: T_MEDIUM });
      });

      await test.step("Reopening the menu shows the saved row", async () => {
        await window.locator(SEL.fleet.selectionMenuTrigger).click();
        await expect(window.locator(SEL.fleet.savedRow).filter({ hasText: fleetName })).toBeVisible(
          {
            timeout: T_MEDIUM,
          }
        );
        await closeSelectionMenu(window);
      });

      await test.step("Leave one pane out, then recall the snapshot to re-arm all three", async () => {
        const disarmAll = await dispatchAction(window, "terminal.disarmAll", undefined, {
          source: "user",
        });
        expect(disarmAll.ok, disarmAll.error?.message).toBe(true);
        await expect(window.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });

        await armPanels(window, ids.slice(1));
        await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
          "aria-label",
          /^2 in fleet/,
          { timeout: T_MEDIUM }
        );

        const savedRow = await openSavedFleetRow(window, fleetName);
        await savedRow.click({ force: true });
        await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
          "aria-label",
          /^3 in fleet/,
          { timeout: T_MEDIUM }
        );
        // Recall must restore the snapshot's exact panes, not just any three
        // eligible terminals — the disarmed pane (ids[0]) is re-armed by id.
        await expect(getPanelById(window, ids[0]!)).toHaveAttribute("data-selected", "true", {
          timeout: T_MEDIUM,
        });
      });

      await test.step("Delete the saved fleet at once, then bring it back with Undo", async () => {
        await armPanels(window, ids);
        await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
          "aria-label",
          /^3 in fleet/,
          { timeout: T_MEDIUM }
        );

        await requestSavedFleetDelete(window, fleetName);
        await expect(window.getByRole("alertdialog")).toHaveCount(0);
        const undo = window
          .locator(SEL.notifications.toastRegion)
          .getByRole("button", { name: "Undo" });
        await expect(undo).toBeVisible({ timeout: T_MEDIUM });
        // The toast expires before a menu round trip; the final delete below checks removal.
        await undo.click();
        await openSavedFleetRow(window, fleetName);
        await closeSelectionMenu(window);

        await requestSavedFleetDelete(window, fleetName);
        await window.locator(SEL.fleet.selectionMenuTrigger).click();
        await expect(window.locator(SEL.fleet.savedRow).filter({ hasText: fleetName })).toHaveCount(
          0,
          { timeout: T_MEDIUM }
        );
        await closeSelectionMenu(window);
      });
    });
  });

  test.describe("failure and progress paths", () => {
    test("a killed armed terminal is pruned from the broadcast targets (eligibility drift)", async () => {
      test.setTimeout(120_000);
      const { window } = ctx;

      const ids = (await createFreshGridPanels(3)).slice(0, 3);
      await armPanels(window, ids);
      await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
        "aria-label",
        /^3 in fleet/,
        { timeout: T_MEDIUM }
      );

      await test.step("Killing one armed terminal drops the armed count to two", async () => {
        const kill = await dispatchAction(
          window,
          "terminal.kill",
          { terminalId: ids[2]!, confirmed: true },
          { source: "user" }
        );
        expect(kill.ok, kill.error?.message).toBe(true);
        await expect(getPanelById(window, ids[2]!)).toHaveCount(0, { timeout: T_LONG });
        await expect(window.locator(SEL.fleet.armedCountChip)).toHaveAttribute(
          "aria-label",
          /^2 in fleet/,
          { timeout: T_MEDIUM }
        );
      });

      const marker = `fleet-drift-${Date.now()}`;
      await test.step("Broadcasting reaches the two survivors only", async () => {
        await broadcastViaEditor(window, getPanelById(window, ids[0]!), ids[0]!, `echo ${marker}`);
        await waitForTerminalText(getPanelById(window, ids[0]!), marker, T_LONG);
        await waitForTerminalText(getPanelById(window, ids[1]!), marker, T_LONG);
      });
    });

    test("a transient submit failure surfaces the retry banner and retry re-sends", async () => {
      test.setTimeout(120_000);
      const { window } = ctx;

      const ids = (await createFreshGridPanels(2)).slice(0, 2);
      await armPanels(window, ids);
      await expect(window.locator(SEL.fleet.ribbon)).toBeVisible({ timeout: T_MEDIUM });

      const marker = `fleet-transient-${Date.now()}`;

      await test.step("Inject a transient submit fault and broadcast", async () => {
        await injectFault(
          ctx.app,
          TERMINAL_SUBMIT_CHANNEL,
          "simulated transient broadcast failure"
        );
        await broadcastViaEditor(window, getPanelById(window, ids[0]!), ids[0]!, `echo ${marker}`);
      });

      await test.step("The failure banner appears with a retry action", async () => {
        await expect(window.locator(SEL.fleet.failureBanner)).toBeVisible({ timeout: T_LONG });
        await expect(window.getByRole("button", { name: "Retry", exact: true })).toBeVisible({
          timeout: T_MEDIUM,
        });
        // The faulted broadcast must not have reached either pane — otherwise a
        // later "marker present" assertion would pass on the original send, not
        // the retry, making the retry path falsely look exercised.
        for (const id of ids) {
          await expectAbsentThroughout(
            () => getTerminalText(getPanelById(window, id)),
            marker,
            `faulted broadcast reached ${id}`
          );
        }
      });

      await test.step("Clearing the fault and retrying delivers the payload", async () => {
        await clearAllFaults(ctx.app);
        const retryFailed = window.getByRole("button", { name: "Retry", exact: true });
        await expect(retryFailed).toBeVisible({ timeout: T_MEDIUM });
        await retryFailed.click({
          force: true,
          timeout: T_MEDIUM,
        });
        await waitForTerminalText(getPanelById(window, ids[0]!), marker, T_LONG);
        await waitForTerminalText(getPanelById(window, ids[1]!), marker, T_LONG);
        await expect(window.locator(SEL.fleet.failureBanner)).toBeHidden({ timeout: T_LONG });
      });
    });

    test("a permanent submit failure (EPIPE) auto-disarms the dead targets", async () => {
      test.setTimeout(120_000);
      const { window } = ctx;

      const ids = (await createFreshGridPanels(2)).slice(0, 2);
      await armPanels(window, ids);
      for (const id of ids) {
        await expect(getPanelById(window, id)).toHaveAttribute("data-selected", "true", {
          timeout: T_MEDIUM,
        });
      }

      await test.step("Inject an EPIPE fault and broadcast", async () => {
        await injectFault(ctx.app, TERMINAL_SUBMIT_CHANNEL, "EPIPE: broken pipe on write", "EPIPE");
        await broadcastViaEditor(
          window,
          getPanelById(window, ids[0]!),
          ids[0]!,
          `echo fleet-perm-${Date.now()}`
        );
      });

      await test.step("Both dead panes auto-disarm and the ribbon collapses", async () => {
        for (const id of ids) {
          await expect(getPanelById(window, id)).not.toHaveAttribute("data-selected", "true", {
            timeout: T_LONG,
          });
        }
        await expect(window.locator(SEL.fleet.ribbon)).toBeHidden({ timeout: T_MEDIUM });
      });
    });

    test("cancelling a slow batched broadcast skips the later batch", async () => {
      test.setTimeout(200_000);
      const { window } = ctx;

      const ids = (await createFreshGridPanels(6)).slice(0, 6);
      await armPanels(window, ids);
      await expect
        .poll(
          async () => {
            const label =
              (await window.locator(SEL.fleet.armedCountChip).getAttribute("aria-label")) ?? "";
            const match = label.match(/^(\d+) in fleet/);
            return match ? Number(match[1]) : 0;
          },
          { timeout: T_MEDIUM }
        )
        .toBeGreaterThanOrEqual(6);

      // Cancellation only has an inter-batch boundary when more than five
      // targets receive a payload of at least 100 KB. The run status records
      // whether each PTY accepted a submit; shell execution of a 100 KB line
      // is not part of the fleet cancellation contract.
      const stamp = `fc${Date.now().toString(36)}`;
      const ack = `fleet-cancel-ack-${stamp}`;
      const largePayload =
        process.platform === "win32"
          ? `Write-Output '${ack}'\n# ${"A".repeat(103_000)}`
          : `printf '%s\\n' '${ack}'; : # ${"A".repeat(103_000)}`;

      await test.step("Send the oversized broadcast directly through the editor", async () => {
        await injectDelay(ctx.app, TERMINAL_SUBMIT_CHANNEL, 12_000);
        await focusHybridInput(window, getPanelById(window, ids[0]!), ids[0]!);
        await setHybridInputText(window, ids[0]!, largePayload);
        await expect
          .poll(() => getHybridInputText(window, ids[0]!), {
            timeout: T_MEDIUM,
            intervals: [100, 250],
          })
          .toContain(stamp);
        // Editor fleet broadcasts do not show a paste/destructive confirm;
        // arming is the consent boundary. The large payload still forces the
        // batched progress path below.
        await window.keyboard.press("Enter");
      });

      await test.step("Progress and cancel affordances surface, then cancel mid-flight", async () => {
        await expect(window.locator(SEL.fleet.broadcastProgress)).toBeVisible({ timeout: T_LONG });
        await expect(window.locator(SEL.fleet.broadcastCancel)).toBeVisible({ timeout: T_MEDIUM });
        await window.locator(SEL.fleet.broadcastCancel).click();
      });

      await test.step("The first batch lands and the sixth target in the later batch is skipped", async () => {
        await expect(window.locator(SEL.fleet.broadcastProgress)).toBeHidden({
          timeout: T_LONG * 3,
        });
        // A fulfilled submit means the PTY write queue accepted the bytes.
        // Unlike a shell acknowledgement, this observes unmounted panes too.
        const submissions = async () => {
          const status = await dispatchAction<{
            run: { targets: Array<{ terminalId: string; submission: string }> } | null;
          }>(window, "fleet.getRunStatus");
          expect(status.ok, status.error?.message).toBe(true);
          const byId = new Map(
            status.result?.run?.targets.map((target) => [target.terminalId, target.submission])
          );
          return ids.map((id) => byId.get(id) ?? "missing");
        };
        await expect
          .poll(submissions, { timeout: T_LONG })
          .toEqual(["sent", "sent", "sent", "sent", "sent", "skipped"]);
      });
    });
  });
});
