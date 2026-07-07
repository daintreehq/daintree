import type { PerfScenario } from "../types";
import {
  getHistoryReflowFixture,
  getRevealBacklogs,
  getStormFixture,
  runRevealArm,
  HISTORY_COLS,
  HISTORY_ROWS,
  STORM_MAX_COLS,
  STORM_MIN_COLS,
  STORM_ROWS,
} from "../lib/reflowFixture";

/**
 * PERF-110..112 — terminal resize/reflow pipeline.
 *
 * Resize is the highest-frequency geometry operation in the app: splitter
 * drags, grid rearranges, window resizes, and the reveal-time reconcile
 * sweep all land in `terminal.resize()`, which parses the entire pending
 * write buffer in one unyielding synchronous task before re-wrapping the
 * entire retained scrollback (CoreTerminal.resize → WriteBuffer.flushSync →
 * buffer reflow). Cost scales with backlog bytes × retained lines × terminal
 * count. This block guards the fixes for the 2026-07-06 reveal-resize
 * lockup, the alt-buffer reflow corruption (#10805), and the streaming
 * re-wrap duplication (#10863) at the cost layer they regress in.
 *
 * All scenarios drive real @xterm/headless instances — reflow lives in the
 * shared buffer core, so headless measures the same work the renderer does,
 * minus paint. Fixture setup is lazy (first run()/warmup); importing this
 * module never constructs terminals (scenario-matrix rule).
 */
export const resizeReflowScenarios: PerfScenario[] = [
  {
    id: "PERF-110",
    name: "Terminal Reflow Cost vs Retained History",
    description:
      "Single-terminal reflow unit cost every other resize multiplies: three " +
      "persistent headless terminals retain 10k/50k/100k buffer rows of seeded " +
      "agent-mix content (~30% wrapped lines); each iteration brackets one " +
      "width-changing resize per checkpoint, alternating ±1 column so buffer " +
      "state never drifts. durationMs is the 100k case.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    async run() {
      const checkpoints = await getHistoryReflowFixture();
      const metrics: Record<string, number> = {};
      let duration100k = 0;

      for (const checkpoint of checkpoints) {
        const { terminal } = checkpoint;
        const targetCols = terminal.cols === HISTORY_COLS ? HISTORY_COLS - 1 : HISTORY_COLS;
        const bufferLines = terminal.buffer.active.length;
        const start = performance.now();
        terminal.resize(targetCols, HISTORY_ROWS);
        const reflowMs = performance.now() - start;
        metrics[`reflowMsAt${checkpoint.label}`] = reflowMs;
        if (checkpoint.label === "100k") {
          duration100k = reflowMs;
          metrics.reflowLinesPerMs = reflowMs > 0 ? bufferLines / reflowMs : 0;
        }
      }

      return { durationMs: duration100k, metrics };
    },
  },
  {
    id: "PERF-111",
    name: "Terminal Resize Storm (Splitter Drag Across a Grid)",
    description:
      "Eight headless terminals retaining 20k rows each replay a 30-step " +
      "column ramp (120→90 and back on alternate iterations) — what a vertical " +
      "splitter drag does to a grid row. Deliberately uncoalesced: production " +
      "debouncing swallows most steps, so totalBlockedMs overstates what a " +
      "user feels during a drag; the guarded signal is per-fired-step cost " +
      "(maxStepMs — the dropped-frame proxy), which is what a resize that DOES " +
      "fire costs and what regresses. The debounce policy itself is " +
      "unit-tested, not benchmarked. Ends with the settled-resize re-assert " +
      "(same-dims resize must stay near-free).",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    async run() {
      const fixture = await getStormFixture();
      const goingDown = fixture.colsNow === STORM_MAX_COLS;
      const target = goingDown ? STORM_MIN_COLS : STORM_MAX_COLS;
      const stepDirection = goingDown ? -1 : 1;

      let maxStepMs = 0;
      let totalBlockedMs = 0;
      for (let cols = fixture.colsNow + stepDirection; ; cols += stepDirection) {
        let stepMs = 0;
        for (const terminal of fixture.terminals) {
          const start = performance.now();
          terminal.resize(cols, STORM_ROWS);
          stepMs += performance.now() - start;
        }
        totalBlockedMs += stepMs;
        if (stepMs > maxStepMs) maxStepMs = stepMs;
        if (cols === target) break;
      }
      fixture.colsNow = target;

      const settleStart = performance.now();
      for (const terminal of fixture.terminals) {
        terminal.resize(target, STORM_ROWS);
      }
      const settleResizeMs = performance.now() - settleStart;

      return {
        durationMs: totalBlockedMs,
        metrics: { maxStepMs, totalBlockedMs, settleResizeMs },
      };
    },
  },
  {
    id: "PERF-112",
    name: "Terminal Reveal Reconcile Under Ingest Backlog (Lockup Guard)",
    description:
      "Reconstructs the 2026-07-06 reveal-resize backlog lockup and asserts " +
      "the RESIZE_FLUSH_SYNC_BUDGET_BYTES fix holds. Bounded arm (~0.75× " +
      "budget): backlog flushes into xterm and resize()'s flushSync parses it " +
      "synchronously. Over-budget arm (4× budget): resize first on an empty " +
      "write buffer, then drain watermarked chunks at the new grid. The " +
      "invariant: reveal blocking must stay flat with respect to backlog size " +
      "— a bypassed budget sends the over-budget arm's blocking time toward " +
      "the multi-second lockup regime and blows maxMetricValues immediately.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    warmups: 1,
    async run() {
      const backlogs = getRevealBacklogs();
      const small = await runRevealArm(backlogs.small, 911_300);
      const large = await runRevealArm(backlogs.large, 911_301);

      return {
        durationMs: large.revealBlockingMs,
        metrics: {
          revealBlockingMsSmallBacklog: small.revealBlockingMs,
          revealBlockingMsLargeBacklog: large.revealBlockingMs,
          drainMsLargeBacklog: large.drainMs,
          largeToSmallBlockingRatio:
            small.revealBlockingMs > 0 ? large.revealBlockingMs / small.revealBlockingMs : 0,
          parsedLinesLargeBacklog: large.parsedLines,
          backlogChecksum: (backlogs.small.checksum ^ backlogs.large.checksum) >>> 0,
        },
      };
    },
  },
];
