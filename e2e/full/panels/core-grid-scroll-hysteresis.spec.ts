import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { getGridPanelCount, openTerminal } from "../../helpers/panels";
import { T_LONG, T_SETTLE } from "../../helpers/timeouts";

// Regression guard for #10871 — the terminal grid oscillating between scroll
// and non-scroll mode when the window is resized through the row-overflow
// threshold. The fix gives the scroll-mode boundary a Schmitt-trigger dead band
// (like the column boundary already has), so which mode wins at a height inside
// that band depends on the direction the height was approached from.
//
// The scroll-mode state is observable in the DOM without instrumentation:
// `#panel-grid` sets `overflow-y: scroll` in scroll mode and `overflow-y: auto`
// otherwise. This test drives the OS-window-resize repro by stepping the
// Electron BrowserWindow height (the split-screen / Mission-Control gesture is
// just a height sweep) and reads the computed style at each step.
//
// This is a verification harness for the fix, not a hard PR gate — the
// full-panels bucket only runs on release/stabilize (see CLAUDE.md). The
// deterministic gate lives in src/lib/__tests__/terminalLayout.test.ts.

let ctx: AppContext;
let fixtureCleanup: (() => void) | undefined;

const GRID_SELECTOR = "#panel-grid";

async function setWindowSize(app: AppContext["app"], width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.setSize(size.width, size.height);
    },
    { width, height }
  );
}

/** True when the grid is in scroll mode (`overflow-y: scroll`). */
async function isScrollMode(window: Page): Promise<boolean> {
  return window
    .locator(GRID_SELECTOR)
    .evaluate((el) => getComputedStyle(el).overflowY === "scroll");
}

/** Grid element inner height in CSS px (drives the row-overflow decision). */
async function gridHeight(window: Page): Promise<number> {
  return window
    .locator(GRID_SELECTOR)
    .evaluate((el) => (el as HTMLElement).getBoundingClientRect().height);
}

/**
 * Step the window height from `from` to `to` in `step`-px increments, letting
 * the ResizeObserver + rAF settle between steps, and return the scroll-mode
 * boolean at the final height.
 */
async function sweepTo(
  window: Page,
  width: number,
  from: number,
  to: number,
  step: number
): Promise<boolean> {
  const dir = to >= from ? 1 : -1;
  for (let h = from; dir > 0 ? h <= to : h >= to; h += dir * step) {
    await setWindowSize(ctx.app, width, h);
    await window.waitForTimeout(T_SETTLE);
  }
  await setWindowSize(ctx.app, width, to);
  await window.waitForTimeout(T_SETTLE);
  return isScrollMode(window);
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

  test("open 3 terminals so the grid can enter scroll mode", async () => {
    const { window } = ctx;
    // A wide window keeps the grid at 2 columns (3 panels → 2 rows), so the
    // row-overflow threshold lands at a modest height the display can sweep
    // through in both directions including the full dead band.
    await setWindowSize(ctx.app, 1180, 1500);
    for (let i = 0; i < 3; i++) {
      await openTerminal(window);
      await window.waitForTimeout(T_SETTLE);
    }
    await expect.poll(() => getGridPanelCount(window), { timeout: T_LONG }).toBe(3);
  });

  test("scroll mode at a mid-band height depends on approach direction (dead band)", async () => {
    const { window } = ctx;
    const WIDTH = 1180;

    // Confirm both extremes resolve to a definite, opposite mode so the sweep
    // brackets the transition. Tall → non-scroll, short → scroll.
    const TALL = 1500;
    const SHORT = 640;
    await setWindowSize(ctx.app, WIDTH, TALL);
    await window.waitForTimeout(T_SETTLE);
    expect(await isScrollMode(window), "tall window should not scroll").toBe(false);

    await setWindowSize(ctx.app, WIDTH, SHORT);
    await window.waitForTimeout(T_SETTLE);
    expect(await isScrollMode(window), "short window should scroll").toBe(true);

    // Discover the entry threshold by shrinking from tall until it flips to
    // scroll, then the exit threshold by growing from short until it flips out.
    const STEP = 20;
    let enterHeight: number | null = null;
    await setWindowSize(ctx.app, WIDTH, TALL);
    await window.waitForTimeout(T_SETTLE);
    for (let h = TALL; h >= SHORT; h -= STEP) {
      await setWindowSize(ctx.app, WIDTH, h);
      await window.waitForTimeout(T_SETTLE);
      if (await isScrollMode(window)) {
        enterHeight = await gridHeight(window);
        break;
      }
    }

    let exitHeight: number | null = null;
    await setWindowSize(ctx.app, WIDTH, SHORT);
    await window.waitForTimeout(T_SETTLE);
    for (let h = SHORT; h <= TALL; h += STEP) {
      await setWindowSize(ctx.app, WIDTH, h);
      await window.waitForTimeout(T_SETTLE);
      if (!(await isScrollMode(window))) {
        exitHeight = await gridHeight(window);
        break;
      }
    }

    expect(enterHeight, "grid should enter scroll mode while shrinking").not.toBeNull();
    expect(exitHeight, "grid should exit scroll mode while growing").not.toBeNull();

    // The invariant the fix guarantees: the grid must grow meaningfully past the
    // height where it entered scroll mode before it leaves it. Without the dead
    // band (the #10871 bug) enter and exit land at the same height and this gap
    // collapses to ~0 (± one sweep step). The real buffer is > one min-row tall
    // (hundreds of px), so a generous floor cleanly separates fixed from buggy.
    const deadBand = (exitHeight as number) - (enterHeight as number);
    expect(deadBand, `dead band px (enter=${enterHeight}, exit=${exitHeight})`).toBeGreaterThan(
      2 * STEP
    );
  });

  test("a mid-band height holds its mode when re-approached from the same side", async () => {
    const { window } = ctx;
    const WIDTH = 1180;

    // Land on a height in the middle of the band from the "grew into it" side
    // (start short → step up and stop mid-band). With hysteresis it stays in
    // scroll mode; without it, it would already have left. Then land on the same
    // height from the "shrank into it" side and confirm it is non-scroll —
    // proving the two states coexist at one height (history dependence).
    const MID = 1080;

    const fromBelow = await sweepTo(window, WIDTH, 640, MID, 20);
    const fromAbove = await sweepTo(window, WIDTH, 1500, MID, 20);

    expect(
      fromBelow,
      "approached from a shorter window, the mid-band height should still scroll"
    ).toBe(true);
    expect(
      fromAbove,
      "approached from a taller window, the mid-band height should not scroll"
    ).toBe(false);
    // The two disagree at the same target height → the boundary is hysteretic.
    expect(fromBelow).not.toBe(fromAbove);
  });
});
