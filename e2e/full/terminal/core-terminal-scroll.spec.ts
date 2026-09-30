import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import {
  getTerminalText,
  runTerminalCommand,
  waitForTerminalText,
  writeTerminalInput,
} from "../../helpers/terminal";
import { getGridPanelIds, getPanelById, openTerminal } from "../../helpers/panels";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";
import { dismissBlockingPalette } from "../../helpers/overlays";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

type TerminalScrollState = {
  viewportY: number;
  baseY: number;
  isUserScrolledBack: boolean;
  cols: number;
  rows: number;
  scrollTop: number | null;
  maxScrollTop: number | null;
  topLineText: string;
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

const TRANSCRIPT_LINES = 200;
const SCROLL_BACK_BY = 40;

/**
 * The byte sequence Codex 0.154 emits after a height change, captured with
 * tmux `pipe-pane` (#12398): the previous frame's ESU, `ESC[r ESC[0m ESC[H
 * ESC[2J ESC[3J ESC[H`, then the transcript re-inserted inside its own sync
 * block through DECSTBM scroll regions. Written by a script on the real PTY so
 * the bytes travel the same ingest path as an agent's.
 */
const REPLAY_SCRIPT = `
const ESC = "\\x1b";
const run = process.argv[2] || "0";
const rows = Number(process.argv[3]) || process.stdout.rows || 24;
const lines = Array.from({ length: ${TRANSCRIPT_LINES} }, (_, i) => "REPLAY_" + (i + 1));
const clear = ESC + "[r" + ESC + "[0m" + ESC + "[H" + ESC + "[2J" + ESC + "[3J" + ESC + "[H";
const layout = ESC + "[1;" + rows + "r" + (ESC + "M").repeat(rows - 1);
process.stdout.write(
  ESC + "[?2026l" + clear + ESC + "[?2026h" + layout + ESC + "[1;" + rows + "r" +
  lines.map((line) => line + "\\r\\n").join("") + ESC + "[r" + ESC + "[?2026l" +
  "\\r\\n" + "REPLAY_" + "DONE_" + run + "\\r\\n"
);
`;

/**
 * Fills the buffer, then holds its second phase until a line arrives on stdin.
 * The spec releases it only after the reader has scrolled back, so the "no
 * pill before new output" check cannot race a wall-clock producer.
 */
const GATED_PRODUCER_SCRIPT = `
const [prefix, fill, extra, interval] = process.argv.slice(2);
for (let i = 1; i <= Number(fill); i++) console.log(prefix + "_FILL_" + i);
process.stdin.once("data", () => {
  process.stdin.pause();
  let i = 0;
  const t = setInterval(() => {
    i++;
    console.log(prefix + "_NEW_" + i);
    if (i >= Number(extra)) {
      clearInterval(t);
      process.exit(0);
    }
  }, Number(interval));
});
`;

/**
 * Let xterm's queued refresh callback — and therefore its viewport sync and
 * any anchor restore that waits on it — run. Three frames: the render after a
 * sync block closes, a restore's own scroll and re-sync, and its read-back on
 * the frame after.
 */
async function waitForFrames(page: Page, frames = 3): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        let left = count;
        const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    frames
  );
}

async function getScrollState(page: Page, panelId: string): Promise<TerminalScrollState> {
  const state = await page.evaluate((id) => {
    const hooks = window as unknown as TerminalScrollHooks;
    if (!hooks.__daintreeGetTerminalScrollState) throw new Error("scroll-state hook missing");
    return hooks.__daintreeGetTerminalScrollState(id);
  }, panelId);
  if (!state) throw new Error("Terminal scroll state unavailable");
  return state;
}

async function scrollLines(
  page: Page,
  panelId: string,
  lines: number
): Promise<TerminalScrollState> {
  const state = await page.evaluate(
    ({ id, lineCount }) => {
      const hooks = window as unknown as TerminalScrollHooks;
      if (!hooks.__daintreeScrollTerminalLines) throw new Error("scroll-lines hook missing");
      return hooks.__daintreeScrollTerminalLines(id, lineCount);
    },
    { id: panelId, lineCount: lines }
  );
  if (!state) throw new Error("Terminal scroll state unavailable after scroll");
  return state;
}

async function simulateResize(
  page: Page,
  panelId: string,
  width: number,
  height: number
): Promise<{ cols: number; rows: number }> {
  const grid = await page.evaluate(
    ({ id, w, h }) => {
      const hooks = window as unknown as TerminalScrollHooks;
      if (!hooks.__daintreeSimulateTerminalResize) throw new Error("resize hook missing");
      return hooks.__daintreeSimulateTerminalResize(id, w, h);
    },
    { id: panelId, w: width, h: height }
  );
  // A converged resize returns null — the grid did not move, which is a valid
  // outcome for the baseline call.
  return grid ?? (await getScrollState(page, panelId));
}

/**
 * Is the rendered scroll offset where the buffer says the viewport is? The
 * logical `viewportY` alone cannot see a restore that landed on stale DOM
 * dimensions. Null metrics mean the private shape is gone — treated as NOT
 * matching so the guard fails loudly rather than passing vacuously.
 */
function isVisuallyAt(state: TerminalScrollState, viewportY: number): boolean {
  if (state.scrollTop === null || state.maxScrollTop === null || state.baseY === 0) return false;
  const rowPx = state.maxScrollTop / state.baseY;
  return Math.abs(state.scrollTop - viewportY * rowPx) < rowPx / 2;
}

/**
 * Is the viewport where the buffer says it is? `viewportY >= baseY` cannot
 * answer this: a rows-only resize leaves it true while the scrollable element
 * is still parked rows higher, which is the whole of #11709. Null metrics mean
 * the private shape is gone — treated as NOT pinned.
 */
function isVisuallyPinned(state: TerminalScrollState): boolean {
  if (state.scrollTop === null || state.maxScrollTop === null) return false;
  return Math.abs(state.maxScrollTop - state.scrollTop) < 1;
}

function isScrolledBack(state: TerminalScrollState | null): boolean {
  return Boolean(state && state.isUserScrolledBack && state.viewportY < state.baseY);
}

/**
 * Closes every grid panel through its header close button and asserts the grid
 * is empty, then opens one fresh terminal. Every scenario below starts from a
 * lone terminal with its own scrollback, so none reads another's buffer or
 * geometry.
 */
async function freshTerminal(page: Page): Promise<{ id: string; panel: Locator }> {
  await dismissBlockingPalette(page);
  for (const id of await getGridPanelIds(page)) {
    const gridPanel = page.locator(`${SEL.panel.gridPanel}[data-panel-id="${id}"]`);
    await gridPanel.locator(SEL.panel.close).first().click({ force: true });
    await expect(gridPanel).toHaveCount(0, { timeout: T_MEDIUM });
  }
  await expect
    .poll(() => getGridPanelIds(page).then((ids) => ids.length), { timeout: T_MEDIUM })
    .toBe(0);

  await openTerminal(page);
  await expect
    .poll(() => getGridPanelIds(page).then((ids) => ids.length), {
      timeout: T_LONG,
      intervals: [100, 250, 500],
    })
    .toBe(1);
  const [id] = await getGridPanelIds(page);
  const panel = getPanelById(page, id);
  await expect(panel).toBeVisible({ timeout: T_LONG });
  return { id, panel };
}

/**
 * Setup, not the gesture under test: the keyboard scroll path is covered by
 * the pane group. The hook scrolls xterm the way a wheel does, so the viewport
 * is marked user-scrolled-back exactly as a reader's would be.
 */
async function scrollTerminalBack(page: Page, panelId: string): Promise<void> {
  await scrollLines(page, panelId, -80);
  try {
    await expect
      .poll(async () => isScrolledBack(await getScrollState(page, panelId)), {
        timeout: T_MEDIUM,
        intervals: [100, 250, 500],
      })
      .toBe(true);
  } catch (error) {
    const state = await getScrollState(page, panelId);
    throw new Error(`Terminal did not scroll back: ${JSON.stringify(state)}`, { cause: error });
  }
}

/**
 * The pill is published synchronously from the write callback that lands the
 * output, so once the text is in the buffer the only thing left is React's
 * commit. Sample every frame for a sustained window rather than snapshot once,
 * so a pill that flashes up a few frames late is still caught.
 */
async function expectIndicatorAbsentForFrames(
  page: Page,
  panelId: string,
  frames = 30
): Promise<void> {
  const seenOnFrame = await page.evaluate(
    ({ id, count, selector }) =>
      new Promise<number>((resolve) => {
        let frame = 0;
        const tick = () => {
          const panel = document.querySelector(`[data-panel-id="${id}"]`);
          const pill = panel?.querySelector(selector);
          if (pill instanceof HTMLElement && pill.getClientRects().length > 0) {
            resolve(frame);
            return;
          }
          if (++frame >= count) resolve(-1);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { id: panelId, count: frames, selector: SEL.terminal.scrollIndicator }
  );
  expect(seenOnFrame, "scroll indicator rendered during the dwell window").toBe(-1);
}

test.describe("Core: Terminal scroll & buffer", () => {
  test.beforeAll(async () => {
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({ name: "terminal-scroll" }));
    writeFileSync(path.join(fixtureDir, "replay.js"), REPLAY_SCRIPT);
    writeFileSync(path.join(fixtureDir, "gated.js"), GATED_PRODUCER_SCRIPT);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Terminal Scroll");
    // Pill visibility toggles without the enter transition.
    await ctx.window.emulateMedia({ reducedMotion: "reduce" });
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test.describe("reader position survives an ESC[3J redraw", () => {
    test.describe.configure({ mode: "serial" });
    let terminalId = "";

    test.beforeAll(async () => {
      ({ id: terminalId } = await freshTerminal(ctx.window));
    });

    test("a transcript replay after ESC[3J returns a scrolled-back reader to the same content", async () => {
      const { window } = ctx;
      const panel = getPanelById(window, terminalId);

      // Real scrollback to be scrolled back into — the same lines the replay
      // re-inserts, so the anchor has something to find.
      await runTerminalCommand(
        window,
        panel,
        `node -e "for(let i=1;i<=${TRANSCRIPT_LINES};i++) console.log('REPLAY_'+i)"`
      );
      await waitForTerminalText(panel, `REPLAY_${TRANSCRIPT_LINES}`, T_LONG);
      await expect
        .poll(
          async () => {
            const s = await getScrollState(window, terminalId);
            return s.baseY > SCROLL_BACK_BY && (s.maxScrollTop ?? 0) > 0;
          },
          { timeout: T_MEDIUM, intervals: [100, 250] }
        )
        .toBe(true);

      const baseline = await getScrollState(window, terminalId);
      expect(baseline.baseY).toBeGreaterThan(SCROLL_BACK_BY);
      expect(baseline.maxScrollTop ?? 0).toBeGreaterThan(0);

      const scrolledUp = await scrollLines(window, terminalId, -SCROLL_BACK_BY);
      await waitForFrames(window);
      const before = await getScrollState(window, terminalId);
      expect(before.viewportY, "the scroll-back leg did not move off bottom").toBeLessThan(
        before.baseY
      );
      expect(before.isUserScrolledBack).toBe(true);
      expect(before.topLineText, "expected a transcript line on the top row").toMatch(
        /^REPLAY_\d+$/
      );
      expect(scrolledUp.viewportY).toBe(before.viewportY);

      // The replay re-indexes every line (the prompt and command echo above
      // the transcript are gone), so the reader's row number changes while the
      // content must not. The marker is assembled inside the script so the
      // echoed command line cannot satisfy the wait.
      await runTerminalCommand(window, panel, `node replay.js 1 ${before.rows}`);
      await waitForTerminalText(panel, "REPLAY_DONE_1", T_LONG);
      await waitForFrames(window);
      await waitForFrames(window);

      let observed: TerminalScrollState | undefined;
      try {
        await expect
          .poll(
            async () => {
              observed = await getScrollState(window, terminalId);
              return (
                observed.baseY > 0 &&
                observed.viewportY > 0 &&
                observed.isUserScrolledBack &&
                observed.topLineText === before.topLineText &&
                isVisuallyAt(observed, observed.viewportY)
              );
            },
            {
              message: "the replay did not restore the reader's anchored scroll position",
              timeout: T_LONG,
              intervals: [100, 250, 500],
            }
          )
          .toBe(true);
      } catch (error) {
        const detail = JSON.stringify({ before, observed });
        throw new Error(
          `the replay did not restore the reader's anchored scroll position: ${detail}\n${formatErrorMessage(error, "Unknown replay-anchor error")}`,
          { cause: error }
        );
      }

      const after = await getScrollState(window, terminalId);
      const detail = JSON.stringify({ before, after });
      expect(after.baseY, `the replay left no scrollback: ${detail}`).toBeGreaterThan(0);
      expect(after.viewportY, `reader stranded on line 0: ${detail}`).toBeGreaterThan(0);
      expect(after.isUserScrolledBack, detail).toBe(true);
      expect(after.topLineText, `reader lost their place: ${detail}`).toBe(before.topLineText);
      expect(
        isVisuallyAt(after, after.viewportY),
        `rendered offset disagrees with the buffer: ${detail}`
      ).toBe(true);
    });

    test("a bottom-pinned reader follows the rebuilt transcript", async () => {
      const { window } = ctx;
      const panel = getPanelById(window, terminalId);

      const state = await getScrollState(window, terminalId);
      await scrollLines(window, terminalId, state.baseY - state.viewportY);
      await waitForFrames(window);
      const pinned = await getScrollState(window, terminalId);
      expect(pinned.viewportY).toBe(pinned.baseY);
      expect(pinned.isUserScrolledBack).toBe(false);

      await runTerminalCommand(window, panel, `node replay.js 2 ${pinned.rows}`);
      await waitForTerminalText(panel, "REPLAY_DONE_2", T_LONG);
      await waitForFrames(window);
      await waitForFrames(window);

      let after: TerminalScrollState | undefined;
      await expect
        .poll(
          async () => {
            after = await getScrollState(window, terminalId);
            return after.viewportY === after.baseY && !after.isUserScrolledBack;
          },
          { timeout: T_MEDIUM, intervals: [100, 250] }
        )
        .toBe(true)
        .catch(() => undefined);
      after = await getScrollState(window, terminalId);
      const detail = JSON.stringify({ pinned, after });
      expect(after.viewportY, detail).toBe(after.baseY);
      expect(after.isUserScrolledBack, detail).toBe(false);
      expect(isVisuallyAt(after, after.baseY), `viewport stranded above bottom: ${detail}`).toBe(
        true
      );
    });
  });

  test("a rows-only shrink does not strand a bottom-pinned viewport in scrollback", async () => {
    const { window } = ctx;
    const { id, panel } = await freshTerminal(window);

    // Real scrollback to scroll through — without it ybase stays 0, the resize
    // has no lines to spill, and there is nothing to get stranded above.
    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=200;i++) console.log('ROWPIN_'+i)"`
    );
    await waitForTerminalText(panel, "ROWPIN_200", T_LONG);
    await expect
      .poll(
        async () => {
          const s = await getScrollState(window, id);
          return s.baseY > 0 && (s.maxScrollTop ?? 0) > 0;
        },
        { timeout: T_MEDIUM, intervals: [100, 250] }
      )
      .toBe(true);

    // The box the ResizeObserver actually watches, not the padded panel — the
    // simulated resizes below have to speak the same geometry the watchdog
    // compares against, or it reconciles them away mid-test.
    const outputBox = await panel.locator('[aria-label="Terminal output"]').boundingBox();
    if (!outputBox) throw new Error("Terminal output box has no layout");

    // Establish the baseline grid FIRST. This call can itself move the grid and
    // therefore run the very invalidation under test — priming afterwards is
    // what guarantees the target shrink below starts from a primed cache.
    const baselineGrid = await simulateResize(window, id, outputBox.width, outputBox.height);
    await waitForFrames(window, 2);
    const baseline = await getScrollState(window, id);
    expect(baseline.cols).toBe(baselineGrid.cols);
    expect(baseline.baseY).toBeGreaterThan(0);
    // With scrollback present the scrollable must have room to move, or the
    // "visually pinned" check below could pass on a 0/0 shape.
    expect(baseline.maxScrollTop ?? 0).toBeGreaterThan(0);

    // Prime xterm's cached viewport position the only way that matters: a real
    // scroll round-trip. An un-primed cache self-heals on the next sync, which
    // is exactly why this bug only ever appeared intermittently.
    const scrolledUp = await scrollLines(window, id, -40);
    expect(scrolledUp.viewportY, "the -40 leg did not move off bottom").toBeLessThan(
      scrolledUp.baseY
    );
    await waitForFrames(window, 2);

    const scrolledBack = await scrollLines(window, id, 40);
    await waitForFrames(window, 2);
    const primed = await getScrollState(window, id);
    expect(primed.viewportY, "the +40 leg did not return to bottom").toBe(primed.baseY);
    expect(primed.isUserScrolledBack).toBe(false);
    expect(isVisuallyPinned(primed), `not pinned before resize: ${JSON.stringify(primed)}`).toBe(
      true
    );
    expect(scrolledBack.baseY).toBe(primed.baseY);

    // Same width, one row shorter — what growing the hybrid input does. Derive
    // the row height from the box actually being divided so this shrinks by
    // exactly one row on any platform.
    const rowPx = Math.ceil(outputBox.height / baseline.rows) + 1;
    await simulateResize(window, id, outputBox.width, outputBox.height - rowPx);
    // Frames, not wall clock: xterm's corrective sync rides an animation frame;
    // a host-side timer that expires first would snapshot a scrollable still
    // holding BOTH its old position and old maximum, which reads as pinned.
    await waitForFrames(window, 2);

    // ONE snapshot: the shrunken grid must still be the live grid at the moment
    // the pin is judged. Polling would accept a watchdog repair as the fix.
    const after = await getScrollState(window, id);
    const detail = JSON.stringify({ baseline, after });
    expect(after.cols, `columns moved — not a rows-only resize: ${detail}`).toBe(baseline.cols);
    expect(
      after.rows,
      `rows did not shrink (watchdog may have reconciled): ${detail}`
    ).toBeLessThan(baseline.rows);
    expect(after.rows, `degenerate grid: ${detail}`).toBeGreaterThan(1);
    // Fewer rows over the same scrollback means more room to scroll; without
    // this the pinned check could pass on a scrollable that never moved.
    expect(
      after.maxScrollTop ?? 0,
      `viewport sync never applied the new dimensions: ${detail}`
    ).toBeGreaterThan(baseline.maxScrollTop ?? 0);
    // The logical half holds with or without the fix; the visual half is what
    // regressed, and the two disagreeing IS the defect.
    expect(after.isUserScrolledBack, detail).toBe(false);
    expect(after.viewportY, detail).toBe(after.baseY);
    expect(isVisuallyPinned(after), `viewport stranded above bottom: ${detail}`).toBe(true);
  });

  test.describe("new-output indicator", () => {
    test.describe.configure({ mode: "serial" });
    let terminalId = "";

    test.beforeAll(async () => {
      ({ id: terminalId } = await freshTerminal(ctx.window));
    });

    test("indicator appears when scrolled up and new output arrives", async () => {
      const { window } = ctx;
      const panel = getPanelById(window, terminalId);

      await runTerminalCommand(window, panel, "node gated.js SCRL_A 200 20 150");
      await waitForTerminalText(panel, "SCRL_A_FILL_200", T_LONG);

      await scrollTerminalBack(window, terminalId);

      // The producer is parked on stdin, so nothing new has arrived yet:
      // scrolling alone must not raise the pill.
      const indicator = panel.locator(SEL.terminal.scrollIndicator);
      await expectIndicatorAbsentForFrames(window, terminalId);
      await expect(indicator).not.toBeVisible();

      // Straight to the PTY over IPC, so xterm's scroll-on-input never fires
      // and the reader stays scrolled back.
      await writeTerminalInput(window, panel, "\r");
      await waitForTerminalText(panel, "SCRL_A_NEW_20", T_LONG);
      expect(isScrolledBack(await getScrollState(window, terminalId))).toBe(true);

      await expect(indicator).toBeVisible({ timeout: T_MEDIUM });
    });

    test("clicking indicator scrolls to bottom and hides it", async () => {
      const { window } = ctx;
      const panel = getPanelById(window, terminalId);
      const indicator = panel.locator(SEL.terminal.scrollIndicator);

      await indicator.click();

      // With reduced motion, shouldRender toggles immediately.
      await expect(indicator).not.toBeVisible({ timeout: T_SHORT });
      await expect
        .poll(
          async () => {
            const s = await getScrollState(window, terminalId);
            return s.viewportY === s.baseY && !s.isUserScrolledBack;
          },
          { timeout: T_SHORT, intervals: [100, 250] }
        )
        .toBe(true);

      // Auto-scroll resumed: follow-up output must not bring the pill back.
      await runTerminalCommand(window, panel, `node -e "console.log('SCRL_A_VERIFY')"`);
      await waitForTerminalText(panel, "SCRL_A_VERIFY", T_LONG);
      await expectIndicatorAbsentForFrames(window, terminalId);
      await expect(indicator).not.toBeVisible({ timeout: T_SHORT });
    });
  });

  test("indicator does not appear when already at bottom", async () => {
    const { window } = ctx;
    const { id, panel } = await freshTerminal(window);

    // Same gated producer as the scrolled-back case, released WITHOUT scrolling up.
    // Enough fill to overflow a lone full-height pane: with no scrollback there
    // is nothing to be at the bottom of, and the check would pass vacuously.
    await runTerminalCommand(window, panel, "node gated.js SCRL_B 200 10 20");
    await waitForTerminalText(panel, "SCRL_B_FILL_200", T_LONG);
    await writeTerminalInput(window, panel, "\r");

    await waitForTerminalText(panel, "SCRL_B_NEW_10", T_LONG);
    const state = await getScrollState(window, id);
    expect(state.baseY, JSON.stringify(state)).toBeGreaterThan(0);
    expect(state.isUserScrolledBack, JSON.stringify(state)).toBe(false);

    // Indicator must stay hidden since we never scrolled up.
    const indicator = panel.locator(SEL.terminal.scrollIndicator);
    await expectIndicatorAbsentForFrames(window, id);
    await expect(indicator).not.toBeVisible();
  });

  // Last: raising scrollback is global and would change every later terminal.
  test("scrollback retains a contiguous ~1500-line window under load and stays interactive", async () => {
    test.setTimeout(120_000);
    const { window } = ctx;

    await test.step("set scrollback to 5000 (terminals get 5000 * 0.3 = 1500)", async () => {
      // The action updates the renderer store AND persists via IPC; the
      // terminal opened next reads it at creation.
      const result = await window.evaluate(async () => {
        const dispatch = (window as unknown as Record<string, unknown>)
          .__daintreeDispatchAction as (
          id: string,
          args?: unknown,
          opts?: unknown
        ) => Promise<{ ok?: boolean; error?: { message?: string } }>;
        return dispatch("terminalConfig.setScrollback", { scrollbackLines: 5000 });
      });
      expect(result?.ok, result?.error?.message).toBe(true);
    });

    const { panel } = await freshTerminal(window);

    await test.step("output 5000 ANSI-colored numbered lines", async () => {
      await runTerminalCommand(
        window,
        panel,
        `node -e "for(let i=1;i<=5000;i++) process.stdout.write('\\x1b[31mLINE_'+String(i).padStart(5,'0')+'\\x1b[0m\\n')"`
      );
      await waitForTerminalText(panel, "LINE_05000", 60_000);
    });

    await test.step("buffer retains approximately 1500 lines after ring buffer trimming", async () => {
      const text = await getTerminalText(panel);
      const lineNumbers: number[] = [];
      const linePattern = /LINE_(\d{5})/;
      for (const line of text.split("\n")) {
        const match = line.match(linePattern);
        if (match) lineNumbers.push(parseInt(match[1], 10));
      }

      expect(Math.max(...lineNumbers)).toBe(5000);

      // Oldest ≈ 3500 (±100 for viewport rows).
      const oldest = Math.min(...lineNumbers);
      expect(oldest).toBeGreaterThan(3400);
      expect(oldest).toBeLessThan(3550);

      expect(lineNumbers.length).toBeGreaterThan(1400);
      expect(lineNumbers.length).toBeLessThan(1650);

      // Contiguous ascending sequence: no gaps or duplicates.
      const sorted = [...lineNumbers].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]).toBe(sorted[i - 1] + 1);
      }
    });

    await test.step("terminal remains interactive after flood", async () => {
      await runTerminalCommand(window, panel, "echo INTERACTIVE_CHECK");
      await waitForTerminalText(panel, "INTERACTIVE_CHECK", T_LONG);
    });
  });
});
