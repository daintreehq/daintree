import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  waitForTerminalText,
  waitForTerminalTextIgnoringLineBreaks,
  runTerminalCommand,
} from "../../helpers/terminal";
import { expectTerminalFocused } from "../../helpers/focus";
import { getFirstGridPanel, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

test.describe.serial("Core: SAB Fallback (IPC-only terminal output)", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({ name: "sab-fallback" }));
    ctx = await launchApp({
      extraArgs: ["--disable-features=SharedArrayBuffer"],
    });
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "SAB Fallback Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("opens a terminal with SAB disabled", async () => {
    const { window } = ctx;
    // SAB-based terminal transport is unavailable (PTY host runs in a UtilityProcess
    // that can't share buffers), so the bridge hands back no transport buffers and the
    // app falls through to the IPC path. The renderer's SharedArrayBuffer global may
    // still exist — the load-bearing signal is the empty buffer handshake, not the global.
    const buffers = await window.evaluate(() => window.electron.terminal.getSharedBuffers());
    expect(buffers.signalBuffer).toBeNull();
    expect(buffers.visualBuffers).toHaveLength(0);

    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
  });

  test("renders command output via IPC fallback", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);
    await runTerminalCommand(window, panel, "node -e \"console.log('SAB_FALLBACK_OK')\"");
    await waitForTerminalText(panel, "SAB_FALLBACK_OK", T_LONG);
  });

  test("find-in-panel works in IPC-only mode", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    await panel.locator(SEL.terminal.xtermRows).click();
    await window.waitForTimeout(T_SETTLE);
    await expectTerminalFocused(panel);
    await window.evaluate(() => window.dispatchEvent(new CustomEvent("daintree:find-in-panel")));

    const searchInput = panel.locator(SEL.terminal.searchInput);
    await expect(searchInput).toBeVisible({ timeout: T_MEDIUM });

    await searchInput.fill("SAB_FALLBACK_OK");
    await window.waitForTimeout(T_SETTLE);

    // Status may be "Found" (no count) or "N of M" depending on match-results
    // availability. Either indicates a successful search hit.
    await expect(panel.locator(SEL.terminal.searchStatus)).toHaveText(/^(Found|\d+ of \d+)$/, {
      timeout: T_MEDIUM,
    });

    await searchInput.focus();
    await window.keyboard.press("Escape");
    await expect(searchInput).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("renders 150 lines of multi-line output", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    await runTerminalCommand(
      window,
      panel,
      "node -e \"console.log('MULTI_TOP'); for(let i=1;i<=150;i++) console.log(i); console.log('MULTI_BOTTOM')\""
    );
    await waitForTerminalTextIgnoringLineBreaks(panel, "149150MULTI_BOTTOM", T_LONG);

    // The scrollback buffer must retain the full 150-line run end-to-end via the
    // IPC-fed ring buffer: the top sentinel and a mid-run line are only present if
    // the lines scrolled out of the viewport were captured, not just the tail.
    await waitForTerminalText(panel, "MULTI_TOP", T_MEDIUM);
    await waitForTerminalTextIgnoringLineBreaks(panel, "747576", T_MEDIUM);
  });
});
