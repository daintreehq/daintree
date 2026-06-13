/**
 * Demo-mode terminal input — verifies the in-app demo automation engine
 * (window.electron.demo) can drive a real xterm.js terminal: type text
 * character-by-character into the PTY and send named special keys (arrows,
 * Ctrl-C, …).
 *
 * Unlike the synthetic-KeyboardEvent path used for CodeMirror/inputs, terminal
 * input routes through window.electron.terminal.write, so these assertions
 * prove the bytes actually reached the shell (it echoes them back).
 *
 * Run locally:
 *   npm run build:e2e
 *   npx playwright test e2e/demo/demo-terminal-input.spec.ts --project=demo
 */

import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { openTerminal, getFirstGridPanel } from "../helpers/panels";
import { getTerminalText, waitForTerminalReady, waitForTerminalText } from "../helpers/terminal";
import { T_LONG } from "../helpers/timeouts";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Demo mode — terminal typing and keys", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "demo-terminal-input" });
    fixtureCleanup = cleanup;
    ctx = await launchApp({ extraArgs: ["--demo-mode"] });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir);
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app).catch(() => {});
    fixtureCleanup?.();
  });

  test("types a command, recalls history, and interrupts", async () => {
    const { window } = ctx;

    // The demo bridge must be exposed (proves --demo-mode took effect).
    await window.waitForFunction(() => !!window.electron?.demo, undefined, { timeout: T_LONG });

    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });

    const panelId = await panel.evaluate(
      (el) => el.closest("[data-panel-id]")?.getAttribute("data-panel-id") ?? ""
    );
    expect(panelId).not.toBe("");
    const selector = `[data-panel-id="${panelId}"]`;

    await waitForTerminalReady(window, panel, T_LONG);

    // 1. Type `echo hi` and press Enter — the shell echoes the keystrokes and
    //    then prints `hi` on its own line.
    await window.evaluate(async (sel) => {
      const d = window.electron.demo!;
      await d.typeInTerminal(sel, "echo hi", 1000);
      await d.sendKeyToTerminal(sel, "enter");
    }, selector);
    await waitForTerminalText(panel, "hi", T_LONG);

    // 2. Press Up — the shell recalls the previous command, so `echo hi`
    //    appears a second time at the fresh prompt.
    const before = countOccurrences(await getTerminalText(panel), "echo hi");
    await window.evaluate(async (sel) => {
      await window.electron.demo!.sendKeyToTerminal(sel, "up");
    }, selector);
    await expect
      .poll(async () => countOccurrences(await getTerminalText(panel), "echo hi"), {
        timeout: T_LONG,
        intervals: [200, 500, 1000],
      })
      .toBeGreaterThan(before);

    // 3. Press Ctrl-C — aborts the recalled line without running it. The
    //    terminal must stay interactive afterwards, proven by running a fresh
    //    sentinel command. The sentinel is unique per run so the assertion is
    //    immune to anything already in the scrollback.
    const hiCountBeforeCtrlC = countOccurrences(await getTerminalText(panel), "hi");
    const sentinel = `DAINTREE_DEMO_KEYS_OK_${Date.now()}`;
    await window.evaluate(
      async ({ sel, token }) => {
        const d = window.electron.demo!;
        await d.sendKeyToTerminal(sel, "ctrl-c");
        await d.typeInTerminal(sel, `echo ${token}`, 1000);
        await d.sendKeyToTerminal(sel, "enter");
      },
      { sel: selector, token: sentinel }
    );
    await waitForTerminalText(panel, sentinel, T_LONG);
    // Ctrl-C must not have executed the recalled `echo hi` — output count unchanged.
    expect(countOccurrences(await getTerminalText(panel), "hi")).toBe(hiCountBeforeCtrlC);
  });
});
