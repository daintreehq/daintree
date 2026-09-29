import { appendFileSync } from "fs";
import { describe, it, expect } from "vitest";
import { useResourceMonitoringStore } from "../resourceMonitoringStore";
import type { TerminalResourceBatchPayload } from "@shared/types/pty-host";

const IDS = 200;
const TICKS = 60;
const ROUNDS = 30;

function batch(tick: number, varying: boolean): TerminalResourceBatchPayload {
  const out: TerminalResourceBatchPayload = {};
  for (let i = 0; i < IDS; i++) {
    const cpu = varying ? (tick * 7 + i) % 100 : 1;
    out[`t${i}`] = {
      cpuPercent: cpu,
      memoryKb: 40960,
      processCount: 2,
      breakdown: [
        { pid: 10 + i, comm: "zsh", cpuPercent: cpu, memoryKb: 20480 },
        { pid: 20 + i, comm: "node", cpuPercent: 0, memoryKb: 20480 },
      ],
    };
  }
  return out;
}

function run(varying: boolean, prefill = 0) {
  const batches = Array.from({ length: TICKS }, (_, t) => batch(t, varying));
  const times: number[] = [];
  let replaced = 0;
  for (let r = 0; r < ROUNDS; r++) {
    useResourceMonitoringStore.setState({ enabled: true, metrics: new Map() });
    const store = useResourceMonitoringStore.getState();
    for (let t = 0; t < prefill; t++) store.updateMetrics(batch(t, varying));
    const t0 = performance.now();
    for (let t = 0; t < TICKS; t++) {
      const before = useResourceMonitoringStore.getState().metrics;
      store.updateMetrics(batches[t]!);
      if (r === 0) {
        const after = useResourceMonitoringStore.getState().metrics;
        for (const [id, v] of after) if (before.get(id) !== v) replaced++;
      }
    }
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { medianMs: times[Math.floor(ROUNDS / 2)]!, replaced };
}

// Timing only; the behaviour it relies on is covered in resourceMonitoringStore.test.ts.
describe.runIf(process.env.BENCH_OUT)("resourceMonitoringStore updateMetrics bench", () => {
  it("stops replacing entries once samples settle", () => {
    run(false); // warm-up
    const steady = run(false);
    const varying = run(true);
    const settled = run(false, 30);
    if (process.env.BENCH_OUT) {
      appendFileSync(
        process.env.BENCH_OUT,
        `store steady ${IDS}x${TICKS}: median ${steady.medianMs.toFixed(2)}ms, entries replaced ${steady.replaced}; varying: median ${varying.medianMs.toFixed(2)}ms, replaced ${varying.replaced}; settled (after 30 prefill): median ${settled.medianMs.toFixed(2)}ms, replaced ${settled.replaced}\n`
      );
    }
    expect(settled.replaced).toBe(0);
    expect(varying.replaced).toBe(IDS * TICKS);
  });
});
