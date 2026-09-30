// Node-level benchmark for terminal-exit snapshot capture and session persistence.
//   npx tsx scripts/perf/snapshot-io-bench.ts [iterations]
// Measures (a) AnalysisSession.captureFinalSnapshot plus the worker-boundary clone
// of its result, and (b) persistSessionSnapshotSync (the disk write on exit / kill).
import { MessageChannel } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const iterations = Number(process.argv[2] ?? 30);
process.env.DAINTREE_USER_DATA = mkdtempSync(path.join(tmpdir(), "snapshot-io-bench-"));

const { AnalysisSession } = await import("../../electron/services/pty/analysis/AnalysisSession.js");
const { persistSessionSnapshotSync } =
  await import("../../electron/services/pty/terminalSessionPersistence.js");

function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { median: pick(0.5), p95: pick(0.95), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

const session = new AnalysisSession(
  {
    terminalId: "bench",
    cols: 200,
    rows: 50,
    scrollback: 5000,
    restore: false,
    spawnedAt: 0,
    epoch: 1,
  },
  () => {}
);
const line = (i: number) =>
  `\x1b[32m${String(i).padStart(5, "0")}\x1b[0m \x1b[1mline of typical shell output\x1b[0m ${"abcdefghij".repeat(8)}\r\n`;
for (let i = 0; i < 5000; i++) session.feedChunk(line(i), { agentLive: false });
const warm = await session.serializeForPersistence();
const payloadKb = Math.round(Buffer.byteLength(warm!.data) / 1024);

const { port1, port2 } = new MessageChannel();
const roundTrip = (value: unknown) =>
  new Promise<void>((resolve) => {
    port2.once("message", () => resolve());
    port1.postMessage(value);
  });

const captureMs: number[] = [];
const cloneMs: number[] = [];
for (let i = 0; i < iterations + 3; i++) {
  const t0 = performance.now();
  const result = await session.captureFinalSnapshot();
  const t1 = performance.now();
  await roundTrip(result);
  const t2 = performance.now();
  if (i >= 3) {
    captureMs.push(t1 - t0);
    cloneMs.push(t2 - t1);
  }
}

const writeMs: number[] = [];
for (let i = 0; i < iterations + 3; i++) {
  const t0 = performance.now();
  persistSessionSnapshotSync(`term-${i % 8}`, warm!);
  const t1 = performance.now();
  if (i >= 3) writeMs.push(t1 - t0);
}

const fmt = (label: string, s: ReturnType<typeof stats>) =>
  `${label.padEnd(34)} median ${s.median.toFixed(2)} ms  p95 ${s.p95.toFixed(2)} ms  mean ${s.mean.toFixed(2)} ms`;
console.log(`payload ~${payloadKb} KB, ${iterations} iterations`);
console.log(fmt("captureFinalSnapshot", stats(captureMs)));
console.log(fmt("worker-boundary clone (result)", stats(cloneMs)));
console.log(fmt("persistSessionSnapshotSync", stats(writeMs)));
console.log(
  `RESULT ${JSON.stringify({ payloadKb, capture: stats(captureMs), clone: stats(cloneMs), write: stats(writeMs) })}`
);

rmSync(process.env.DAINTREE_USER_DATA, { recursive: true, force: true });
process.exit(0);
