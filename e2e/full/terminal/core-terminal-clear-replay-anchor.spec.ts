import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import path from "node:path";
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
  topLineText: string;
};

type TerminalScrollHooks = {
  __daintreeGetTerminalScrollState?: (panelId: string) => TerminalScrollState | null;
  __daintreeScrollTerminalLines?: (panelId: string, lines: number) => TerminalScrollState | null;
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
const rows = process.stdout.rows || 24;
const lines = Array.from({ length: ${TRANSCRIPT_LINES} }, (_, i) => "REPLAY_" + (i + 1));
const clear = ESC + "[r" + ESC + "[0m" + ESC + "[H" + ESC + "[2J" + ESC + "[3J" + ESC + "[H";
const layout = ESC + "[1;" + (rows - 1) + "r" + (ESC + "M").repeat(rows - 1);
process.stdout.write(
  ESC + "[?2026l" + clear + ESC + "[?2026h" + layout + ESC + "[1;10r" +
  lines.map((line) => line + "\\r\\n").join("") + ESC + "[r" + ESC + "[?2026l"
);
`;

/**
 * Let xterm's queued refresh callback — and therefore its viewport sync and
 * the anchor restore that waits on it — run. Three frames: the render after
 * the sync block closes, the restore's own scroll and re-sync, and its
 * read-back on the frame after.
 */
async function waitForFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      })
  );
}

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

test.describe.serial("Core: Terminal reader position survives an ESC[3J redraw", () => {
  test.beforeAll(async () => {
    terminalPanelId = undefined;
    ({ dir: fixtureDir, cleanup: fixtureCleanup } = createFixtureRepo({
      name: "clear-replay-anchor",
    }));
    writeFileSync(path.join(fixtureDir, "replay.js"), REPLAY_SCRIPT);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(
      ctx.app,
      ctx.window,
      fixtureDir,
      "Clear Replay Anchor"
    );
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("a transcript replay after ESC[3J returns a scrolled-back reader to the same content", async () => {
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

    // Real scrollback to be scrolled back into — the same lines the replay
    // re-inserts, so the anchor has something to find.
    await runTerminalCommand(
      window,
      panel,
      `node -e "for(let i=1;i<=${TRANSCRIPT_LINES};i++) console.log('REPLAY_'+i)"`
    );
    await waitForTerminalText(panel, `REPLAY_${TRANSCRIPT_LINES}`, T_LONG);
    await window.waitForTimeout(T_SETTLE);

    const baseline = await getScrollState(window);
    expect(baseline.baseY).toBeGreaterThan(SCROLL_BACK_BY);
    expect(baseline.maxScrollTop ?? 0).toBeGreaterThan(0);

    const scrolledUp = await scrollLines(window, -SCROLL_BACK_BY);
    await waitForFrames(window);
    const before = await getScrollState(window);
    expect(before.viewportY, "the scroll-back leg did not move off bottom").toBeLessThan(
      before.baseY
    );
    expect(before.isUserScrolledBack).toBe(true);
    expect(before.topLineText, "expected a transcript line on the top row").toMatch(/^REPLAY_\d+$/);
    expect(scrolledUp.viewportY).toBe(before.viewportY);

    // The replay travels the PTY like an agent's output. It re-indexes every
    // line (the prompt and command echo above the transcript are gone), so
    // the reader's row number changes while the content must not.
    await runTerminalCommand(window, panel, "node replay.js");
    await waitForTerminalText(panel, `REPLAY_${TRANSCRIPT_LINES}`, T_LONG);
    await waitForFrames(window);
    await window.waitForTimeout(T_SETTLE);
    await waitForFrames(window);

    const after = await getScrollState(window);
    const detail = JSON.stringify({ before, after });
    expect(after.baseY, `the replay left no scrollback: ${detail}`).toBeGreaterThan(0);
    expect(after.viewportY, `reader stranded on line 0: ${detail}`).toBeGreaterThan(0);
    expect(after.isUserScrolledBack, detail).toBe(true);
    expect(after.topLineText, `reader lost their place: ${detail}`).toBe(before.topLineText);
    expect(
      isVisuallyAt(after, after.viewportY),
      `rendered offset disagrees with the buffer: ${detail}`
    ).toBe(true);
    await expect(panel.getByText("New output below")).toBeHidden();
  });

  test("a bottom-pinned reader follows the rebuilt transcript", async () => {
    const { window } = ctx;
    const panel = await getPanelById(window, panelId());

    const state = await getScrollState(window);
    await scrollLines(window, state.baseY - state.viewportY);
    await waitForFrames(window);
    const pinned = await getScrollState(window);
    expect(pinned.viewportY).toBe(pinned.baseY);
    expect(pinned.isUserScrolledBack).toBe(false);

    await runTerminalCommand(window, panel, "node replay.js");
    await waitForTerminalText(panel, `REPLAY_${TRANSCRIPT_LINES}`, T_LONG);
    await waitForFrames(window);
    await window.waitForTimeout(T_SETTLE);
    await waitForFrames(window);

    const after = await getScrollState(window);
    const detail = JSON.stringify({ pinned, after });
    expect(after.viewportY, detail).toBe(after.baseY);
    expect(after.isUserScrolledBack, detail).toBe(false);
    expect(isVisuallyAt(after, after.baseY), `viewport stranded above bottom: ${detail}`).toBe(
      true
    );
  });
});
