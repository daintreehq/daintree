import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import type { PerfScenario } from "../types";

// ── Timer landscape model ──────────────────────────────────────────────

interface TimerGroupSpec {
  label: string;
  count: number;
  intervalMs: number;
  isInterval: boolean;
}

const TIMER_GROUPS: TimerGroupSpec[] = [
  { label: "animation-frames", count: 5, intervalMs: 16, isInterval: true },
  { label: "input-burst", count: 5, intervalMs: 150, isInterval: false },
  { label: "title-observers", count: 6, intervalMs: 200, isInterval: true },
  { label: "portal-cleanup", count: 8, intervalMs: 250, isInterval: false },
  { label: "chord-timeouts", count: 3, intervalMs: 500, isInterval: false },
  { label: "reflow-heartbeat", count: 4, intervalMs: 500, isInterval: true },
  { label: "voice-elapsed", count: 3, intervalMs: 1000, isInterval: true },
  { label: "store-polling", count: 12, intervalMs: 2000, isInterval: true },
  { label: "hibernation-guards", count: 6, intervalMs: 5000, isInterval: false },
  { label: "wake-managers", count: 5, intervalMs: 5000, isInterval: true },
  { label: "resource-profile", count: 3, intervalMs: 30000, isInterval: true },
  { label: "trash-sweeps", count: 4, intervalMs: 60000, isInterval: false },
  { label: "long-polls", count: 3, intervalMs: 60000, isInterval: true },
];

// ── Helpers ────────────────────────────────────────────────────────────

function memoryUsedMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function maybeRunGc(): void {
  const gcFn = (globalThis as { gc?: () => void }).gc;
  if (typeof gcFn === "function") gcFn();
}

function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1_000_000) / 1_000_000;
  };
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 1));
}

// ── Scheduler ──────────────────────────────────────────────────────────

interface BatchEntry {
  alignedMs: number;
  callbacks: number;
  totalDriftMs: number;
  maxDriftMs: number;
}

function computeBatches(
  groups: TimerGroupSpec[],
  floorMs: number,
  alignmentMs: number,
  simulatedDurationMs: number
): { batches: BatchEntry[]; unthrottledCount: number } {
  const bucket = new Map<number, { callbacks: number; totalDrift: number; maxDrift: number }>();
  let unthrottledCount = 0;
  const rng = seededRng(1337);

  for (const group of groups) {
    for (let ti = 0; ti < group.count; ti++) {
      const offset = group.isInterval ? 0 : Math.floor(rng() * group.intervalMs);
      let intended = offset;

      while (intended < simulatedDurationMs) {
        unthrottledCount++;
        const clamped = Math.max(intended, floorMs);
        const aligned = Math.ceil(clamped / alignmentMs) * alignmentMs;
        const drift = aligned - intended;

        let entry = bucket.get(aligned);
        if (!entry) {
          entry = { callbacks: 0, totalDrift: 0, maxDrift: 0 };
          bucket.set(aligned, entry);
        }
        entry.callbacks++;
        entry.totalDrift += drift;
        entry.maxDrift = Math.max(entry.maxDrift, drift);

        if (!group.isInterval) break;
        intended += group.intervalMs;
      }
    }
  }

  const batches: BatchEntry[] = [];
  for (const [alignedMs, e] of bucket) {
    batches.push({
      alignedMs,
      callbacks: e.callbacks,
      totalDriftMs: e.totalDrift,
      maxDriftMs: e.maxDrift,
    });
  }
  batches.sort((a, b) => a.alignedMs - b.alignedMs);
  return { batches, unthrottledCount };
}

// ── Scenario runner ────────────────────────────────────────────────────

const WORK_SCALE = 12;

async function runIdleWindow(mode: "basic" | "intensive"): Promise<{
  wakeUpCount: number;
  unthrottledCallbackCount: number;
  maxDriftMs: number;
  meanDriftMs: number;
  eventLoopLagP95Ms: number;
  eluUtilization: number;
  heapDeltaMb: number;
  memoryGrowthPct: number;
  checksum: number;
}> {
  const simulatedDurationMs = 60_000;
  const floorMs = mode === "intensive" ? 60_000 : 1_000;
  const alignmentMs = mode === "intensive" ? 60_000 : 1_000;

  const { batches, unthrottledCount } = computeBatches(
    TIMER_GROUPS,
    floorMs,
    alignmentMs,
    simulatedDurationMs
  );

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();

  maybeRunGc();
  const baselineMb = memoryUsedMb();
  await yieldToEventLoop();

  let checksum = 0;
  let activeWorkMs = 0;
  const stateMap = new Map<string, number>();

  for (let bi = 0; bi < batches.length; bi++) {
    const batch = batches[bi];
    const workUnits = Math.max(1, batch.callbacks * WORK_SCALE);
    const activeStart = performance.now();

    for (let w = 0; w < workUnits; w++) {
      const key = `k-${batch.alignedMs}-${w}`;
      stateMap.set(key, (stateMap.get(key) ?? 0) + 1);
      checksum += key.length + (stateMap.get(key) ?? 0);
    }

    // Clear periodically to simulate GC cycles across timer callbacks
    if (bi % 8 === 0) stateMap.clear();
    activeWorkMs += performance.now() - activeStart;

    // Yield every few batches so the event loop can process pending work
    if (bi % 4 === 0) {
      await yieldToEventLoop();
    }
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 11));
  histogram.disable();

  maybeRunGc();
  const finalMb = memoryUsedMb();
  const heapDeltaMb = Math.max(0, finalMb - baselineMb);
  const normalizedBaselineMb = Math.max(baselineMb, 256);
  const memoryGrowthPct = (heapDeltaMb / normalizedBaselineMb) * 100;

  let totalDrift = 0;
  let maxDrift = 0;
  for (const batch of batches) {
    totalDrift += batch.totalDriftMs;
    maxDrift = Math.max(maxDrift, batch.maxDriftMs);
  }

  return {
    wakeUpCount: batches.length,
    unthrottledCallbackCount: unthrottledCount,
    maxDriftMs: maxDrift,
    meanDriftMs: unthrottledCount > 0 ? Math.round((totalDrift / unthrottledCount) * 100) / 100 : 0,
    eventLoopLagP95Ms: Math.round(Number(histogram.percentiles.get(95) ?? 0) / 10_000) / 100,
    eluUtilization: Math.round(Math.min(1, activeWorkMs / simulatedDurationMs) * 10000) / 10000,
    heapDeltaMb: Math.round(heapDeltaMb * 100) / 100,
    memoryGrowthPct: Math.round(memoryGrowthPct * 100) / 100,
    checksum,
  };
}

// ── Scenarios ──────────────────────────────────────────────────────────

export const idleWindowScenarios: PerfScenario[] = [
  {
    id: "PERF-090",
    name: "Idle-Window Basic Throttling (60s)",
    description:
      "Models 60s of hidden-document timer pressure under basic background throttling (1s floor, top-of-second alignment, coalescing). 67 synthetic timers across 13 interval bands modeled after real renderer call sites. Assumes Chromium IntensiveWakeUpThrottling is enabled and setBackgroundThrottling(true) per-view.",
    tier: "soak",
    modes: ["nightly", "soak"],
    warmups: 1,
    iterations: { nightly: 3, soak: 6 },
    async run() {
      const result = await runIdleWindow("basic");
      return {
        durationMs: 0,
        metrics: {
          wakeUpCount: result.wakeUpCount,
          unthrottledCallbackCount: result.unthrottledCallbackCount,
          maxDriftMs: result.maxDriftMs,
          meanDriftMs: result.meanDriftMs,
          eventLoopLagP95Ms: result.eventLoopLagP95Ms,
          eluUtilization: result.eluUtilization,
          heapDeltaMb: result.heapDeltaMb,
          memoryGrowthPct: result.memoryGrowthPct,
          checksum: result.checksum,
        },
        notes: JSON.stringify({
          throttling: "basic (1s floor, top-of-second alignment)",
          timerGroupCount: TIMER_GROUPS.length,
          syntheticTimerCount: TIMER_GROUPS.reduce((s, g) => s + g.count, 0),
          simulatedDurationMs: 60_000,
          batchCount: result.wakeUpCount,
        }),
      };
    },
  },
  {
    id: "PERF-091",
    name: "Idle-Window Intensive Throttling (60s)",
    description:
      "Models 60s of hidden-document timer pressure under intensive wake-up throttling (60s floor, top-of-minute alignment, coalescing) as applied after 5+ minutes hidden. Same timer population as PERF-090.",
    tier: "soak",
    modes: ["nightly", "soak"],
    warmups: 1,
    iterations: { nightly: 3, soak: 6 },
    async run() {
      const result = await runIdleWindow("intensive");
      return {
        durationMs: 0,
        metrics: {
          wakeUpCount: result.wakeUpCount,
          unthrottledCallbackCount: result.unthrottledCallbackCount,
          maxDriftMs: result.maxDriftMs,
          meanDriftMs: result.meanDriftMs,
          eventLoopLagP95Ms: result.eventLoopLagP95Ms,
          eluUtilization: result.eluUtilization,
          heapDeltaMb: result.heapDeltaMb,
          memoryGrowthPct: result.memoryGrowthPct,
          checksum: result.checksum,
        },
        notes: JSON.stringify({
          throttling: "intensive (60s floor, top-of-minute alignment, 5+ min hidden)",
          timerGroupCount: TIMER_GROUPS.length,
          syntheticTimerCount: TIMER_GROUPS.reduce((s, g) => s + g.count, 0),
          simulatedDurationMs: 60_000,
          batchCount: result.wakeUpCount,
        }),
      };
    },
  },
];
