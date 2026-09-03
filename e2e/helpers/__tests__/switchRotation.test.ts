import { describe, expect, it } from "vitest";
import {
  aggregate,
  generateStackDistanceTrace,
  groupMarksBySwitch,
  JOIN_TAIL_MS,
  mulberry32,
  parseNdjson,
  pct,
  summarizeSample,
  SWITCH_MARK,
  weightedQuantile,
  type AggregateInput,
  type MarkRecord,
  type SampleTimings,
  type SwitchMarkGroup,
} from "../switchRotation";

const PROJECTS = ["alpha", "bravo", "charlie", "delta", "echo"];

describe("generateStackDistanceTrace", () => {
  it("emits exactly samplesPerDepth samples per depth and is deterministic per seed", () => {
    const a = generateStackDistanceTrace({
      projectIds: PROJECTS,
      samplesPerDepth: 5,
      cap: 3,
      seed: 7,
    });
    const b = generateStackDistanceTrace({
      projectIds: PROJECTS,
      samplesPerDepth: 5,
      cap: 3,
      seed: 7,
    });
    const c = generateStackDistanceTrace({
      projectIds: PROJECTS,
      samplesPerDepth: 5,
      cap: 3,
      seed: 8,
    });
    expect(a).toEqual(b);
    expect(a.map((s) => s.depth)).not.toEqual(c.map((s) => s.depth));
    for (let depth = 1; depth <= 4; depth++) {
      expect(a.filter((s) => s.depth === depth)).toHaveLength(5);
    }
    expect(a.map((s) => s.index)).toEqual(a.map((_, i) => i));
  });

  it("models the MRU stack so every step's target is the project at that stack distance", () => {
    const trace = generateStackDistanceTrace({
      projectIds: PROJECTS,
      samplesPerDepth: 6,
      cap: 3,
      seed: 3,
    });
    const stack = [...PROJECTS];
    for (const step of trace) {
      expect(step.fromProjectId).toBe(stack[0]);
      expect(step.targetProjectId).toBe(stack[step.depth]);
      expect(step.targetProjectId).not.toBe(step.fromProjectId);
      stack.splice(step.depth, 1);
      stack.unshift(step.targetProjectId);
    }
  });

  it("classifies depth against the cache cap", () => {
    const cap3 = generateStackDistanceTrace({ projectIds: PROJECTS, samplesPerDepth: 2, cap: 3 });
    for (const step of cap3) {
      expect(step.expectedCache).toBe(step.depth <= 2 ? "warm" : "cold");
    }
    const cap5 = generateStackDistanceTrace({ projectIds: PROJECTS, samplesPerDepth: 2, cap: 5 });
    expect(cap5.every((step) => step.expectedCache === "warm")).toBe(true);
  });

  it("appends extra strata after the shuffled base and keeps the stack continuous", () => {
    const trace = generateStackDistanceTrace({
      projectIds: PROJECTS,
      samplesPerDepth: 1,
      cap: 3,
      extraSteps: [
        { depth: 1, entryPoint: "palette-mouse" },
        { depth: 2, entryPoint: "toolbar" },
      ],
    });
    expect(trace).toHaveLength(6);
    expect(
      trace.slice(0, 4).every((s) => s.entryPoint === "mru" || s.entryPoint === "palette-keyboard")
    ).toBe(true);
    expect(trace[4]!.entryPoint).toBe("palette-mouse");
    expect(trace[5]!.entryPoint).toBe("toolbar");
    expect(trace[5]!.fromProjectId).toBe(trace[4]!.targetProjectId);
  });

  it("refuses a project set too small for the requested depth", () => {
    expect(() =>
      generateStackDistanceTrace({ projectIds: PROJECTS.slice(0, 3), samplesPerDepth: 1, cap: 3 })
    ).toThrow(/at least 5 projects/);
  });

  it("mulberry32 is stable in [0, 1)", () => {
    const rand = mulberry32(42);
    const values = Array.from({ length: 1000 }, () => rand());
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(mulberry32(42)()).toBe(values[0]);
  });
});

describe("percentiles", () => {
  it("pct uses nearest rank and ignores non-finite values", () => {
    expect(pct([5, 1, 3, NaN, 2, 4], 50)).toBe(3);
    expect(pct([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(pct([10], 95)).toBe(10);
    expect(pct([], 50)).toBeNaN();
  });

  it("weightedQuantile weights samples rather than counting them", () => {
    // Two heavy 100s outweigh eight light 10s: the median is 100.
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 100, 100];
    const weights = [1, 1, 1, 1, 1, 1, 1, 1, 10, 10];
    expect(weightedQuantile(values, weights, 0.5)).toBe(100);
    expect(
      weightedQuantile(
        values,
        values.map(() => 1),
        0.5
      )
    ).toBe(10);
    expect(weightedQuantile([3, NaN, 1], [1, 1, 0], 0.5)).toBe(3);
    expect(weightedQuantile([], [], 0.5)).toBeNaN();
    expect(() => weightedQuantile([1], [], 0.5)).toThrow();
  });
});

function mark(name: string, elapsedMs: number, meta: Record<string, unknown> = {}): MarkRecord {
  return { mark: name, timestamp: 1_700_000_000_000 + elapsedMs, elapsedMs, meta };
}

const SWITCH = "sw-1";
const WC = 42;

function fullSwitch(): MarkRecord[] {
  const s = { switchId: SWITCH };
  return [
    mark(SWITCH_MARK.KEYDOWN, 1000, { ...s, webContentsId: 7 }),
    mark(SWITCH_MARK.INTENT, 1002, { ...s, webContentsId: 7 }),
    mark(SWITCH_MARK.BUSY_PAINTED, 1010, { ...s, webContentsId: 7 }),
    mark(SWITCH_MARK.IPC_SENT, 1020, { ...s, webContentsId: 7 }),
    mark(SWITCH_MARK.MAIN_RECEIVED, 1025, {
      ...s,
      cacheState: "cold",
      entryPoint: "mru",
      targetProjectId: "bravo",
      mainLoopLagMs: 3,
    }),
    mark(SWITCH_MARK.CHAIN_ENTERED, 1030, s),
    mark(SWITCH_MARK.VIEW_ATTACHED, 1100, { ...s, isNew: true, webContentsId: WC }),
    mark(SWITCH_MARK.GATE_RESOLVED, 1400, { ...s, gateOutcome: "signal", releaseChannel: "paint" }),
    mark(SWITCH_MARK.REVEALED, 1410, s),
    mark(SWITCH_MARK.REVEAL_REPAINT_DONE, 1430, { ...s, pass: "initial" }),
    mark(SWITCH_MARK.REVEAL_REPAINT_DONE, 2410, { ...s, pass: "backstop-1000" }),
    mark(SWITCH_MARK.SETTLED, 1600, { ...s, totalMs: 575 }),
    mark(SWITCH_MARK.FOCUSED_PANE_WOKEN, 1450, { ...s, webContentsId: WC }),
    mark(SWITCH_MARK.PTY_PORT_READY, 1460, { ...s, webContentsId: WC }),
  ];
}

describe("groupMarksBySwitch", () => {
  it("joins unlabelled renderer marks by webContentsId inside the switch window", () => {
    const records = [
      ...fullSwitch(),
      mark(SWITCH_MARK.HYDRATE_START, 1150, { webContentsId: WC }),
      mark(SWITCH_MARK.HYDRATE_COMPLETE, 1350, { webContentsId: WC }),
      // Same view but after the join tail: belongs to nothing.
      mark(SWITCH_MARK.RENDERER_LOAF, 1600 + JOIN_TAIL_MS + 1, {
        webContentsId: WC,
        durationMs: 80,
      }),
      // Another view inside the window: not this switch's incoming renderer.
      mark(SWITCH_MARK.HYDRATE_COMPLETE, 1300, { webContentsId: 99 }),
      // Before main_received: a previous switch's leftovers.
      mark(SWITCH_MARK.HYDRATE_COMPLETE, 900, { webContentsId: WC }),
      mark(SWITCH_MARK.EVENT_LOOP_LAG, 1200, { lagMs: 120 }),
      mark(SWITCH_MARK.EVENT_LOOP_LAG, 5000 + JOIN_TAIL_MS, { lagMs: 500 }),
      mark(SWITCH_MARK.APP_HYDRATE_PREFETCH, 1120, { hit: true, projectId: "bravo" }),
      mark(SWITCH_MARK.NONCE_PAINTED, 1500, { nonce: "n1", panelId: "p1" }),
      mark(SWITCH_MARK.NONCE_FRAME, 1516, { nonce: "n1" }),
    ];
    const { bySwitch, byNonce } = groupMarksBySwitch(records);
    const group = bySwitch.get(SWITCH)!;
    expect(group).toBeDefined();
    expect(group.targetWebContentsId).toBe(WC);
    expect(group.joined.map((r) => [r.mark, r.elapsedMs])).toEqual([
      [SWITCH_MARK.HYDRATE_START, 1150],
      [SWITCH_MARK.HYDRATE_COMPLETE, 1350],
    ]);
    expect(group.lagSamples.map((r) => r.elapsedMs)).toEqual([1200]);
    expect(group.prefetch?.elapsedMs).toBe(1120);
    expect(byNonce.get("n1")?.map((r) => r.mark)).toEqual([
      SWITCH_MARK.NONCE_PAINTED,
      SWITCH_MARK.NONCE_FRAME,
    ]);
    // Nonce marks never leak into the switch group.
    expect(group.marks.some((r) => r.mark === SWITCH_MARK.NONCE_PAINTED)).toBe(false);
  });

  it("parses NDJSON tolerantly, skipping partial trailing lines", () => {
    const text = [
      JSON.stringify(mark("a", 1)),
      "",
      JSON.stringify({ mark: "no-elapsed" }),
      '{"mark":"truncated","elapsedMs":',
    ].join("\n");
    expect(parseNdjson(text).map((r) => r.mark)).toEqual(["a"]);
  });
});

describe("summarizeSample", () => {
  function groupFor(records: MarkRecord[]): SwitchMarkGroup {
    return groupMarksBySwitch(records).bySwitch.get(SWITCH)!;
  }

  it("measures every timing from intent and reads the switch metadata", () => {
    const records = [
      ...fullSwitch(),
      mark(SWITCH_MARK.HYDRATE_COMPLETE, 1350, { webContentsId: WC }),
      mark(SWITCH_MARK.RENDERER_FIRST_INTERACTIVE, 1380, { webContentsId: WC }),
      mark(SWITCH_MARK.EVENT_LOOP_LAG, 1200, { lagMs: 120 }),
      mark(SWITCH_MARK.EVENT_LOOP_LAG, 1550, { lagMs: 30 }),
      // After settled: outside the lag overlap window even though inside the join tail.
      mark(SWITCH_MARK.EVENT_LOOP_LAG, 1700, { lagMs: 999 }),
      mark(SWITCH_MARK.RENDERER_LOAF, 1420, { webContentsId: WC, durationMs: 70 }),
      mark(SWITCH_MARK.APP_HYDRATE_PREFETCH, 1120, { hit: false, projectId: "bravo" }),
    ];
    const { bySwitch, byNonce } = groupMarksBySwitch([
      ...records,
      mark(SWITCH_MARK.NONCE_PAINTED, 1500, { nonce: "n1", panelId: "p1" }),
    ]);
    const summary = summarizeSample(bySwitch.get(SWITCH)!, byNonce.get("n1"), 480);

    expect(summary.anchorMark).toBe(SWITCH_MARK.INTENT);
    expect(summary.timings.keydownToIntentMs).toBe(2);
    expect(summary.timings.intentToBusyPaintedMs).toBe(8);
    expect(summary.timings.intentToIpcSentMs).toBe(18);
    expect(summary.timings.intentToMainReceivedMs).toBe(23);
    expect(summary.timings.intentToChainEnteredMs).toBe(28);
    expect(summary.timings.intentToViewAttachedMs).toBe(98);
    expect(summary.timings.intentToGateResolvedMs).toBe(398);
    expect(summary.timings.intentToRevealedMs).toBe(408);
    expect(summary.timings.intentToFocusReadyMs).toBe(480);
    expect(summary.timings.intentToNoncePaintedMs).toBe(498);
    expect(summary.timings.intentToFocusedPaneWokenMs).toBe(448);
    expect(summary.timings.intentToPtyPortReadyMs).toBe(458);
    expect(summary.timings.intentToHydrateCompleteMs).toBe(348);
    expect(summary.timings.intentToFirstInteractiveMs).toBe(378);
    expect(summary.timings.intentToSettledMs).toBe(598);
    expect(summary.timings.revealToRepaintDoneMs).toBe(20);
    expect(summary.timings.intentToAllPanesWokenMs).toBeNaN();

    expect(summary.lag).toEqual({
      mainLoopLagMs: 3,
      eventLoopLagOverlapMs: 150,
      rendererLoafCount: 1,
      rendererLoafTotalMs: 70,
    });
    expect(summary.actualCache).toBe("cold");
    expect(summary.gateOutcome).toBe("signal");
    expect(summary.releaseChannel).toBe("paint");
    expect(summary.prefetchHit).toBe(false);
    expect(summary.entryPointReported).toBe("mru");
    expect(summary.orderingViolations).toEqual([]);
  });

  it("prefers the main first_interactive mark and the main_loop_probe when present", () => {
    const records = [
      ...fullSwitch(),
      mark(SWITCH_MARK.FIRST_INTERACTIVE, 1390, { switchId: SWITCH }),
      mark(SWITCH_MARK.MAIN_LOOP_PROBE, 1026, { switchId: SWITCH, lagMs: 11 }),
      mark(SWITCH_MARK.RENDERER_FIRST_INTERACTIVE, 1380, { webContentsId: WC }),
    ];
    const summary = summarizeSample(groupFor(records));
    expect(summary.timings.intentToFirstInteractiveMs).toBe(388);
    expect(summary.lag.mainLoopLagMs).toBe(11);
  });

  it("anchors on main_received when the switch had no renderer intent", () => {
    const records = fullSwitch().filter(
      (r) => r.mark !== SWITCH_MARK.KEYDOWN && r.mark !== SWITCH_MARK.INTENT
    );
    const summary = summarizeSample(groupFor(records));
    expect(summary.anchorMark).toBe(SWITCH_MARK.MAIN_RECEIVED);
    expect(summary.timings.intentToMainReceivedMs).toBe(0);
    expect(summary.timings.intentToRevealedMs).toBe(385);
    expect(summary.timings.keydownToIntentMs).toBeNaN();
  });

  it("reports ordering violations instead of silently producing negative timings", () => {
    // Violations larger than the 2 ms cross-process clock-skew allowance; a
    // sub-skew inversion is rebasing error, not a causality break.
    const records = fullSwitch().map((r) =>
      r.mark === SWITCH_MARK.REVEALED ? { ...r, elapsedMs: 1390 } : r
    );
    const { bySwitch, byNonce } = groupMarksBySwitch([
      ...records,
      mark(SWITCH_MARK.NONCE_PAINTED, 1385, { nonce: "n1" }),
    ]);
    const summary = summarizeSample(bySwitch.get(SWITCH)!, byNonce.get("n1"));
    expect(summary.orderingViolations).toEqual([
      "gate_resolved ≤ revealed (1400 vs 1390)",
      "revealed < nonce_painted (1390 vs 1385)",
    ]);
  });

  it("tolerates inversions inside the clock-skew allowance", () => {
    const records = fullSwitch().map((r) =>
      r.mark === SWITCH_MARK.REVEALED ? { ...r, elapsedMs: 1399 } : r
    );
    const { bySwitch, byNonce } = groupMarksBySwitch([
      ...records,
      mark(SWITCH_MARK.NONCE_PAINTED, 1399, { nonce: "n1" }),
    ]);
    const summary = summarizeSample(bySwitch.get(SWITCH)!, byNonce.get("n1"));
    expect(summary.orderingViolations).toEqual([]);
  });
});

describe("aggregate", () => {
  function sample(
    depth: number,
    nonceMs: number,
    entryPoint = depth === 1 ? "mru" : "palette-keyboard",
    actualCache: AggregateInput["actualCache"] = depth <= 2 ? "warm" : "cold"
  ): AggregateInput {
    const timings = Object.fromEntries(
      [
        "keydownToIntentMs",
        "intentToBusyPaintedMs",
        "intentToIpcSentMs",
        "intentToMainReceivedMs",
        "intentToChainEnteredMs",
        "intentToViewAttachedMs",
        "intentToGateResolvedMs",
        "intentToRevealedMs",
        "intentToFocusReadyMs",
        "intentToNoncePaintedMs",
        "intentToFocusedPaneWokenMs",
        "intentToAllPanesWokenMs",
        "intentToPtyPortReadyMs",
        "intentToHydrateCompleteMs",
        "intentToFirstInteractiveMs",
        "intentToSettledMs",
        "revealToRepaintDoneMs",
      ].map((key) => [key, NaN])
    ) as SampleTimings;
    timings.intentToNoncePaintedMs = nonceMs;
    timings.intentToRevealedMs = nonceMs / 2;
    return { depth, actualCache, expectedCache: actualCache ?? "warm", entryPoint, timings };
  }

  it("buckets by depth, cache and entry point and weights depths as configured", () => {
    const samples = [
      sample(1, 100),
      sample(1, 110),
      sample(1, 120),
      sample(2, 200),
      sample(2, 220),
      sample(3, 800),
      sample(4, 1000, "toolbar"),
    ];
    const result = aggregate(samples, { 1: 0.55, 2: 0.25, 3: 0.12, 4: 0.08 });
    expect(result.byDepth[1]!.n).toBe(3);
    expect(result.byDepth[1]!.timings.intentToNoncePaintedMs!.p50).toBe(110);
    expect(result.byDepth[1]!.timings.intentToNoncePaintedMs!.max).toBe(120);
    expect(result.byDepth[1]!.timings.intentToAllPanesWokenMs).toBeUndefined();
    expect(result.byCache.warm.n).toBe(5);
    expect(result.byCache.cold.n).toBe(2);
    expect(result.byCache.cold.timings.intentToRevealedMs!.p95).toBe(500);
    expect(Object.keys(result.byEntryPoint).sort()).toEqual(["mru", "palette-keyboard", "toolbar"]);
    expect(result.byEntryPoint["toolbar"]!.n).toBe(1);
    // 55% of the weight sits at depth 1 (0.183 per sample), so the weighted
    // median is reached at the last depth-1 value...
    expect(result.weighted.timings.intentToNoncePaintedMs!.p50).toBe(120);
    // ...while the p95 reaches into the cold tail (cumulative 0.92 at depth 3 < 0.95).
    expect(result.weighted.timings.intentToNoncePaintedMs!.p95).toBe(1000);
    expect(result.weighted.effectiveWeights).toEqual({ 1: 0.55, 2: 0.25, 3: 0.12, 4: 0.08 });
  });

  it("renormalises weights across the depths actually present", () => {
    const result = aggregate([sample(1, 100), sample(2, 200)], { 1: 0.5, 2: 0.5, 3: 1 });
    expect(result.weighted.effectiveWeights).toEqual({ 1: 0.5, 2: 0.5 });
    expect(result.byDepth[3]).toBeUndefined();
  });

  it("falls back to the expected cache class when the app reported none", () => {
    const result = aggregate([sample(3, 500, "palette-keyboard", null)]);
    expect(result.byCache.warm.n).toBe(1);
    expect(result.byCache.cold.n).toBe(0);
  });
});
