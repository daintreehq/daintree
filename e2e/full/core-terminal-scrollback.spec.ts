import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { getTerminalText, waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { getFirstGridPanel, openTerminal } from "../helpers/panels";
import { T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Terminal Scrollback Integrity Under Load", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "terminal-scrollback" });
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Scrollback Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("set scrollback and open terminal", async () => {
    const { window } = ctx;

    // Set base scrollback to 5000 so terminal panels get 5000 * 0.3 = 1500 effective lines.
    // Must use the action dispatcher (not the IPC bridge directly) because the action
    // updates both the renderer Zustand store AND persists via IPC.
    await window.evaluate(async () => {
      const dispatch = (window as unknown as Record<string, unknown>).__canopyDispatchAction as (
        id: string,
        args?: unknown,
        opts?: unknown
      ) => Promise<unknown>;
      await dispatch("terminalConfig.setScrollback", {
        scrollbackLines: 5000,
      });
    });
    await window.waitForTimeout(T_SETTLE);

    await openTerminal(window);
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
  });

  test("output 5000 ANSI-colored numbered lines", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=5000;i++) process.stdout.write('\\x1b[31mLINE_'+String(i).padStart(5,'0')+'\\x1b[0m\\n')"`
    );

    await waitForTerminalText(panel, "LINE_05000", T_LONG);
  });

  test("buffer retains approximately 1500 lines after ring buffer trimming", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    const text = await getTerminalText(panel);
    const lines = text.split("\n");

    // Extract all LINE_XXXXX entries
    const lineNumbers: number[] = [];
    const linePattern = /LINE_(\d{5})/;
    for (const line of lines) {
      const match = line.match(linePattern);
      if (match) lineNumbers.push(parseInt(match[1], 10));
    }

    // Newest line should be 5000
    const newest = Math.max(...lineNumbers);
    expect(newest).toBe(5000);

    // Oldest line should be approximately 3500 (±100 to account for viewport rows)
    const oldest = Math.min(...lineNumbers);
    expect(oldest).toBeGreaterThan(3400);
    expect(oldest).toBeLessThan(3550);

    // Total retained lines should be approximately 1500 (upper bound generous for viewport rows)
    expect(lineNumbers.length).toBeGreaterThan(1400);
    expect(lineNumbers.length).toBeLessThan(1650);

    // Verify contiguous ascending sequence (no gaps or duplicates = true integrity)
    const sorted = [...lineNumbers].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1);
    }
  });

  test("terminal remains interactive after flood", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    await runTerminalCommand(window, panel, "echo INTERACTIVE_CHECK");
    await waitForTerminalText(panel, "INTERACTIVE_CHECK", T_LONG);
  });
});
