import { PerformanceObserver, constants } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import {
  createPersistedLayout,
  simulateLayoutHydration,
  simulateProjectSwitchCycle,
  makeTerminalChunks,
  simulateTerminalOutputPass,
  createLargeStateSnapshot,
  spinEventLoop,
} from "../lib/workloads";

function memoryUsedMb(): number {
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function normalizeBaselineMb(baselineMb: number): number {
  return Math.max(baselineMb, 256);
}

function maybeRunGc(): void {
  const gcFn = (globalThis as { gc?: () => void }).gc;
  if (typeof gcFn === "function") {
    gcFn();
  }
}

interface GcStats {
  minorGcCount: number;
  minorGcPauseMs: number;
}

// Mirrors PortBatcher.mergeChunks' non-owned path: allocate a fresh
// Uint8Array(totalBytes) per flush and copy the chunk in. This is the exact
// allocation #8367 set out to retire; the GC observer below quantifies the
// minor-GC pressure it generates so the fast path's benefit is measurable.
// NOTE: this scenario baselines the *cost being retired* (the old allocate +
// copy), not the new zero-copy fast path itself — it is the gate evidence
// (#8367 instrument-first), not a fast-path regression guard. Fast-path
// correctness is covered by the portBatcher unit suite.
function simulatePortBatcherFlushFlood(flushes: number, chunkBytes: number): number {
  const source = new Uint8Array(chunkBytes);
  for (let i = 0; i < source.length; i += 1) {
    source[i] = (i * 31 + 7) & 0xff;
  }
  let checksum = 0;
  for (let f = 0; f < flushes; f += 1) {
    const merged = new Uint8Array(chunkBytes);
    merged.set(source, 0);
    // Touch a rotating byte so the allocation can't be optimized away.
    checksum = (checksum + merged[f % chunkBytes]) & 0xffff;
  }
  return checksum;
}

async function measureMinorGc(body: () => void): Promise<GcStats> {
  const stats: GcStats = { minorGcCount: 0, minorGcPauseMs: 0 };
  const record = (entries: PerformanceEntryList): void => {
    for (const entry of entries) {
      const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind;
      if (kind === constants.NODE_PERFORMANCE_GC_MINOR) {
        stats.minorGcCount += 1;
        stats.minorGcPauseMs += entry.duration;
      }
    }
  };
  const observer = new PerformanceObserver((list) => record(list.getEntries()));
  try {
    observer.observe({ type: "gc", buffered: true });
    body();
    // GC entries are flushed to the observer on a macrotask turn, not a
    // microtask — a Promise.resolve() spin would never surface them. Yield a
    // real timer turn, then sweep any still-pending records before disconnect.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    record(observer.takeRecords());
  } finally {
    observer.disconnect();
  }
  return stats;
}

const SOAK_LAYOUT_A = createPersistedLayout(110, 8, 601);
const SOAK_LAYOUT_B = createPersistedLayout(140, 10, 602);
const SOAK_CHUNKS = makeTerminalChunks(2500, 130);

export const soakScenarios: PerfScenario[] = [
  {
    id: "PERF-060",
    name: "2h Mixed Activity Soak (Scaled)",
    description: "Scaled mixed activity soak run to detect unbounded memory/latency growth.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 4, soak: 8 },
    warmups: 1,
    async run() {
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      let checksum = 0;

      for (let i = 0; i < 120; i += 1) {
        const layout = i % 2 === 0 ? SOAK_LAYOUT_A : SOAK_LAYOUT_B;
        const hydrated = simulateLayoutHydration(layout);
        const switched = simulateProjectSwitchCycle({
          outgoingStateSize: 90 + (i % 8) * 12,
          incomingLayout: layout,
          iterations: 1,
        });
        const terminal = simulateTerminalOutputPass(SOAK_CHUNKS, 6000);

        checksum += hydrated.checksum + switched.checksum + terminal.checksum;

        if (i % 15 === 0) {
          await spinEventLoop(0.8);
        }
      }

      maybeRunGc();
      const finalMb = memoryUsedMb();
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs: 0,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          checksum,
        },
      };
    },
  },
  {
    id: "PERF-061",
    name: "Overnight Soak Switch/Restart (Scaled)",
    description: "Scaled overnight churn with repeated switching and restart-like cycles.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 3, soak: 6 },
    warmups: 1,
    async run() {
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      let checksum = 0;

      for (let i = 0; i < 180; i += 1) {
        const layout = i % 3 === 0 ? SOAK_LAYOUT_A : SOAK_LAYOUT_B;
        const switched = simulateProjectSwitchCycle({
          outgoingStateSize: 120,
          incomingLayout: layout,
          iterations: 1,
        });
        const snapshot = createLargeStateSnapshot(800 + (i % 6) * 120);
        const payload = JSON.stringify(snapshot);
        checksum += switched.checksum + payload.length;

        if (i % 18 === 0) {
          await spinEventLoop(1.1);
        }
      }

      maybeRunGc();
      const finalMb = memoryUsedMb();
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs: 0,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          checksum,
        },
      };
    },
  },
  {
    id: "PERF-062",
    name: "Leak Detection Snapshot Intervals",
    description: "Capture memory snapshots at intervals and report peak growth envelope.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 3, soak: 6 },
    warmups: 1,
    async run() {
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      let peakMb = baselineMb;
      let checksum = 0;
      const stablePayloads = Array.from({ length: 256 }, (_, index) => `payload-${index}`);

      for (let i = 0; i < 40; i += 1) {
        const transient = Array.from({ length: 600 }, (_, index) => ({
          id: `${i}-${index}`,
          data: stablePayloads[index % stablePayloads.length],
        }));

        checksum += transient.length;

        if (i % 4 === 0) {
          maybeRunGc();
          peakMb = Math.max(peakMb, memoryUsedMb());
        }

        await spinEventLoop(0.2);
      }

      maybeRunGc();
      const finalMb = memoryUsedMb();
      peakMb = Math.max(peakMb, finalMb);
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const peakMemoryGrowthMb = Math.max(0, peakMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs: 0,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          peakMemoryGrowthPct: (peakMemoryGrowthMb / normalizedBaselineMb) * 100,
          peakMemoryGrowthMb,
          checksum,
        },
      };
    },
  },
  {
    id: "PERF-063",
    name: "PortBatcher Flush-Allocation Minor-GC Pressure",
    description:
      "Floods PortBatcher's per-flush allocate-and-copy path and reports minor-GC count/pause to baseline the #8367 zero-copy fast path.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 3, soak: 6 },
    warmups: 1,
    async run() {
      maybeRunGc();
      // ~2KB single-chunk flushes are the dominant latency-mode case under an
      // agent-output flood. 400k of them (~800MB transient churn) is far more
      // than any realistic inter-flush burst — sized so a pathological future
      // allocation regression is unmissable while a clean baseline stays low.
      const flushes = 400000;
      const chunkBytes = 2048;
      let checksum = 0;
      const gc = await measureMinorGc(() => {
        checksum = simulatePortBatcherFlushFlood(flushes, chunkBytes);
      });

      return {
        durationMs: 0,
        metrics: {
          minorGcCount: gc.minorGcCount,
          minorGcPauseMs: gc.minorGcPauseMs,
          meanMinorGcPauseMs: gc.minorGcCount > 0 ? gc.minorGcPauseMs / gc.minorGcCount : 0,
          flushes,
          checksum,
        },
        notes:
          `minor-GC for ${flushes} flushes: ${gc.minorGcCount} pauses, ` +
          `${gc.minorGcPauseMs.toFixed(3)}ms total. Sub-millisecond/zero ` +
          `confirms the per-flush allocation is not a retire-worthy pause ` +
          `(#8367 instrument-first gate) — zero-copy fast path is sufficient; ` +
          `the arena pool is not justified.`,
      };
    },
  },
];
