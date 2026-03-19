import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../helpers/launch";
import { createFixtureRepo } from "../helpers/fixtures";
import { openAndOnboardProject } from "../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../helpers/terminal";
import { getFirstGridPanel } from "../helpers/panels";
import { SEL } from "../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;

test.describe.serial("Core: Terminal Scroll Indicator", () => {
  test.beforeAll(async () => {
    fixtureDir = createFixtureRepo({ name: "scroll-indicator" });
    ctx = await launchApp();
    await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Scroll Indicator Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
  });

  test("open terminal via toolbar", async () => {
    const { window } = ctx;
    await window.locator(SEL.toolbar.openTerminal).click();
    const panel = getFirstGridPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
  });

  test("indicator appears when scrolled up and new output arrives", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    // Disable animations so indicator visibility toggles instantly
    await window.emulateMedia({ reducedMotion: "reduce" });

    // Run a two-phase command: fill buffer immediately, then produce new output after 5s
    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=200;i++) console.log('SCRL_A_FILL_'+i); setTimeout(()=>{for(let i=1;i<=20;i++) console.log('SCRL_A_NEW_'+i)}, 5000)"`
    );

    // Wait for the fill phase to complete
    await waitForTerminalText(panel, "SCRL_A_FILL_200", T_LONG);

    // Scroll up using keyboard (proven pattern from core-terminal-search.spec.ts)
    await panel.locator(SEL.terminal.xtermRows).click();
    await window.waitForTimeout(T_SETTLE);
    for (let i = 0; i < 15; i++) {
      await window.keyboard.press("Shift+PageUp");
    }
    await window.waitForTimeout(T_SETTLE);

    // Wait for the delayed output to arrive (the node process is still running)
    await waitForTerminalText(panel, "SCRL_A_NEW_20", T_LONG);

    // The indicator should now be visible
    const indicator = panel.locator(SEL.terminal.scrollIndicator);
    await expect(indicator).toBeVisible({ timeout: T_MEDIUM });
  });

  test("clicking indicator scrolls to bottom and hides it", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);
    const indicator = panel.locator(SEL.terminal.scrollIndicator);

    // Click the indicator
    await indicator.click();

    // Indicator should disappear (with reduced motion, shouldRender toggles immediately)
    await expect(indicator).not.toBeVisible({ timeout: T_SHORT });

    // Verify auto-scroll resumed: run a follow-up command and check indicator stays hidden
    await runTerminalCommand(window, panel, `node -e "console.log('SCRL_A_VERIFY')"`);
    await waitForTerminalText(panel, "SCRL_A_VERIFY", T_LONG);
    await window.waitForTimeout(T_SETTLE);
    await expect(indicator).not.toBeVisible();
  });

  test("indicator does not appear when already at bottom", async () => {
    const { window } = ctx;
    const panel = getFirstGridPanel(window);

    // Run a command with delayed output WITHOUT scrolling up
    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=50;i++) console.log('SCRL_B_FILL_'+i); setTimeout(()=>{for(let i=1;i<=10;i++) console.log('SCRL_B_NEW_'+i)}, 2000)"`
    );

    // Wait for all output to arrive
    await waitForTerminalText(panel, "SCRL_B_NEW_10", T_LONG);
    await window.waitForTimeout(T_SETTLE);

    // Indicator should NOT be visible since we never scrolled up
    const indicator = panel.locator(SEL.terminal.scrollIndicator);
    await expect(indicator).not.toBeVisible();
  });
});
