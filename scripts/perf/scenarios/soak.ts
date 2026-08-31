import { PerformanceObserver, constants } from "node:perf_hooks";
import type { PerfScenario } from "../types";
import {
  createPersistedLayout,
  projectSwitchCycleMisses,
  simulateLayoutHydration,
  simulateProjectSwitchCycle,
  makeTerminalStream,
  simulateTerminalOutputPass,
  terminalOutputPassMisses,
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

/**
 * The checksum the flood MUST produce, derived from the byte-generation rule
 * rather than from the flood.
 *
 * `simulatePortBatcherFlushFlood` is the subject: a version that skipped the
 * allocate-and-copy entirely would burn no CPU, trigger no GC and post the
 * best numbers this scenario can record. Recomputing the expected sum without
 * allocating anything is the independent half — the running `& 0xffff` is
 * addition mod 2^16, so the total is just the sum of the touched source bytes.
 */
function expectedFlushChecksum(flushes: number, chunkBytes: number): number {
  let checksum = 0;
  for (let f = 0; f < flushes; f += 1) {
    checksum = (checksum + (((f % chunkBytes) * 31 + 7) & 0xff)) & 0xffff;
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
const SOAK_STREAM = makeTerminalStream(2500, 130);
const SOAK_SCROLLBACK = 6000;
/** Cycles per iteration. Named so the oracles can hold the loops to them. */
const MIXED_SOAK_CYCLES = 120;
const CHURN_SOAK_CYCLES = 180;
const LEAK_SAMPLE_CYCLES = 40;
const LEAK_RECORDS_PER_CYCLE = 600;
/** Fixed width, so the expected payload volume is arithmetic over the loop bounds. */
const LEAK_PAYLOAD_CHARS = 64;
const LEAK_HEAP_SAMPLE_EVERY = 4;
const LEAK_EXPECTED_HEAP_SAMPLES = Math.ceil(LEAK_SAMPLE_CYCLES / LEAK_HEAP_SAMPLE_EVERY);
const LEAK_EXPECTED_PAYLOAD_CHARS =
  LEAK_SAMPLE_CYCLES * LEAK_RECORDS_PER_CYCLE * LEAK_PAYLOAD_CHARS;

interface LeakRecord {
  id: string;
  data: string;
}

/**
 * What PERF-062's workload must have left behind for its growth envelope to
 * mean anything.
 *
 * The scenario reports memory growth, so every way of doing less work posts a
 * better number: allocating nothing, allocating records that hold a pointer
 * into a constant table instead of their own bytes, dropping each cycle's
 * records before the next reading, or reporting a heap sample without taking
 * one. Each term below is a reading only the real workload can produce —
 * payload volume accumulated per record as it was built (an empty record adds
 * nothing), the retained head of every cycle still holding its own bytes at the
 * end, and the sample values themselves rather than a counter incremented
 * beside the call. A constant sampler yields one distinct reading.
 *
 * There is deliberately no floor on the growth figure itself: heapUsed at the
 * start of an iteration still carries the previous one's garbage, so a GC
 * landing mid-run can cancel out real retention. That makes a floor a flake,
 * not an oracle.
 */
export function leakWorkloadMisses(observed: {
  retained: ReadonlyArray<LeakRecord | undefined>;
  payloadChars: number;
  heapSamples: readonly number[];
}): number {
  let unretained = 0;
  for (let cycle = 0; cycle < LEAK_SAMPLE_CYCLES; cycle += 1) {
    const head = observed.retained[cycle * LEAK_RECORDS_PER_CYCLE];
    if (
      !head ||
      head.id !== `${cycle}-0` ||
      head.data.length !== LEAK_PAYLOAD_CHARS ||
      !head.data.startsWith(head.id)
    ) {
      unretained += 1;
    }
  }

  return (
    Math.abs(LEAK_EXPECTED_PAYLOAD_CHARS - observed.payloadChars) +
    Math.abs(LEAK_EXPECTED_HEAP_SAMPLES - observed.heapSamples.length) +
    (new Set(observed.heapSamples).size > 1 ? 0 : 1) +
    unretained
  );
}

export const soakScenarios: PerfScenario[] = [
  {
    id: "PERF-060",
    name: "2h Mixed Activity Soak (Scaled)",
    description: "Scaled mixed activity soak run to detect unbounded memory/latency growth.",
    tier: "soak",
    modes: ["nightly", "soak"],
    iterations: { nightly: 4, soak: 8 },
    warmups: 1,
    correctness: ["soakMisses"],
    async run() {
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      const startedAt = performance.now();
      let checksum = 0;
      let soakMisses = 0;
      let cycles = 0;

      for (let i = 0; i < MIXED_SOAK_CYCLES; i += 1) {
        const layout = i % 2 === 0 ? SOAK_LAYOUT_A : SOAK_LAYOUT_B;
        const hydrated = simulateLayoutHydration(layout);
        const spec = {
          outgoingStateSize: 90 + (i % 8) * 12,
          incomingLayout: layout,
          iterations: 1,
        };
        const switched = simulateProjectSwitchCycle(spec);
        const terminal = simulateTerminalOutputPass(SOAK_STREAM.chunks, SOAK_SCROLLBACK);

        checksum += hydrated.checksum + switched.checksum + terminal.checksum;
        cycles += 1;
        soakMisses +=
          Math.abs(layout.panels.length - hydrated.restoredPanels) +
          Math.abs(layout.tabGroups.length - hydrated.restoredGroups) +
          projectSwitchCycleMisses(spec, switched) +
          terminalOutputPassMisses(SOAK_STREAM, SOAK_SCROLLBACK, terminal);

        if (i % 15 === 0) {
          await spinEventLoop(0.8);
        }
      }

      const durationMs = performance.now() - startedAt;
      maybeRunGc();
      const finalMb = memoryUsedMb();
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          checksum,
          // A soak that stopped churning holds its heap flat, which reads as the
          // cleanest run this scenario has ever recorded.
          soakMisses: soakMisses + Math.abs(MIXED_SOAK_CYCLES - cycles),
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
    correctness: ["churnMisses"],
    async run() {
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      const startedAt = performance.now();
      let checksum = 0;
      let churnMisses = 0;
      let cycles = 0;

      for (let i = 0; i < CHURN_SOAK_CYCLES; i += 1) {
        const layout = i % 3 === 0 ? SOAK_LAYOUT_A : SOAK_LAYOUT_B;
        const spec = { outgoingStateSize: 120, incomingLayout: layout, iterations: 1 };
        const switched = simulateProjectSwitchCycle(spec);
        const scale = 800 + (i % 6) * 120;
        const snapshot = createLargeStateSnapshot(scale);
        const payload = JSON.stringify(snapshot);
        checksum += switched.checksum + payload.length;
        cycles += 1;
        churnMisses +=
          projectSwitchCycleMisses(spec, switched) +
          // The snapshot builder is the restart-like half of the churn: its
          // panel count follows `scale` by construction, so a builder that
          // stopped building scores here instead of allocating nothing.
          Math.abs(scale - snapshot.appState.terminals.length) +
          (payload.length > 0 ? 0 : 1);

        if (i % 18 === 0) {
          await spinEventLoop(1.1);
        }
      }

      const durationMs = performance.now() - startedAt;
      maybeRunGc();
      const finalMb = memoryUsedMb();
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          checksum,
          churnMisses: churnMisses + Math.abs(CHURN_SOAK_CYCLES - cycles),
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
    correctness: ["leakMisses"],
    async run() {
      maybeRunGc();
      const baselineMb = memoryUsedMb();
      const startedAt = performance.now();
      let checksum = 0;
      let payloadChars = 0;
      const heapSamples: number[] = [];
      // Held for the whole run. Records dropped at the end of each cycle leave
      // the growth envelope reading its own baseline, so a workload that
      // allocated nothing would be indistinguishable from a healthy one.
      const retained: LeakRecord[] = [];

      for (let i = 0; i < LEAK_SAMPLE_CYCLES; i += 1) {
        for (let index = 0; index < LEAK_RECORDS_PER_CYCLE; index += 1) {
          const id = `${i}-${index}`;
          // Bytes of its own, not a reference into a shared table: a record
          // that borrows its payload costs nothing to keep alive.
          const data = id.padEnd(LEAK_PAYLOAD_CHARS, "-leak-payload");
          retained.push({ id, data });
          payloadChars += data.length;
          checksum += data.charCodeAt(LEAK_PAYLOAD_CHARS - 1);
        }

        if (i % LEAK_HEAP_SAMPLE_EVERY === 0) {
          heapSamples.push(memoryUsedMb());
        }

        await spinEventLoop(0.2);
      }

      const durationMs = performance.now() - startedAt;
      maybeRunGc();
      const finalMb = memoryUsedMb();
      const peakMb = Math.max(baselineMb, finalMb, ...heapSamples);
      const memoryGrowthMb = Math.max(0, finalMb - baselineMb);
      const peakMemoryGrowthMb = Math.max(0, peakMb - baselineMb);
      const normalizedBaselineMb = normalizeBaselineMb(baselineMb);
      const memoryGrowthPct = (memoryGrowthMb / normalizedBaselineMb) * 100;

      return {
        durationMs,
        metrics: {
          memoryGrowthPct,
          memoryGrowthMb,
          peakMemoryGrowthPct: (peakMemoryGrowthMb / normalizedBaselineMb) * 100,
          peakMemoryGrowthMb,
          checksum,
          leakMisses: leakWorkloadMisses({ retained, payloadChars, heapSamples }),
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
    correctness: ["floodMisses"],
    async run() {
      maybeRunGc();
      // ~2KB single-chunk flushes are the dominant latency-mode case under an
      // agent-output flood. 400k of them (~800MB transient churn) is far more
      // than any realistic inter-flush burst — sized so a pathological future
      // allocation regression is unmissable while a clean baseline stays low.
      const flushes = 400000;
      const chunkBytes = 2048;
      // Derived before the bracket opens so the oracle is never in the timing.
      const expectedChecksum = expectedFlushChecksum(flushes, chunkBytes);
      const startedAt = performance.now();
      let checksum = 0;
      const gc = await measureMinorGc(() => {
        checksum = simulatePortBatcherFlushFlood(flushes, chunkBytes);
      });
      const durationMs = performance.now() - startedAt;

      return {
        durationMs,
        metrics: {
          minorGcCount: gc.minorGcCount,
          minorGcPauseMs: gc.minorGcPauseMs,
          meanMinorGcPauseMs: gc.minorGcCount > 0 ? gc.minorGcPauseMs / gc.minorGcCount : 0,
          flushes,
          checksum,
          floodMisses: checksum === expectedChecksum ? 0 : 1,
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
