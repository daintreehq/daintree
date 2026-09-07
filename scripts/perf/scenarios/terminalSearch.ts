import { performance } from "node:perf_hooks";
import { SCROLLBACK_DEFAULT, SCROLLBACK_MAX } from "../../../shared/config/scrollback";
import { buildSearchOptions } from "../../../src/components/Terminal/terminalSearchUtils";
import { createSearchableTerminal, type SearchableTerminal } from "../lib/terminalSearchFixture";
import { percentile } from "../lib/stats";
import type { PerfScenario } from "../types";

// Find-in-terminal (Cmd+F in a terminal panel). The search bar debounces input
// by 150ms and then fires ONE search, so the number the user feels is the
// latency of a single search over a full scrollback — not a per-keystroke cost.
// Stepping with Enter is undebounced and fires straight into the addon.
//
// Cost scales with scrollback: `_highlightAllMatches` walks the buffer on every
// search to collect matches up to the addon's 1,000-match highlight limit,
// however close the next hit is.
//
// COLD vs WARM is the load-bearing distinction here. The addon memoizes the
// buffer-cell-to-string translation for 15s and drops it on any line feed, so a
// terminal still streaming agent output re-translates on essentially every
// search while a quiet one translates once. Across this mixed-term sweep that
// is worth roughly 1.3x (reported per run as coldToWarmRatio — trust the metric,
// not this comment). Repeating the SAME term is far cheaper again, but that
// measures the addon's per-term match cache rather than the translation, which
// is why the sweep uses a different term every time. PERF-193 gates the cold
// path because it is the one a live agent terminal actually pays.
//
// Sizes come from shared/config/scrollback.ts rather than being invented here,
// so the benchmark tracks the real configurable range automatically.

interface SearchCase {
  label: string;
  term: string;
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  /** Asserted against the addon's return value — a search silently matching nothing is a broken benchmark, not a fast one. */
  expectHit: boolean;
}

/** The query mix a developer actually runs against terminal output. */
const SEARCH_CASES: SearchCase[] = [
  {
    label: "commonHit",
    term: "error",
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    expectHit: true,
  },
  {
    label: "rareHit",
    term: "TypeError",
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    expectHit: true,
  },
  {
    label: "pathHit",
    term: "electron/services/PtyManager.ts",
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    expectHit: true,
  },
  // Nothing matches, so the collection pass finds no candidates to highlight.
  {
    label: "miss",
    term: "zzqq-not-present",
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    expectHit: false,
  },
  // Alternation over corpus vocabulary, NOT over line numbers: cold mode feeds
  // a line before each search, so the buffer rotates across iterations and any
  // position-dependent term would eventually scroll out and flip to a miss.
  {
    label: "regex",
    term: "(error|failed)",
    caseSensitive: false,
    regex: true,
    wholeWord: false,
    expectHit: true,
  },
  {
    label: "caseSensitive",
    term: "Error",
    caseSensitive: true,
    regex: false,
    wholeWord: false,
    expectHit: true,
  },
  {
    label: "wholeWord",
    term: "info",
    caseSensitive: false,
    regex: false,
    wholeWord: true,
    expectHit: true,
  },
];

interface SweepResult {
  totalMs: number;
  p99SearchMs: number;
  worstMs: number;
  byLabel: Record<string, number>;
  decorations: number;
  /**
   * Cases whose hit/miss outcome was not the expected one, plus one for a
   * sweep that highlighted nothing at all. A search that stopped matching
   * walks less buffer and produces the fastest sweep this file can record, so
   * every timing here is only readable next to this number.
   */
  searchMisses: number;
}

/**
 * Run every query case once, timing each search individually. Selection is
 * cleared between cases so each starts its walk from the top of the buffer,
 * which is what a freshly-typed term does.
 *
 * `cold` feeds a line before each search to drop the addon's translated-line
 * cache, reproducing a terminal that is still receiving output. The feed itself
 * is outside the timed bracket.
 */
async function runSearchSweep(fixture: SearchableTerminal, cold: boolean): Promise<SweepResult> {
  const durations: number[] = [];
  const byLabel: Record<string, number> = {};
  fixture.resetDecorationCount();
  const terminal = fixture.terminal as unknown as { clearSelection: () => void };

  let searchMisses = 0;
  for (const testCase of SEARCH_CASES) {
    if (cold) await fixture.invalidateLineCache();
    terminal.clearSelection();
    const options = buildSearchOptions(testCase.caseSensitive, testCase.regex, testCase.wholeWord);
    const caseStart = performance.now();
    const found = fixture.addon.findNext(testCase.term, options);
    const elapsed = performance.now() - caseStart;

    if (found !== testCase.expectHit) searchMisses += 1;
    durations.push(elapsed);
    byLabel[testCase.label] = elapsed;
  }

  const decorations = fixture.decorationCount();
  // A sweep that highlighted nothing across every case is the highlight pass
  // having collapsed, not seven cheap searches.
  if (decorations === 0) searchMisses += 1;

  return {
    totalMs: durations.reduce((sum, ms) => sum + ms, 0),
    p99SearchMs: percentile(durations, 99),
    worstMs: Math.max(...durations),
    byLabel,
    decorations,
    searchMisses,
  };
}

/**
 * The addon registers one marker per highlighted match and releases it when the
 * decoration is disposed. Markers outliving a sweep mean the fixture's disposal
 * shim has drifted from the addon's contract, which silently inflates every
 * later sample on this cached terminal.
 */
function assertMarkersReleased(fixture: SearchableTerminal, scenarioId: string): void {
  const markers = fixture.markerCount();
  // One sweep's worth of slack: the final search's decorations are still live.
  if (markers > 2500) {
    throw new Error(
      `${scenarioId}: ${markers} markers still registered after the sweep — decoration disposal is leaking`
    );
  }
}

// Terminals are expensive to build and immutable once seeded, so both scenarios
// share one per scrollback size for the life of the process. The seed is part
// of the key so two callers asking for the same size with different corpora
// cannot silently receive each other's terminal.
const terminalCache = new Map<string, Promise<SearchableTerminal>>();

function getTerminal(scrollbackLines: number, seed: number): Promise<SearchableTerminal> {
  const key = `${scrollbackLines}:${seed}`;
  let existing = terminalCache.get(key);
  if (!existing) {
    existing = createSearchableTerminal(scrollbackLines, seed);
    terminalCache.set(key, existing);
  }
  return existing;
}

export const terminalSearchScenarios: PerfScenario[] = [
  {
    id: "PERF-193",
    name: "Terminal Search - Cold Sweep at Max Scrollback",
    description:
      "Real @xterm/addon-search over a terminal filled to the 10,000-line scrollback maximum, " +
      "running the query mix a developer types (common/rare/path literals, a no-match case, regex, " +
      "case-sensitive, whole-word). Each search runs with the addon's translated-line cache dropped " +
      "— the state a terminal still streaming agent output is always in — so durationMs and " +
      "p99SearchMs are what a real post-debounce search costs. warmP99SearchMs reports the quiet " +
      "terminal for contrast. searchMisses counts cases that did not produce their expected " +
      "hit/miss.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 2,
    correctness: ["searchMisses"],
    async run() {
      const fixture = await getTerminal(SCROLLBACK_MAX, 193);

      const coldStart = performance.now();
      const cold = await runSearchSweep(fixture, true);
      const durationMs = performance.now() - coldStart;
      const warm = await runSearchSweep(fixture, false);

      assertMarkersReleased(fixture, "PERF-193");

      const searchMisses = cold.searchMisses + warm.searchMisses;
      return {
        durationMs,
        metrics: {
          p99SearchMs: cold.p99SearchMs,
          worstSearchMs: cold.worstMs,
          warmP99SearchMs: warm.p99SearchMs,
          coldToWarmRatio: warm.p99SearchMs > 0 ? cold.p99SearchMs / warm.p99SearchMs : 0,
          missScanMs: cold.byLabel.miss ?? 0,
          regexSearchMs: cold.byLabel.regex ?? 0,
          decorations: cold.decorations,
          bufferLines: fixture.bufferLines,
          searchMisses,
        },
        notes:
          searchMisses > 0
            ? "a search case did not produce its expected hit/miss — these timings are not search timings"
            : undefined,
      };
    },
  },
  {
    id: "PERF-194",
    name: "Terminal Search - Scrollback Scaling + Match Stepping",
    description:
      "The cold sweep at the 1,000-line default and the 10,000-line maximum, plus 25 Enter-presses " +
      "of findNext and findPrevious (undebounced, straight into the addon). The stepping term is " +
      "primed outside the bracket so the metrics measure navigation only, not the first search's " +
      "highlight pass. Budgets the per-1k-line search slope and the stepping cost, so a regression " +
      "that only bites long-lived terminals — or one that defeats the addon's match cache and " +
      "re-collects per step — trips the gate.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 10, nightly: 16 },
    warmups: 1,
    correctness: ["searchMisses", "stepMisses"],
    async run() {
      const small = await getTerminal(SCROLLBACK_DEFAULT, 194);
      const large = await getTerminal(SCROLLBACK_MAX, 193);

      const start = performance.now();
      const smallSweep = await runSearchSweep(small, true);
      const largeSweep = await runSearchSweep(large, true);

      // Prime the stepping term OUTSIDE the timed loops: switching terms forces
      // a full highlight pass, and folding that into the first "step" would
      // report an enumeration as navigation cost.
      const stepOptions = buildSearchOptions(false, false, false);
      const STEP_TERM = "compiled";
      const STEPS = 25;
      if (!large.addon.findNext(STEP_TERM, stepOptions)) {
        throw new Error(`stepping term '${STEP_TERM}' not present — corpus is broken`);
      }

      const forwardStart = performance.now();
      let forwardHits = 0;
      for (let i = 0; i < STEPS; i += 1) {
        if (large.addon.findNext(STEP_TERM, stepOptions)) forwardHits += 1;
      }
      const forwardMs = performance.now() - forwardStart;

      const backStart = performance.now();
      let backHits = 0;
      for (let i = 0; i < STEPS; i += 1) {
        if (large.addon.findPrevious(STEP_TERM, stepOptions)) backHits += 1;
      }
      const backMs = performance.now() - backStart;
      const durationMs = performance.now() - start;

      assertMarkersReleased(large, "PERF-194");

      // Every step must land. Accepting "at least one" would pass a navigation
      // path stuck re-selecting the same match 25 times, and a stepper that
      // stops finding matches is the cheapest per-step cost measurable here.
      const stepMisses = STEPS - forwardHits + (STEPS - backHits);
      const searchMisses = smallSweep.searchMisses + largeSweep.searchMisses;
      return {
        durationMs,
        metrics: {
          smallP99SearchMs: smallSweep.p99SearchMs,
          largeP99SearchMs: largeSweep.p99SearchMs,
          msPerKLine: largeSweep.worstMs / (SCROLLBACK_MAX / 1000),
          stepForwardMs: forwardMs / STEPS,
          stepBackwardMs: backMs / STEPS,
          searchMisses,
          stepMisses,
        },
        notes:
          stepMisses > 0
            ? `match stepping incomplete: ${forwardHits}/${STEPS} forward, ${backHits}/${STEPS} backward`
            : undefined,
      };
    },
  },
];
