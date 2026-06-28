import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../../helpers/terminal";
import { getGridPanelIds, getPanelById, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG, T_SETTLE } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let terminalPanelId: string | undefined;

type TerminalScrollState = {
  viewportY: number;
  baseY: number;
  isUserScrolledBack: boolean;
};

type TerminalScrollHooks = {
  __daintreeGetTerminalScrollState?: (panelId: string) => TerminalScrollState | null;
  __daintreeScrollTerminalLines?: (panelId: string, lines: number) => TerminalScrollState | null;
};

async function getTerminalPanel(page: Page): Promise<Locator> {
  if (terminalPanelId) {
    return getPanelById(page, terminalPanelId);
  }

  const panelIds = await getGridPanelIds(page);
  terminalPanelId = panelIds[panelIds.length - 1];
  if (!terminalPanelId) {
    throw new Error("Could not resolve terminal panel ID");
  }
  return getPanelById(page, terminalPanelId);
}

async function getTerminalScrollState(page: Page): Promise<TerminalScrollState | null> {
  if (!terminalPanelId) {
    throw new Error("Could not resolve terminal panel ID");
  }

  return page.evaluate((panelId) => {
    const hooks = window as unknown as TerminalScrollHooks;
    return hooks.__daintreeGetTerminalScrollState?.(panelId) ?? null;
  }, terminalPanelId);
}

function isScrolledBack(state: TerminalScrollState | null): boolean {
  return Boolean(state && state.isUserScrolledBack && state.viewportY < state.baseY);
}

async function scrollTerminalLines(page: Page, lines: number): Promise<TerminalScrollState | null> {
  if (!terminalPanelId) {
    throw new Error("Could not resolve terminal panel ID");
  }

  return page.evaluate(
    ({ panelId, lineCount }) => {
      const hooks = window as unknown as TerminalScrollHooks;
      return hooks.__daintreeScrollTerminalLines?.(panelId, lineCount) ?? null;
    },
    { panelId: terminalPanelId, lineCount: lines }
  );
}

async function scrollTerminalBack(panel: Locator): Promise<void> {
  const page = panel.page();

  await dismissBlockingPalette(page);
  await panel.locator(SEL.terminal.xtermRows).click();
  await page.waitForTimeout(T_SETTLE);

  for (let i = 0; i < 15; i++) {
    await page.keyboard.press("Shift+PageUp");
  }
  await page.waitForTimeout(T_SETTLE);

  if (!isScrolledBack(await getTerminalScrollState(page))) {
    await scrollTerminalLines(page, -80);
  }

  try {
    await expect
      .poll(async () => isScrolledBack(await getTerminalScrollState(page)), {
        timeout: T_MEDIUM,
        intervals: [100, 250, 500],
      })
      .toBe(true);
  } catch (error) {
    const state = await getTerminalScrollState(page);
    throw new Error(`Terminal did not scroll back: ${JSON.stringify(state)}`, { cause: error });
  }
}

test.describe.serial("Core: Terminal Scroll Indicator", () => {
  test.beforeAll(async () => {
    terminalPanelId = undefined;
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "scroll-indicator",
    }));
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Scroll Indicator Test"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("open terminal via toolbar", async () => {
    const { window } = ctx;
    await openTerminal(window);
    await expect
      .poll(() => getGridPanelIds(window).then((ids) => ids.length), {
        timeout: T_LONG,
        intervals: [100, 250, 500],
      })
      .toBeGreaterThan(0);
    const panelIds = await getGridPanelIds(window);
    terminalPanelId = panelIds[panelIds.length - 1];
    const panel = await getTerminalPanel(window);
    await expect(panel).toBeVisible({ timeout: T_LONG });
  });

  test("indicator appears when scrolled up and new output arrives", async () => {
    const { window } = ctx;
    const panel = await getTerminalPanel(window);

    // Disable animations so indicator visibility toggles instantly
    await window.emulateMedia({ reducedMotion: "reduce" });

    const delayedOutputMs = process.env.CI ? 25_000 : 8_000;

    // Run a two-phase command: fill buffer immediately, then produce delayed output
    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=200;i++) console.log('SCRL_A_FILL_'+i); setTimeout(()=>{let i=0; const t=setInterval(()=>{i++; console.log('SCRL_A_NEW_'+i); if(i>=20) clearInterval(t)}, 150)}, ${delayedOutputMs})"`
    );

    // Wait for the fill phase to complete
    await waitForTerminalText(panel, "SCRL_A_FILL_200", T_LONG);

    await scrollTerminalBack(panel);

    // Indicator should NOT be visible yet (scrolling alone doesn't trigger it)
    const indicator = panel.locator(SEL.terminal.scrollIndicator);
    await expect(indicator).not.toBeVisible();

    // Wait for the delayed output to arrive (the node process is still running).
    // The local producer intentionally starts after 8s and then takes another
    // few seconds to emit all lines, so the generic local T_LONG can be too
    // tight on a busy machine.
    await waitForTerminalText(panel, "SCRL_A_NEW_20", delayedOutputMs + T_LONG);

    // The indicator should now be visible
    await expect(indicator).toBeVisible({ timeout: T_MEDIUM });
  });

  test("clicking indicator scrolls to bottom and hides it", async () => {
    const { window } = ctx;
    const panel = await getTerminalPanel(window);
    const indicator = panel.locator(SEL.terminal.scrollIndicator);

    // Click the indicator
    await indicator.click();

    // Indicator should disappear (with reduced motion, shouldRender toggles immediately)
    await expect(indicator).not.toBeVisible({ timeout: T_SHORT });

    // Verify auto-scroll resumed: run a follow-up command and check indicator stays hidden
    await runTerminalCommand(window, panel, `node -e "console.log('SCRL_A_VERIFY')"`);
    await waitForTerminalText(panel, "SCRL_A_VERIFY", T_LONG);
    await window.waitForTimeout(T_SETTLE);
    await expect(indicator).not.toBeVisible({ timeout: T_SHORT });
  });

  test("indicator does not appear when already at bottom", async () => {
    const { window } = ctx;
    const panel = await getTerminalPanel(window);

    const delayMs = process.env.CI ? 6_000 : 2_000;
    // Run a command with delayed output WITHOUT scrolling up
    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=50;i++) console.log('SCRL_B_FILL_'+i); setTimeout(()=>{for(let i=1;i<=10;i++) console.log('SCRL_B_NEW_'+i)}, ${delayMs})"`
    );

    // Wait for all output to arrive
    await waitForTerminalText(panel, "SCRL_B_NEW_10", T_LONG);
    await window.waitForTimeout(T_SETTLE);

    // Indicator should NOT be visible since we never scrolled up
    const indicator = panel.locator(SEL.terminal.scrollIndicator);
    await expect(indicator).not.toBeVisible();
  });
});
