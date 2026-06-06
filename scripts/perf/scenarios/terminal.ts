import type { PerfScenario } from "../types";
import {
  makeTerminalChunks,
  simulateTerminalOutputPass,
  spinEventLoop,
  createRng,
  createHeadlessTerminal,
} from "../lib/workloads";
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
];
