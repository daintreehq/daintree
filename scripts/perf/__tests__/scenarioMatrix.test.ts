import { describe, expect, it } from "vitest";
import {
  allScenarios,
  assertMatrixCoverage,
  CORRECTNESS_EXEMPT_SCENARIO_IDS,
  EXPECTED_SCENARIO_IDS,
  getScenariosForMode,
} from "../scenarios";
import { getConstructedReflowTerminalCount } from "../lib/reflowFixture";
import { classifyMetric } from "../lib/comparability";

/**
 * Scenarios that report no count-class metric and so need no paired miss
 * count. Every one of them reports only durations, a `checksum`, or a runtime
 * memory reading — none of which a dead subsystem can win by being dead the
 * way a spawn tally or an event count can.
 *
 * The list is explicit so the exemption is a decision rather than an oversight:
 * a new scenario is required to declare `correctness` or to be added here on
 * purpose.
 *
 * It is the SAME list `evaluateCorrectness` reads at run time — imported rather
 * than copied, because an exemption honoured at build time and ignored under
 * `--enforce-integrity` is a contract nothing can satisfy.
 *
 * It is now empty. It previously held fifteen scenarios whose oracles lived in
 * fixture modules (`workloads.ts`, `agentAnalysisSim.ts`, `packagedLaunch.ts`)
 * rather than in the scenario; those modules now report what each subject
 * produced — panels restored, chunks consumed, FSM flips observed, boot marks
 * emitted — and all fifteen declare a predicate against it. A checksum was
 * never an oracle here: nothing compared it to an expected value, so a subject
 * reduced to `return { checksum: 0 }` posted the best sample on record.
 */
const NO_COUNT_CLASS_METRICS = CORRECTNESS_EXEMPT_SCENARIO_IDS;

describe("perf scenario matrix", () => {
  it("covers full PERF matrix in both directions", () => {
    expect(() => assertMatrixCoverage()).not.toThrow();
    // Set equality against the one declaration, rather than a copied count.
    expect(new Set(allScenarios.map((scenario) => scenario.id))).toEqual(EXPECTED_SCENARIO_IDS);
  });

  it("assertMatrixCoverage rejects an undeclared scenario", () => {
    const undeclared = { ...allScenarios[0]!, id: "PERF-999" };
    allScenarios.push(undeclared);
    try {
      expect(() => assertMatrixCoverage()).toThrow(/PERF-999/);
    } finally {
      allScenarios.pop();
    }
  });

  it("importing the resize/reflow scenario module constructs no terminals", () => {
    // Lazy-fixture rule: fixture setup happens on first run()/warmup, never
    // at import. This must run before the PERF-112 execution test below.
    expect(getConstructedReflowTerminalCount()).toBe(0);
  });

  it("returns mode-specific scenario sets", () => {
    const smoke = getScenariosForMode("smoke");
    const ci = getScenariosForMode("ci");
    const nightly = getScenariosForMode("nightly");
    const soak = getScenariosForMode("soak");

    expect(smoke.length).toBeGreaterThan(0);
    expect(ci.length).toBeGreaterThan(smoke.length - 1);
    expect(nightly.length).toBeGreaterThanOrEqual(ci.length);
    expect(soak.length).toBeGreaterThan(0);
  });

  it("pairs every count-reporting scenario with a declared miss count", () => {
    const undeclared = allScenarios
      .filter((scenario) => !scenario.correctness?.length)
      .map((scenario) => scenario.id)
      .filter((id) => !NO_COUNT_CLASS_METRICS.has(id));
    expect(undeclared).toEqual([]);
  });

  it("keeps the exemption list free of scenarios that since gained a predicate", () => {
    const declared = new Set(allScenarios.filter((s) => s.correctness?.length).map((s) => s.id));
    expect([...NO_COUNT_CLASS_METRICS].filter((id) => declared.has(id))).toEqual([]);
  });

  it("declares only count-class metrics as correctness readings", () => {
    // A predicate has to survive `perf compare` between two machines, and only
    // the machine-independent classes do. A `*Ms` reading declared here would
    // be written off as timing noise on exactly the run that needed it.
    const wrong: string[] = [];
    for (const scenario of allScenarios) {
      for (const name of scenario.correctness ?? []) {
        const cls = classifyMetric(name);
        if (cls !== "count") wrong.push(`${scenario.id}:${name} is ${cls}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("has unique scenario IDs", () => {
    const ids = allScenarios.map((scenario) => scenario.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("PERF-080 returns valid metrics and fixture meets size threshold", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-080");
    expect(scenario).toBeDefined();

    const context = { mode: "ci" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    expect(sample.metrics!.terminalCount).toBeGreaterThan(0);
    expect(sample.metrics!.bytes).toBeGreaterThan(0);
  });

  it("PERF-033 write-to-parse scenario drives a real headless terminal", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-033");
    expect(scenario).toBeDefined();

    const context = { mode: "ci" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    // 33 KiB crossing + 4 KiB steady + 100 small lines (~26 bytes each) = ~39600
    expect(sample.metrics!.bytesWritten).toBeGreaterThan(39_000);
    // Each sequential write fires onWriteParsed once it drains. 3 writes
    // => at least 3 invocations (would catch coalescing/buffering regressions).
    expect(sample.metrics!.parseInvocations).toBeGreaterThanOrEqual(3);
    // Length of "log entry 99 from agent terminal" = 32. The last write
    // is the log stream, so the last line must be the final log entry.
    expect(sample.metrics!.lastLineLength).toBeGreaterThanOrEqual(32);
  });

  it("PERF-035 agent-analysis sim measures CPU and deterministic flip latencies", async () => {
    const { runAgentAnalysisSim } = await import("../lib/agentAnalysisSim");

    // Scaled-down phases: virtual time is simulated, so the 10s settle (which
    // must exceed the monitor's 8s idle debounce for the waiting flip to
    // fire) costs milliseconds of wall clock.
    const result = await runAgentAnalysisSim({
      agents: 1,
      phases: { workingMs: 2000, heavyMs: 500, settleMs: 10_000, resumeMs: 2000, tailMs: 500 },
    });

    expect(result.fedBytes).toBeGreaterThan(0);
    expect(result.cpuMs).toBeGreaterThan(0);
    expect(Number.isFinite(result.cpuMsPerMb)).toBe(true);
    // Virtual-time latencies: the working→waiting flip lands just past the 8s
    // idle debounce; waiting→working recovery lands past the 600-1500ms
    // working-signal debounce. Wide brackets — the exact values are the perf
    // budget's job; this guards that the sim's clock and FSM wiring work.
    expect(result.waitFlipLatencyMs).toBeGreaterThan(7000);
    expect(result.waitFlipLatencyMs).toBeLessThan(9500);
    expect(result.resumeFlipLatencyMs).toBeGreaterThan(300);
    expect(result.resumeFlipLatencyMs).toBeLessThan(2500);
    // The virtual clock must be fully uninstalled afterward: its epoch sits
    // in the future (1.8e12 ≈ 2027), so a restored real clock reads below it.
    expect(Date.now()).toBeLessThan(1_800_000_000_000);
  });

  it("PERF-034 parse-isolation scenario produces solo and flood echo brackets", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-034");
    expect(scenario).toBeDefined();

    const context = { mode: "smoke" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    // Both brackets must have measured real write-to-parse latencies.
    expect(sample.metrics!.soloEchoP99Ms).toBeGreaterThan(0);
    expect(sample.metrics!.floodEchoP99Ms).toBeGreaterThan(0);
    expect(sample.metrics!.echoDegradationX).toBeGreaterThan(0);
    expect(Number.isFinite(sample.metrics!.echoDegradationX)).toBe(true);
    // 12 background terminals × 30 rounds × ~1.8 KB chunks — if this shrinks,
    // the flood stopped flooding and the degradation signal is meaningless.
    expect(sample.metrics!.floodBytes).toBeGreaterThan(500_000);
  });

  it("PERF-150 fleet broadcast filters chaff to exactly the live grid terminals", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-150");
    expect(scenario).toBeDefined();

    const context = { mode: "smoke" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    // The armed set is 24 eligible + 12 ineligible panels; the real grid-location
    // predicate must drop the chaff (dock/exited/pty-less/browser) and keep 24.
    expect(sample.metrics!.eligibleTargets).toBe(24);
    expect(sample.metrics!.totalPanels).toBe(36);
    // Every target got a substituted payload dispatched through the broker.
    expect(sample.metrics!.ackBytes).toBeGreaterThan(0);
    expect(sample.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(sample.durationMs)).toBe(true);
  });

  it("PERF-161 oversized diff engages the whole-line fallback (no intra-line marking)", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-161");
    expect(scenario).toBeDefined();

    const context = { mode: "smoke" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    // Above the 3000-line markEdits budget, so the fallback path must be taken.
    expect(sample.metrics!.changedLines).toBeGreaterThan(3000);
    expect(sample.metrics!.markedIntraLine).toBe(0);
    // The real tokenizer still produced a highlighted token tree.
    expect(sample.metrics!.tokensProduced).toBe(1);
  });

  it("PERF-170 palette filter re-ranks every keystroke and measures the per-keystroke tail", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-170");
    expect(scenario).toBeDefined();

    const context = { mode: "smoke" as const, now: () => performance.now() };
    const sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    // One re-rank per typed character across the 7 queries (57 keystrokes total).
    expect(sample.metrics!.reRankCount).toBe(57);
    // The ranker matched real actions, and the per-keystroke tail is measured.
    // The frame-budget limit itself lives in budgets.json, not here.
    expect(sample.metrics!.totalMatches).toBeGreaterThan(0);
    expect(sample.metrics!.p99KeystrokeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(sample.metrics!.p99KeystrokeMs)).toBe(true);
  });

  it("PERF-112 keeps the over-budget reveal flat with respect to backlog size", async () => {
    const scenario = allScenarios.find((s) => s.id === "PERF-112");
    expect(scenario).toBeDefined();

    const context = { mode: "ci" as const, now: () => performance.now() };
    let sample = await scenario!.run(context);

    expect(sample.metrics).toBeDefined();
    let metrics = sample.metrics!;
    // Bounded arm parses ~768 KiB inside resize()'s flushSync — must be a real bracket.
    expect(metrics.revealBlockingMsSmallBacklog).toBeGreaterThan(0);
    // Over-budget arm resizes on an empty write buffer, then drains ~4 MiB.
    expect(metrics.drainMsLargeBacklog).toBeGreaterThan(0);
    // The drained backlog actually parsed at the new grid (scrollback-capped).
    expect(metrics.parsedLinesLargeBacklog).toBeGreaterThan(4_000);
    // Golden value pins the seeded generator's byte output — content drift
    // must be a conscious edit (and a new constant), never an accident.
    expect(metrics.backlogChecksum).toBe(835_845_091);

    // The incident invariant: a 4 MiB backlog must NOT block the reveal like
    // a flushed one — a bypassed budget gate lands at ~5x deterministically.
    // One retry absorbs a scheduler/GC spike in the single-sample bracket;
    // the perf harness gates the iteration-averaged metric separately.
    if ((metrics.largeToSmallBlockingRatio ?? Infinity) >= 3) {
      sample = await scenario!.run(context);
      metrics = sample.metrics!;
    }
    expect(metrics.largeToSmallBlockingRatio).toBeLessThan(3);
  });
});
