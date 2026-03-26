import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { getGridPanelCount, getGridPanelIds, getPanelById, openTerminal } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_LONG, T_SETTLE } from "../helpers/timeouts";

test.skip(process.platform === "win32", "Terminal isolation tests use Unix shell loops");

let ctx: AppContext;
let fixtureDir: string;
let floodPanelId: string;
let probePanelId: string;

/**
 * Write a command directly to a terminal PTY via IPC.
 * More reliable than keyboard typing when multiple terminals are active,
 * since page.keyboard.type() sends characters one-by-one through the
 * browser event loop and can drop keystrokes under load.
 */
async function _ptyWrite(page: import("@playwright/test").Page, panelId: string, data: string) {
  await page.evaluate(
    ([id, d]) =>
      (
        window as unknown as { electron: { terminal: { write: (id: string, d: string) => void } } }
      ).electron.terminal.write(id, d),
    [panelId, data]
  );
}

test.describe.serial("Core: Terminal Isolation", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "terminal-isolation" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Terminal Isolation Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("flood one terminal while another remains responsive", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    // Open 3 terminals
    for (let i = 0; i < 3; i++) {
      await openTerminal(window);
      await window.waitForTimeout(T_SETTLE);
    }
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);

    // Identify panels
    const ids = await getGridPanelIds(window);
    expect(ids.length).toBe(3);
    floodPanelId = ids[0];
    probePanelId = ids[1];

    const floodPanel = getPanelById(window, floodPanelId);
    const probePanel = getPanelById(window, probePanelId);

    // Wait for shell readiness in both terminals
    await waitForTerminalText(floodPanel, "terminal-isolation", T_LONG);
    await waitForTerminalText(probePanel, "terminal-isolation", T_LONG);

    // Start throttled flood in the first terminal
    await runTerminalCommand(
      window,
      floodPanel,
      "while true; do echo FLOOD_LINE; sleep 0.02; done"
    );
    await waitForTerminalText(floodPanel, "FLOOD_LINE", T_LONG);

    // Send probe command in the second terminal while flood is active
    await runTerminalCommand(window, probePanel, "echo RESPONSE_OK");
    await waitForTerminalText(probePanel, "RESPONSE_OK", T_LONG);

    // Verify toolbar remains interactive (app is not frozen)
    await expect(window.locator(SEL.toolbar.toggleSidebar)).toBeVisible();
  });

  test("flooded terminal recovers after stopping flood", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    const floodPanel = getPanelById(window, floodPanelId);

    // Send Ctrl+C to interrupt the flood
    const xterm = floodPanel.locator(SEL.terminal.xtermRows);
    await xterm.click();
    await window.keyboard.press("Control+c");

    // Wait for shell to settle after interrupt
    await window.waitForTimeout(T_SETTLE);

    // Run recovery command in the previously flooded terminal
    await runTerminalCommand(window, floodPanel, "echo FLOOD_RECOVERED");
    await waitForTerminalText(floodPanel, "FLOOD_RECOVERED", T_LONG);
  });
});
