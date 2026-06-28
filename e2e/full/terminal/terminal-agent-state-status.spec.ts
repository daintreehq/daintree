import { test, expect, type Locator, type Page } from "@playwright/test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getTerminalText,
  waitForTerminalText,
  waitForTerminalReady,
  writeTerminalInput,
  openTerminalContextMenu,
  clickTerminalContextMenuItem,
} from "../../helpers/terminal";
import { spawnTerminalAndVerify } from "../../helpers/workflows";
import { getGridPanelIds } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_LONG, T_MEDIUM, T_SHORT } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";

let ctx: AppContext;
let fixtureDir: string;
let fakeBinDir: string;
let fixtureCleanup: (() => void) | undefined;

const FAKE_CLAUDE_STOP = "__DAINTREE_FAKE_CLAUDE_STOP__";
const FAKE_CLAUDE_IDLE = "__DAINTREE_FAKE_CLAUDE_IDLE__";

// The waiting transition is governed by the 8s idle debounce in
// ActivityMonitor (`IDLE_DEBOUNCE_MS` for agent terminals). The OSC heartbeat
// stops the moment we send the idle token, but the echo of that input resets
// the activity clock once, so give the poll a generous window above the
// debounce. Scale off T_LONG so slow CI runners (3×, Windows 5×) inherit the
// same headroom rather than racing a hardcoded ceiling.
const T_WAITING = T_LONG * 2;

async function ptyWrite(page: Page, terminalId: string, data: string): Promise<void> {
  const result = await page.evaluate(
    ([id, payload]) => {
      const w = window as unknown as {
        electron?: { terminal?: { write?: (id: string, data: string) => void } };
      };
      if (!w.electron?.terminal?.write) {
        return { ok: false, reason: "terminal.write API missing" };
      }
      w.electron.terminal.write(id, payload);
      return { ok: true };
    },
    [terminalId, data]
  );

  if (!result.ok) throw new Error(`ptyWrite failed: ${result.reason}`);
}

async function newestPanelId(page: Page, previousIds: Set<string>): Promise<string> {
  await expect
    .poll(async () => (await getGridPanelIds(page)).filter((id) => !previousIds.has(id)).length, {
      timeout: T_LONG,
      intervals: [250],
    })
    .toBeGreaterThan(0);
  const ids = await getGridPanelIds(page);
  const id = ids.find((candidate) => !previousIds.has(candidate));
  expect(id).toBeTruthy();
  return id!;
}

async function confirmClaudeWorkspaceTrustIfPrompted(page: Page, panel: Locator): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const lower = (await getTerminalText(panel)).toLowerCase();
    if (lower.includes("fake_claude_ready")) return;
    if (
      lower.includes("accessing workspace") ||
      lower.includes("yes, i trust this folder") ||
      lower.includes("enter to confirm")
    ) {
      await writeTerminalInput(page, panel, "\r");
      return;
    }
    await page.waitForTimeout(250);
  }
}

/**
 * Launch the fake Claude agent from the toolbar tray and drive it to a live,
 * working agent session. Returns the panel id + locator. The fake binary emits
 * OSC 9;4 progress sequences so the working state is driven by a
 * viewport-independent signal rather than output volume, which is unreliable in
 * small CI grid tiles (#8753).
 */
async function launchWorkingClaude(page: Page): Promise<{ panelId: string; panel: Locator }> {
  const beforeIds = new Set(await getGridPanelIds(page));
  await dismissBlockingPalette(page);
  await page.locator(SEL.agent.trayButton).click();
  await page.getByRole("menuitem", { name: "Claude" }).click();

  const panelId = await newestPanelId(page, beforeIds);
  const panel = page.locator(`[data-panel-id="${panelId}"]`);
  await confirmClaudeWorkspaceTrustIfPrompted(page, panel);
  await waitForTerminalText(panel, "FAKE_CLAUDE_READY", T_LONG);

  await expect
    .poll(() => panel.getAttribute("data-detected-agent-id"), {
      timeout: 60_000,
      intervals: [250, 500],
    })
    .toBe("claude");

  // The fake binary emits OSC 9;4 working on a heartbeat after READY, so the
  // panel settles on the working state independent of byte volume.
  await expect
    .poll(() => panel.getAttribute("data-agent-state"), {
      timeout: T_LONG,
      intervals: [250, 500],
    })
    .toBe("working");

  return { panelId, panel };
}

function prepareFixture(): void {
  const { dir, cleanup } = createFixtureRepo({ name: "terminal-agent-state-status" });
  fixtureDir = dir;
  fixtureCleanup = cleanup;
  // Keep a space in the fake CLI path so toolbar launches exercise the same
  // quoted absolute executable form that real resolved paths can use.
  fakeBinDir = path.join(fixtureDir, ".e2e bin");
  mkdirSync(fakeBinDir, { recursive: true });

  const fakeClaudeImplName = process.platform === "win32" ? "claude.js" : "claude";
  const fakeClaude = path.join(fakeBinDir, fakeClaudeImplName);

  writeFileSync(
    fakeClaude,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('--version')) {",
      "  console.log('claude code v9.9.9');",
      "  process.exit(0);",
      "}",
      `const stopToken = ${JSON.stringify(FAKE_CLAUDE_STOP)};`,
      `const idleToken = ${JSON.stringify(FAKE_CLAUDE_IDLE)};`,
      // OSC 9;4 taskbar-progress: state 1 = working, state 0 = idle hint.
      "const OSC_WORKING = '\\u001b]9;4;1;0\\u0007';",
      "const OSC_IDLE = '\\u001b]9;4;0;0\\u0007';",
      "console.log('Accessing workspace:');",
      "console.log('');",
      "console.log(' ' + process.cwd());",
      "console.log('');",
      "console.log(' Quick safety check: Is this a project you created or one you trust?');",
      "console.log('');",
      "console.log(' ❯ 1. Yes, I trust this folder');",
      "console.log('   2. No, exit');",
      "console.log('');",
      "console.log(' Enter to confirm · Esc to cancel');",
      "process.stdin.resume();",
      "process.stdin.setEncoding('utf8');",
      "let trusted = false;",
      "let workingTimer = null;",
      "const keepAlive = setInterval(() => {}, 1000);",
      "const startWorking = () => {",
      "  if (workingTimer) return;",
      "  process.stdout.write(OSC_WORKING);",
      "  workingTimer = setInterval(() => process.stdout.write(OSC_WORKING), 1000);",
      "};",
      "const stopWorking = () => {",
      "  if (workingTimer) { clearInterval(workingTimer); workingTimer = null; }",
      "  process.stdout.write(OSC_IDLE);",
      "};",
      "const shutdown = () => {",
      "  stopWorking();",
      "  console.log('FAKE_CLAUDE_EXIT');",
      "  clearInterval(keepAlive);",
      "  process.exit(0);",
      "};",
      "process.stdin.on('data', (chunk) => {",
      "  const input = String(chunk);",
      "  if (!trusted && /[\\r\\n]/.test(input)) {",
      "    trusted = true;",
      "    console.log('FAKE_CLAUDE_READY');",
      "    startWorking();",
      "    return;",
      "  }",
      "  if (!trusted) return;",
      "  if (input.includes(stopToken)) { shutdown(); return; }",
      "  if (input.includes(idleToken)) { stopWorking(); return; }",
      "});",
      "process.on('SIGINT', shutdown);",
      "process.on('SIGTERM', shutdown);",
      "",
    ].join("\n")
  );
  chmodSync(fakeClaude, 0o755);

  if (process.platform === "win32") {
    writeFileSync(
      path.join(fakeBinDir, "claude.cmd"),
      ["@echo off", 'node "%~dp0claude.js" %*', ""].join("\r\n")
    );
  }

  writeFileSync(
    path.join(fixtureDir, "package.json"),
    JSON.stringify(
      { name: "terminal-agent-state-status", version: "1.0.0", private: true },
      null,
      2
    ) + "\n"
  );
  execSync("git add -A && git commit -m state-status-fixture", {
    cwd: fixtureDir,
    stdio: "ignore",
  });
}

test.describe.serial("Full: terminal agent-state and status surfaces", () => {
  test.beforeAll(async () => {
    prepareFixture();
    ctx = await launchApp({
      env: {
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        DAINTREE_CLI_PATH_PREPEND: fakeBinDir,
        DAINTREE_IDENTITY_DEBUG_PASS: "1",
      },
    });
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Terminal Agent State Status"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("agent session drives the working→waiting state arc, chip, and hybrid input bar", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;

    const { panelId, panel } = await launchWorkingClaude(window);

    await test.step("working state surfaces the agent chip and an active hybrid input bar", async () => {
      // The agent-state chip is a role=status element labelled with the state.
      const chip = panel.locator(SEL.terminal.agentStateChip);
      await expect(chip).toBeVisible({ timeout: T_MEDIUM });
      await expect(chip).toHaveAttribute("aria-label", "Agent state: working");

      // The hybrid input bar renders for agent panels (CodeMirror editor) and is
      // not disabled while the backend is connected and the agent is working.
      const editor = panel.locator(SEL.terminal.cmEditor);
      await expect(editor).toBeVisible({ timeout: T_MEDIUM });
      const picker = panel.locator('[aria-label="Open command picker"]');
      await expect(picker).toBeVisible({ timeout: T_MEDIUM });
      await expect(picker).toBeEnabled();
    });

    await test.step("agent transitions to waiting once the OSC heartbeat stops", async () => {
      // Stop the working heartbeat. After the idle debounce elapses with no
      // further output, the agent settles into the waiting state.
      await ptyWrite(window, panelId, `${FAKE_CLAUDE_IDLE}\r`);
      await expect
        .poll(() => panel.getAttribute("data-agent-state"), {
          timeout: T_WAITING,
          intervals: [500, 1000],
        })
        .toBe("waiting");
      // The visible chip must track the FSM, not lag on the prior label.
      await expect(panel.locator(SEL.terminal.agentStateChip)).toHaveAttribute(
        "aria-label",
        "Agent state: waiting"
      );
    });

    await test.step("agent state clears when the session exits", async () => {
      await ptyWrite(window, panelId, `${FAKE_CLAUDE_STOP}\r`);
      await waitForTerminalText(panel, "FAKE_CLAUDE_EXIT", T_LONG);
      await expect
        .poll(() => panel.getAttribute("data-agent-state"), {
          timeout: T_LONG,
          intervals: [250, 500],
        })
        .toBeNull();
    });
  });

  test("exit-error restart banner exposes a working Restart action", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    const panel = await spawnTerminalAndVerify(window);
    const panelId = await panel.evaluate((el) => {
      const p = el.closest("[data-panel-id]");
      return p?.getAttribute("data-panel-id") ?? "";
    });

    // A non-zero exit always preserves the terminal for debugging, surfacing the
    // exit-error restart banner with a single recovery action.
    await ptyWrite(window, panelId, "exit 1\r");

    const banner = panel.getByRole("alert");
    await expect(banner).toContainText("Session exited with code 1", { timeout: T_LONG });

    const restartAction = panel.locator(SEL.terminal.restartBannerAction);
    await expect(restartAction).toBeVisible({ timeout: T_MEDIUM });
    await expect(restartAction).toBeEnabled();

    // Clicking Restart respawns the PTY and clears the exit-error banner.
    await restartAction.click();
    await expect(banner).not.toBeVisible({ timeout: T_LONG });
    // The recovery action is only meaningful if the PTY is actually live again,
    // not merely if the banner was dismissed.
    await waitForTerminalReady(window, panel, T_LONG);
  });

  test("context menu gates destructive actions while an agent is working", async () => {
    test.setTimeout(180_000);
    const { window } = ctx;

    const { panelId, panel } = await launchWorkingClaude(window);

    await openTerminalContextMenu(panel);

    // Opening the menu involves clicks that can momentarily repaint the pane
    // (#8867); re-confirm the working state before asserting the gated items.
    await expect
      .poll(() => panel.getAttribute("data-agent-state"), {
        timeout: T_MEDIUM,
        intervals: [250],
      })
      .toBe("working");

    await test.step("Restart Terminal opens a confirmation dialog instead of firing", async () => {
      await clickTerminalContextMenuItem(panel, "Restart Terminal");
      const dialog = window.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(dialog).toContainText("Restart terminal with running agent?");
      // Cancel — leave the agent session intact.
      await window.locator('[data-confirm-role="cancel"]').click();
      await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("Kill Terminal is guarded by the same confirmation while working", async () => {
      await openTerminalContextMenu(panel);
      await clickTerminalContextMenuItem(panel, "Kill Terminal");
      const dialog = window.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
      await expect(dialog).toContainText("Kill terminal with running agent?");
      await window.locator('[data-confirm-role="cancel"]').click();
      await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });
    });

    await test.step("Escape closes the context menu", async () => {
      await openTerminalContextMenu(panel);
      const menu = window.locator(SEL.contextMenu.content);
      await expect(menu).toBeVisible({ timeout: T_SHORT });
      await window.keyboard.press("Escape");
      await expect(menu).not.toBeVisible({ timeout: T_MEDIUM });
    });

    // Clean up the agent session so it doesn't bleed into afterAll teardown.
    await ptyWrite(window, panelId, `${FAKE_CLAUDE_STOP}\r`);
    await waitForTerminalText(panel, "FAKE_CLAUDE_EXIT", T_LONG);
  });
});
