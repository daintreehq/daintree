import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount, openTerminal } from "../../helpers/panels";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";

// Regression guard for #10871 — the terminal grid oscillating between scroll
// and non-scroll mode when the layout is resized through the row-overflow
// threshold. The fix gives the scroll-mode boundary a Schmitt-trigger dead band
// (like the column boundary already has via applyHysteresis): scroll mode enters
// on the bare threshold but only exits once the grid grows a full buffer past
// it. The observable, defining consequence — asserted here — is HISTORY
// DEPENDENCE: at one fixed grid geometry the mode differs depending on whether
// that geometry was reached fresh or by growing out of scroll mode. A bare
// threshold (the pre-fix bug) has no memory, so both readings are equal and the
// grid flickers on resize.
//
// `#panel-grid` exposes the mode without instrumentation: `overflow-y: scroll`
// in scroll mode, `overflow-y: auto` otherwise.
//
// Reaching scroll mode by shrinking height alone isn't reliable on a clamped
// display (the window work area caps height and the dead band is large), so
// scroll mode is instead armed by NARROWING the width to a single column — 3
// panels then stack into 3 rows and always overflow. Widening back to two
// columns drops to 2 rows, whose bare threshold the current grid height clears —
// yet the dead band holds scroll mode. The same wide/tall geometry read fresh is
// non-scroll, proving the two coexist. Verification supplement, not the gate —
// the full-panels bucket only runs on release/stabilize (CLAUDE.md); the
// deterministic red/green gate is src/lib/__tests__/terminalLayout.test.ts.

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

const GRID_SELECTOR = "#panel-grid";
const WIDE = 1700; // resolves to 2 columns (3 panels → 2 rows)
const NARROW = 850; // just above the 800px window minWidth → 1 column (3 rows)
const TALL = 1007; // clamps to the work-area max; the tallest grid we can reach

async function setWindowSize(app: AppContext["app"], width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.setSize(size.width, size.height);
    },
    { width, height }
  );
}

// clientHeight is the viewport-limited, padding-inclusive height the grid's
// ResizeObserver feeds into the scroll-mode decision — NOT
// getBoundingClientRect(), which reports the fixed-row content height in scroll
// mode and would misrepresent the measured dimension.
async function readGrid(window: Page): Promise<{ scroll: boolean; clientH: number; cols: number }> {
  return window.locator(GRID_SELECTOR).evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      scroll: cs.overflowY === "scroll",
      clientH: (el as HTMLElement).clientHeight,
      cols: cs.gridTemplateColumns.split(" ").length,
    };
  });
}

async function resizeAndRead(window: Page, width: number, height: number) {
  await setWindowSize(ctx.app, width, height);
  // Two settle windows: one for the OS window/WebContentsView resize to land,
  // one for the ResizeObserver → rAF → hysteresis-settle layout effect to commit
  // the new mode.
  await window.waitForTimeout(T_SETTLE);
  await window.waitForTimeout(T_SETTLE);
  return readGrid(window);
}

test.describe.serial("Core: grid scroll-mode hysteresis (#10871)", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "grid-scroll-hysteresis" });
    fixtureCleanup = cleanup;
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, dir, "Grid Scroll Hysteresis");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("scroll mode at a fixed geometry depends on approach direction (dead band)", async () => {
    const { window } = ctx;

    await setWindowSize(ctx.app, WIDE, TALL);
    for (let i = 0; i < 3; i++) {
      await openTerminal(window);
      await window.waitForTimeout(T_SETTLE);
    }
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);

    // Baseline: freshly at wide+tall, never having entered scroll mode. Two
    // columns → two rows → the grid height clears the bare row-overflow
    // threshold, so this is non-scroll.
    const fresh = await resizeAndRead(window, WIDE, TALL);
    expect(fresh.cols, "wide layout should be 2 columns").toBe(2);
    expect(fresh.scroll, "fresh wide+tall grid should not scroll").toBe(false);

    // Arm scroll mode by narrowing to a single column: 3 panels stack into 3
    // rows and overflow regardless of height.
    const narrow = await resizeAndRead(window, NARROW, TALL);
    expect(narrow.cols, "narrow layout should be 1 column").toBe(1);
    expect(narrow.scroll, "single-column stack of 3 should scroll").toBe(true);

    // Return to the EXACT baseline geometry (wide + tall). The layout is back to
    // 2 columns / 2 rows — a bare threshold flips straight to non-scroll here
    // (that is `fresh` above, the pre-fix flicker). The Schmitt-trigger dead band
    // holds scroll mode instead.
    const grownBack = await resizeAndRead(window, WIDE, TALL);
    expect(grownBack.cols, "should be back to 2 columns").toBe(2);
    expect(
      grownBack.scroll,
      `scroll mode must hold when returning to the fresh geometry ` +
        `(fresh=${fresh.clientH}px→auto, grown-back=${grownBack.clientH}px→must stay scroll)`
    ).toBe(true);

    // The defining signature of hysteresis: identical wide+tall geometry, but the
    // mode differs by approach direction. Equal here would mean no dead band —
    // the pre-fix bug.
    expect(
      grownBack.scroll,
      "hysteresis: same geometry, opposite mode by approach direction"
    ).not.toBe(fresh.scroll);
  });
});
