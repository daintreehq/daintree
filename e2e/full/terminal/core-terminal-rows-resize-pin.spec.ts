import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { waitForTerminalText, runTerminalCommand } from "../../helpers/terminal";
import { getGridPanelIds, getPanelById, openTerminal } from "../../helpers/panels";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;
let terminalPanelId: string | undefined;

type TerminalScrollState = {
  viewportY: number;
  baseY: number;
  isUserScrolledBack: boolean;
  cols: number;
  rows: number;
  scrollTop: number | null;
  maxScrollTop: number | null;
};

type TerminalScrollHooks = {
  __daintreeGetTerminalScrollState?: (panelId: string) => TerminalScrollState | null;
  __daintreeScrollTerminalLines?: (panelId: string, lines: number) => TerminalScrollState | null;
  __daintreeSimulateTerminalResize?: (
    panelId: string,
    width: number,
    height: number
  ) => { cols: number; rows: number } | null;
};

function panelId(): string {
  if (!terminalPanelId) throw new Error("Could not resolve terminal panel ID");
  return terminalPanelId;
}

async function getScrollState(page: Page): Promise<TerminalScrollState> {
  const state = await page.evaluate((id) => {
    const hooks = window as unknown as TerminalScrollHooks;
    return hooks.__daintreeGetTerminalScrollState?.(id) ?? null;
  }, panelId());
  if (!state) throw new Error("Terminal scroll state unavailable");
  return state;
}

async function scrollLines(page: Page, lines: number): Promise<void> {
  await page.evaluate(
    ({ id, lineCount }) => {
      const hooks = window as unknown as TerminalScrollHooks;
      hooks.__daintreeScrollTerminalLines?.(id, lineCount);
    },
    { id: panelId(), lineCount: lines }
  );
}

async function simulateResize(
  page: Page,
  width: number,
  height: number
): Promise<{ cols: number; rows: number } | null> {
  return page.evaluate(
    ({ id, w, h }) => {
      const hooks = window as unknown as TerminalScrollHooks;
      return hooks.__daintreeSimulateTerminalResize?.(id, w, h) ?? null;
    },
    { id: panelId(), w: width, h: height }
  );
}

/**
 * The viewport is where the buffer says it is. `viewportY >= baseY` alone
 * cannot answer this — a rows-only resize leaves it true while the scrollable
 * element is still parked rows higher, which is the whole of #11709.
 */
function isVisuallyPinned(state: TerminalScrollState): boolean {
  if (state.scrollTop === null || state.maxScrollTop === null) return false;
  return Math.abs(state.maxScrollTop - state.scrollTop) < 1;
}

test.describe.serial("Core: Terminal rows-only resize keeps the viewport pinned", () => {
  test.beforeAll(async () => {
    terminalPanelId = undefined;
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "rows-resize-pin",
    }));
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Rows Resize Pin");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("a rows-only shrink does not strand a bottom-pinned viewport in scrollback", async () => {
    const { window } = ctx;

    await openTerminal(window);
    await expect
      .poll(() => getGridPanelIds(window).then((ids) => ids.length), {
        timeout: T_LONG,
        intervals: [100, 250, 500],
      })
      .toBeGreaterThan(0);
    const ids = await getGridPanelIds(window);
    terminalPanelId = ids[ids.length - 1];
    const panel = await getPanelById(window, panelId());
    await expect(panel).toBeVisible({ timeout: T_LONG });

    // Real scrollback to scroll through — without it ybase stays 0 and the
    // resize has no lines to spill, so there is nothing to get stranded above.
    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=200;i++) console.log('ROWPIN_'+i)"`
    );
    await waitForTerminalText(panel, "ROWPIN_200", T_LONG);
    await window.waitForTimeout(T_SETTLE);

    // Prime xterm's cached viewport position the only way that matters: a real
    // scroll round-trip. An un-primed cache self-heals on the next sync, which
    // is exactly why this bug only ever showed up intermittently.
    await scrollLines(window, -40);
    await window.waitForTimeout(T_SETTLE);
    await scrollLines(window, 40);
    await window.waitForTimeout(T_SETTLE);

    const before = await getScrollState(window);
    expect(before.baseY).toBeGreaterThan(0);
    expect(before.viewportY).toBe(before.baseY);
    // Guard the fixture itself: if the terminal is not visually pinned before
    // the resize, the assertion after it would prove nothing either way.
    expect(isVisuallyPinned(before), `not pinned before resize: ${JSON.stringify(before)}`).toBe(
      true
    );

    const box = await panel.boundingBox();
    if (!box) throw new Error("Terminal panel has no layout box");

    // Same width, shorter box — what growing the hybrid input does. Columns
    // must not move, or this exercises the column-reflow path (#11316) instead.
    await simulateResize(window, box.width, box.height);
    await window.waitForTimeout(T_SETTLE);
    const baseline = await getScrollState(window);

    await simulateResize(window, box.width, box.height - 3 * before.rows);
    await window.waitForTimeout(T_SETTLE);

    const after = await getScrollState(window);
    expect(after.cols, `columns moved — not a rows-only resize: ${JSON.stringify(after)}`).toBe(
      baseline.cols
    );
    expect(after.rows, `rows did not shrink: ${JSON.stringify(after)}`).toBeLessThan(baseline.rows);

    // The logical half passes with or without the fix; it is the visual half
    // that regresses, and the two disagreeing is the defect itself.
    expect(after.isUserScrolledBack).toBe(false);
    expect(after.viewportY).toBe(after.baseY);
    await expect
      .poll(async () => isVisuallyPinned(await getScrollState(window)), {
        timeout: T_LONG,
        intervals: [100, 250, 500],
      })
      .toBe(true);
  });
});
