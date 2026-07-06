import type { PerfScenario } from "../types";
import {
  makeTerminalChunks,
  simulateTerminalOutputPass,
  spinEventLoop,
  createRng,
  createHeadlessTerminal,
} from "../lib/workloads";
import { percentile } from "../lib/stats";
import { INCREMENTAL_RESTORE_CONFIG } from "../../../src/services/terminal/types";

const BURST_CHUNKS = makeTerminalChunks(6000, 96);
const SUSTAINED_CHUNKS = makeTerminalChunks(3500, 180);
const LARGE_SCROLL_CHUNKS = makeTerminalChunks(9000, 200);

// One byte past the Daintree-side incremental-restore slice boundary —
// the scenario must cover both sides of `chunkBytes` to catch regressions
// in the slicing path.
const CROSSING_CHUNK_BYTES = INCREMENTAL_RESTORE_CONFIG.chunkBytes + 1024;
const STEADY_CHUNK_BYTES = 4 * 1024;

export const terminalScenarios: PerfScenario[] = [
  {
    id: "PERF-030",
    name: "Terminal Throughput - Burst + Sustained",
    description: "Stress terminal output pipeline with burst and sustained synthetic traffic.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    async run() {
      const burst = simulateTerminalOutputPass(BURST_CHUNKS, 4000);
      const sustained = simulateTerminalOutputPass(SUSTAINED_CHUNKS, 5000);
      await spinEventLoop(0.75);

      return {
        durationMs: 0,
        metrics: {
          renderedBytes: burst.renderedBytes + sustained.renderedBytes,
          retainedBytes: sustained.retainedBytes,
          checksum: burst.checksum + sustained.checksum,
        },
      };
    },
  },
  {
    id: "PERF-031",
    name: "Terminal Throughput - Multi Terminal",
    description: "Run simultaneous output streams while focus changes between terminals.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 16, nightly: 22 },
    warmups: 1,
    async run() {
      const rng = createRng(31031);
      const streamCount = 6;
      let checksum = 0;
      let renderedBytes = 0;

      for (let streamIndex = 0; streamIndex < streamCount; streamIndex += 1) {
        const chunks = makeTerminalChunks(1200 + streamIndex * 120, 80 + streamIndex * 5);
        const result = simulateTerminalOutputPass(chunks, 3000 + streamIndex * 500);
        renderedBytes += result.renderedBytes;
        checksum += result.checksum;

        // Focus changes trigger extra view work.
        if (rng() > 0.4) {
          await spinEventLoop(0.3);
        }
      }

      return {
        durationMs: 0,
        metrics: {
          renderedBytes,
          checksum,
        },
      };
    },
  },
  {
    id: "PERF-032",
    name: "Terminal Scroll Performance - Large Retained Output",
    description: "Evaluate retained-output and scroll-like workloads under large histories.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    async run() {
      const result = simulateTerminalOutputPass(LARGE_SCROLL_CHUNKS, 12000);

      // Simulate repeated scrollback slicing and viewport updates.
      let scrollChecksum = 0;
      const viewport = 120;
      const lineCount = Math.max(1, Math.floor(result.retainedBytes / 80));
      for (let i = 0; i < 300; i += 1) {
        const start = Math.max(0, Math.floor((i / 299) * Math.max(0, lineCount - viewport)));
        scrollChecksum += start + viewport;
      }

      await spinEventLoop(1.2);

      return {
        durationMs: 0,
        metrics: {
          renderedBytes: result.renderedBytes,
          retainedBytes: result.retainedBytes,
          checksum: result.checksum + scrollChecksum,
        },
      };
    },
  },
  {
    id: "PERF-033",
    name: "Terminal Write-to-Parse (Real @xterm/headless)",
    description:
      "Real xterm-headless terminal per iteration: drive a write→parse-done " +
      "bracket using terminal.write(data, callback) on chunks that exercise " +
      "the parser at a representative agent-terminal size, including a chunk " +
      "that crosses INCREMENTAL_RESTORE_CONFIG.chunkBytes (32 KiB). Bracketed " +
      "by the per-write callback to catch write-to-parse regressions on the " +
      "floor under all write-to-paint fixes.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 14, nightly: 20 },
    warmups: 1,
    async run() {
      const terminal = await createHeadlessTerminal({
        cols: 120,
        rows: 30,
        scrollback: 5000,
      });

      try {
        let parseInvocations = 0;
        terminal.onWriteParsed(() => {
          parseInvocations += 1;
        });

        const writeAndWait = (data: string): Promise<void> =>
          new Promise<void>((resolve) => {
            terminal.write(data, () => resolve());
          });

        // CROSSING_CHUNK_BYTES crosses the Daintree-side
        // INCREMENTAL_RESTORE_CONFIG.chunkBytes boundary. Real parser
        // cost, not synthetic.
        const crossing = "x".repeat(CROSSING_CHUNK_BYTES);
        // Steady-state size representative of normal log output.
        const steady = "y".repeat(STEADY_CHUNK_BYTES);
        // 100 log lines concatenated into a single write — the parser
        // still sees 100 newlines, but the per-write callback brackets
        // the whole batch (no Promise overhead per line).
        const logLines: string[] = [];
        for (let i = 0; i < 100; i += 1) {
          logLines.push(`log entry ${i} from agent terminal`);
        }
        const logStream = `${logLines.join("\n")}\n`;

        await writeAndWait(crossing);
        await writeAndWait(steady);
        await writeAndWait(logStream);

        const bytesWritten = crossing.length + steady.length + logStream.length;
        const lastLine =
          terminal.buffer.active
            .getLine(terminal.buffer.active.baseY - 1)
            ?.translateToString(true) ?? "";

        return {
          // Negative durationMs triggers the wall-clock fallback in run.ts
          // (the parser-done callbacks are awaited inside the bracket, so
          // wall-clock IS the cumulative write-to-parse latency).
          durationMs: -1,
          metrics: {
            bytesWritten,
            parseInvocations,
            lastLineLength: lastLine.length,
          },
        };
      } finally {
        terminal.dispose();
      }
    },
  },
  {
    id: "PERF-034",
    name: "Terminal Parse Isolation - Focused Echo Under Background Flood",
    description:
      "The paint-fabric parse-isolation baseline (docs/architecture/" +
      "terminal-paint-fabric.md): per round, 12 background headless " +
      "terminals enqueue one seeded ~2 KB chunk each on the shared thread, " +
      "then a focused terminal's 1-byte write measures keystroke-echo " +
      "latency behind that 12-deep parse queue; the queue drains fully " +
      "between rounds so every round measures the same deterministic burst " +
      "rather than an unbounded rolling backlog. echoDegradationX (burst " +
      "p99 / solo p99) is the single-thread serialization cost the fabric " +
      "exists to remove — Phase 0 must not move it, worker-parse (Phase 4) " +
      "must shrink it.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 5, ci: 8, nightly: 12 },
    warmups: 1,
    async run() {
      const BACKGROUND_TERMINALS = 12;
      const ROUNDS = 30;
      const ECHO_PAYLOAD = "k"; // one keystroke echoed back

      const focused = await createHeadlessTerminal({ cols: 120, rows: 30, scrollback: 1000 });
      const background: Array<Awaited<ReturnType<typeof createHeadlessTerminal>>> = [];
      for (let i = 0; i < BACKGROUND_TERMINALS; i += 1) {
        background.push(await createHeadlessTerminal({ cols: 120, rows: 30, scrollback: 1000 }));
      }

      try {
        const echoOnce = (): Promise<number> =>
          new Promise<number>((resolve) => {
            const start = performance.now();
            focused.write(ECHO_PAYLOAD, () => resolve(performance.now() - start));
          });

        const soloLatencies: number[] = [];
        for (let round = 0; round < ROUNDS; round += 1) {
          soloLatencies.push(await echoOnce());
        }

        // Seeded per-terminal streams; ~2 KB per chunk keeps each background
        // parse task well under xterm's 12 ms yield slice so the measurement
        // captures queueing across terminals, not one oversized task.
        const streams = background.map((_, index) => makeTerminalChunks(ROUNDS, 1800 + index * 16));

        let floodBytes = 0;
        const floodLatencies: number[] = [];
        for (let round = 0; round < ROUNDS; round += 1) {
          const pending: Array<Promise<void>> = [];
          for (let t = 0; t < BACKGROUND_TERMINALS; t += 1) {
            const chunk = streams[t]![round]!;
            floodBytes += chunk.length;
            pending.push(new Promise<void>((resolve) => background[t]!.write(chunk, resolve)));
          }
          // Echo is enqueued while all 12 background parses are pending, so it
          // measures queueing behind exactly that burst. Draining before the
          // next round keeps every sample independent — a rolling backlog
          // would compound across rounds and turn the gate nondeterministic.
          floodLatencies.push(await echoOnce());
          await Promise.all(pending);
        }

        const soloP99 = percentile(soloLatencies, 99);
        const floodP99 = percentile(floodLatencies, 99);

        return {
          // Wall-clock fallback: the whole solo+flood bracket is awaited, so
          // wall-clock is the cumulative write-to-parse cost of the workload.
          durationMs: -1,
          metrics: {
            soloEchoP99Ms: soloP99,
            floodEchoP99Ms: floodP99,
            echoDegradationX: soloP99 > 0 ? floodP99 / soloP99 : 0,
            floodBytes,
          },
        };
      } finally {
        focused.dispose();
        background.forEach((terminal) => terminal.dispose());
      }
    },
  },
];
