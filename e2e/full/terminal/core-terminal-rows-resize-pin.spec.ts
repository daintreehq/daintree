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

/**
 * Long enough for the animation frame that carries xterm's queued viewport
 * sync, short enough to stay inside the reconciliation watchdog's 3s sweep —
 * which measures the LIVE container and would undo the simulated grid below.
 */
const SYNC_FRAME_MS = 250;

function panelId(): string {
  if (!terminalPanelId) throw new Error("Could not resolve terminal panel ID");
  return terminalPanelId;
}

async function getScrollState(page: Page): Promise<TerminalScrollState> {
  const state = await page.evaluate((id) => {
    const hooks = window as unknown as TerminalScrollHooks;
    if (!hooks.__daintreeGetTerminalScrollState) throw new Error("scroll-state hook missing");
    return hooks.__daintreeGetTerminalScrollState(id);
  }, panelId());
  if (!state) throw new Error("Terminal scroll state unavailable");
  return state;
}

async function scrollLines(page: Page, lines: number): Promise<TerminalScrollState> {
  const state = await page.evaluate(
    ({ id, lineCount }) => {
      const hooks = window as unknown as TerminalScrollHooks;
      if (!hooks.__daintreeScrollTerminalLines) throw new Error("scroll-lines hook missing");
      return hooks.__daintreeScrollTerminalLines(id, lineCount);
    },
    { id: panelId(), lineCount: lines }
  );
  if (!state) throw new Error("Terminal scroll state unavailable after scroll");
  return state;
}

async function simulateResize(
  page: Page,
  width: number,
  height: number
): Promise<{ cols: number; rows: number }> {
  const grid = await page.evaluate(
    ({ id, w, h }) => {
      const hooks = window as unknown as TerminalScrollHooks;
      if (!hooks.__daintreeSimulateTerminalResize) throw new Error("resize hook missing");
      return hooks.__daintreeSimulateTerminalResize(id, w, h);
    },
    { id: panelId(), w: width, h: height }
  );
  // A converged resize returns null — the grid did not move, which is a valid
  // outcome for the baseline call below.
  return grid ?? (await getScrollState(page));
}

/**
 * Is the viewport where the buffer says it is? `viewportY >= baseY` cannot
 * answer this: a rows-only resize leaves it true while the scrollable element
 * is still parked rows higher, which is the whole of #11709. Null metrics mean
 * the private shape is gone — treated as NOT pinned so the guard fails loudly
 * rather than passing vacuously.
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

    // Real scrollback to scroll through — without it ybase stays 0, the resize
    // has no lines to spill, and there is nothing to get stranded above.
    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=200;i++) console.log('ROWPIN_'+i)"`
    );
    await waitForTerminalText(panel, "ROWPIN_200", T_LONG);
    await window.waitForTimeout(T_SETTLE);

    // The box the ResizeObserver actually watches, not the padded panel — the
    // simulated resizes below have to speak the same geometry the watchdog
    // compares against, or it reconciles them away mid-test.
    const outputBox = await panel.locator('[aria-label="Terminal output"]').boundingBox();
    if (!outputBox) throw new Error("Terminal output box has no layout");

    // Establish the baseline grid FIRST. This call can itself move the grid and
    // therefore run the very invalidation under test — priming afterwards is
    // what guarantees the target shrink below starts from a primed cache.
    const baselineGrid = await simulateResize(window, outputBox.width, outputBox.height);
    await window.waitForTimeout(SYNC_FRAME_MS);
    const baseline = await getScrollState(window);
    expect(baseline.cols).toBe(baselineGrid.cols);
    expect(baseline.baseY).toBeGreaterThan(0);
    // Cross-layer sanity: with scrollback present the scrollable must have room
    // to move, or the "visually pinned" check below could pass on a 0/0 shape.
    expect(baseline.maxScrollTop ?? 0).toBeGreaterThan(0);

    // Prime xterm's cached viewport position the only way that matters: a real
    // scroll round-trip. An un-primed cache self-heals on the next sync, which
    // is exactly why this bug only ever appeared intermittently.
    const scrolledUp = await scrollLines(window, -40);
    expect(scrolledUp.viewportY, "the -40 leg did not move off bottom").toBeLessThan(
      scrolledUp.baseY
    );
    await window.waitForTimeout(SYNC_FRAME_MS);

    const scrolledBack = await scrollLines(window, 40);
    await window.waitForTimeout(SYNC_FRAME_MS);
    const primed = await getScrollState(window);
    expect(primed.viewportY, "the +40 leg did not return to bottom").toBe(primed.baseY);
    expect(primed.isUserScrolledBack).toBe(false);
    expect(isVisuallyPinned(primed), `not pinned before resize: ${JSON.stringify(primed)}`).toBe(
      true
    );
    expect(scrolledBack.baseY).toBe(primed.baseY);

    // Same width, one row shorter — what growing the hybrid input does. Derive
    // the row height from the box actually being divided rather than assuming a
    // font metric, so this shrinks by exactly one row on any platform.
    const rowPx = Math.ceil(outputBox.height / baseline.rows) + 1;
    await simulateResize(window, outputBox.width, outputBox.height - rowPx);
    await window.waitForTimeout(SYNC_FRAME_MS);

    // ONE snapshot: the shrunken grid must still be the live grid at the moment
    // the pin is judged. Asserting these separately, or polling for eventual
    // success, would accept a watchdog repair as if it were the fix.
    const after = await getScrollState(window);
    const detail = JSON.stringify({ baseline, after });
    expect(after.cols, `columns moved — not a rows-only resize: ${detail}`).toBe(baseline.cols);
    expect(
      after.rows,
      `rows did not shrink (watchdog may have reconciled): ${detail}`
    ).toBeLessThan(baseline.rows);
    expect(after.rows, `degenerate grid: ${detail}`).toBeGreaterThan(1);

    // The logical half holds with or without the fix; the visual half is what
    // regressed, and the two disagreeing IS the defect.
    expect(after.isUserScrolledBack, detail).toBe(false);
    expect(after.viewportY, detail).toBe(after.baseY);
    expect(isVisuallyPinned(after), `viewport stranded above bottom: ${detail}`).toBe(true);
  });
});
