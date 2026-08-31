import type { PerfScenario } from "../types";
import { makeTerminalChunks, createHeadlessTerminal } from "../lib/workloads";
import {
  addPipelineMisses,
  buildPipelinePlan,
  emptyPipelineMisses,
  pipelinePassMisses,
  runInterleavedPipelinePlans,
  runPipelinePlan,
  type PipelinePlan,
} from "../lib/ptyOutputPipelineFixture";
import { percentile } from "../lib/stats";
import { INCREMENTAL_RESTORE_CONFIG } from "../../../src/services/terminal/types";
import { WorkerParseSession } from "../../../src/services/terminal/workerParse/WorkerParseSession";
import { createNodeParseWorkerTransport } from "../lib/nodeParseWorkerTransport";

// PERF-034's worker-ingest mode (issue #10960). Read from process.env directly:
// the perf harness runs under tsx (no Vite import.meta.env), and the renderer's
// env helper is renderer-scoped.
function isWorkerIngestPerfMode(): boolean {
  return process.env.DAINTREE_PAINT_FABRIC_WORKER_INGEST === "1";
}

/**
 * PERF-030/031/032 drive the real `PtyDataPipeline` — the per-chunk fan-out in
 * the PTY host — through `handlePtyData`, with the real OSC colour responder,
 * the real forensics ring, the real semantic ring, the real agent output ring
 * and the real identity-watcher prompt scan attached. `lib/ptyOutputPipeline
 * Fixture.ts` states what is stubbed (the analysis backend and the session
 * snapshotter, both counted) and why.
 *
 * They previously ran `simulateTerminalOutputPass`, a `push()`/`shift()` loop
 * over a `string[]` the harness owned, and imported no product code at all.
 *
 * PERF-033/034 below are unchanged and remain the xterm parse measurements;
 * these three are the retention and fan-out half, which nothing else covered.
 */

const MULTI_TERMINAL_COUNT = 6;

/**
 * Corpora are built once, lazily. Built inside `run()` they were wall-clocked
 * as if they were pipeline throughput — for PERF-031 that was more than twice
 * the cost of the passes being measured.
 */
let corpora: {
  burst: PipelinePlan;
  sustained: PipelinePlan;
  multi: PipelinePlan[];
  large: PipelinePlan;
} | null = null;

function plans(): NonNullable<typeof corpora> {
  if (corpora) return corpora;
  corpora = {
    // Burst: many small chunks, the shape of a `tsc --watch` or test-runner
    // flood, where per-chunk fixed cost dominates.
    burst: buildPipelinePlan({
      chunks: 600,
      linesPerChunk: 2,
      oscEvery: 41,
      promptEvery: 29,
      seed: 30,
    }),
    // Sustained: fewer, fatter chunks — an agent streaming a long answer.
    sustained: buildPipelinePlan({
      chunks: 260,
      linesPerChunk: 12,
      oscEvery: 53,
      promptEvery: 37,
      seed: 31,
    }),
    multi: Array.from({ length: MULTI_TERMINAL_COUNT }, (_, index) =>
      buildPipelinePlan({
        chunks: 150 + index * 20,
        linesPerChunk: 3 + (index % 3),
        oscEvery: 23 + index,
        promptEvery: 31 + index,
        seed: 300 + index,
      })
    ),
    // Large retained history: long enough that every ring is trimming on
    // essentially every chunk, which is the cost this scenario is named for.
    large: buildPipelinePlan({
      chunks: 1800,
      linesPerChunk: 4,
      oscEvery: 97,
      promptEvery: 71,
      seed: 32,
    }),
  };
  return corpora;
}

// One byte past the Daintree-side incremental-restore slice boundary —
// the scenario must cover both sides of `chunkBytes` to catch regressions
// in the slicing path.
const CROSSING_CHUNK_BYTES = INCREMENTAL_RESTORE_CONFIG.chunkBytes + 1024;
const STEADY_CHUNK_BYTES = 4 * 1024;
/** PERF-033 writes exactly three chunks and ends on the last log line. */
const WRITE_COUNT = 3;
const EXPECTED_LAST_LINE = "log entry 99 from agent terminal";

export const terminalScenarios: PerfScenario[] = [
  {
    id: "PERF-030",
    name: "Terminal Output Pipeline - Burst + Sustained",
    description:
      "The real PtyDataPipeline over two chunk shapes on one terminal: a " +
      "600-chunk burst of two-line writes (test-runner / tsc --watch flood, " +
      "where per-chunk fixed cost dominates) and a 260-chunk sustained stream " +
      "of twelve-line writes (an agent streaming a long answer). Every stage " +
      "is graded separately — the OSC colour responder in both directions, " +
      "the prompt-return demotion in both directions, and each retention ring " +
      "against the stream tail the fixture itself composed.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 18, nightly: 24 },
    warmups: 2,
    correctness: [
      "forwardMisses",
      "analysisFeedMisses",
      "snapshotScheduleMisses",
      "agentQueueMisses",
      "oscResponseMisses",
      "oscStripMisses",
      "promptReturnMisses",
      "forensicRingMisses",
      "outputRingMisses",
      "semanticRingMisses",
    ],
    run() {
      const { burst, sustained } = plans();
      const burstObserved = runPipelinePlan(burst, "perf-030-burst");
      const sustainedObserved = runPipelinePlan(sustained, "perf-030-sustained");
      const misses = addPipelineMisses(
        pipelinePassMisses(burst, burstObserved),
        pipelinePassMisses(sustained, sustainedObserved)
      );

      return {
        durationMs: -1,
        metrics: {
          chunkCount: burstObserved.chunksFed + sustainedObserved.chunksFed,
          forwardedBytes: burstObserved.emittedChars + sustainedObserved.emittedChars,
          retainedBytes:
            burstObserved.forensicTail.length +
            burstObserved.outputTail.length +
            sustainedObserved.forensicTail.length +
            sustainedObserved.outputTail.length,
          oscResponseCount: burstObserved.oscResponses + sustainedObserved.oscResponses,
          promptReturnCount: burstObserved.promptReturns + sustainedObserved.promptReturns,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-031",
    name: "Terminal Output Pipeline - Multi Terminal",
    description:
      "Six terminals' streams round-robin a chunk at a time through six real " +
      "PtyDataPipelines, which is how they arrive: one PTY host thread serves " +
      "every pane in the window, so chatty panes interleave at chunk " +
      "granularity rather than running to completion one after another. Each " +
      "terminal is graded against its own corpus, so a pipeline that mixed " +
      "two terminals' output would fail its ring oracles.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 16, nightly: 22 },
    warmups: 1,
    correctness: [
      "forwardMisses",
      "analysisFeedMisses",
      "snapshotScheduleMisses",
      "agentQueueMisses",
      "oscResponseMisses",
      "oscStripMisses",
      "promptReturnMisses",
      "forensicRingMisses",
      "outputRingMisses",
      "semanticRingMisses",
    ],
    run() {
      const multi = plans().multi;
      const observations = runInterleavedPipelinePlans(multi);
      const misses = emptyPipelineMisses();
      let chunkCount = 0;
      let forwardedBytes = 0;
      let retainedBytes = 0;

      for (let i = 0; i < multi.length; i += 1) {
        const observed = observations[i]!;
        addPipelineMisses(misses, pipelinePassMisses(multi[i]!, observed));
        chunkCount += observed.chunksFed;
        forwardedBytes += observed.emittedChars;
        retainedBytes += observed.forensicTail.length + observed.outputTail.length;
      }

      return {
        durationMs: -1,
        metrics: {
          terminalCount: multi.length,
          chunkCount,
          forwardedBytes,
          retainedBytes,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-032",
    name: "Terminal Output Pipeline - Large Retained History",
    description:
      "1,800 chunks through one real PtyDataPipeline: long enough that all " +
      "three retention rings — the 4,000-char forensics ring, the 2,000-char " +
      "agent output ring and the 50-line semantic ring — are trimming on " +
      "essentially every chunk. That trimming is the cost this scenario is " +
      "named for, and it is the one term that grows with history length, so " +
      "each ring is graded against the stream tail independently rather than " +
      "through a single aggregate.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: [
      "forwardMisses",
      "analysisFeedMisses",
      "snapshotScheduleMisses",
      "agentQueueMisses",
      "oscResponseMisses",
      "oscStripMisses",
      "promptReturnMisses",
      "forensicRingMisses",
      "outputRingMisses",
      "semanticRingMisses",
    ],
    run() {
      const large = plans().large;
      const observed = runPipelinePlan(large, "perf-032-large");
      const misses = pipelinePassMisses(large, observed);

      return {
        durationMs: -1,
        metrics: {
          chunkCount: observed.chunksFed,
          streamBytes: large.totalChars,
          forwardedBytes: observed.emittedChars,
          retainedBytes: observed.forensicTail.length + observed.outputTail.length,
          semanticLineCount: observed.semanticLines.length,
          ...misses,
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
    correctness: ["parseMisses"],
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
        // The final row the parser wrote, which is NOT `baseY - 1` — that row
        // sits a viewport above the cursor. The last log entry is a known
        // string, so this is the one reading here a parser has to have run to
        // satisfy.
        let lastWrittenLine = "";
        for (let row = terminal.buffer.active.length - 1; row >= 0; row -= 1) {
          const text = terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
          if (text.length > 0) {
            lastWrittenLine = text;
            break;
          }
        }

        return {
          // Negative durationMs triggers the wall-clock fallback in run.ts
          // (the parser-done callbacks are awaited inside the bracket, so
          // wall-clock IS the cumulative write-to-parse latency).
          durationMs: -1,
          metrics: {
            bytesWritten,
            parseInvocations,
            lastLineLength: lastLine.length,
            // `bytesWritten` is arithmetic over the inputs and `parseInvocations`
            // counts callbacks, neither of which needs a parser to have run.
            // The buffer is where the parse actually lands, so the final row is
            // checked against the exact string that was written last.
            parseMisses:
              Math.max(0, WRITE_COUNT - parseInvocations) +
              (lastWrittenLine === EXPECTED_LAST_LINE ? 0 : 1),
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
    correctness: ["floodParseMisses"],
    async run() {
      const BACKGROUND_TERMINALS = 12;
      const ROUNDS = 30;
      const TERMINAL_ROWS = 30;
      const ECHO_PAYLOAD = "k"; // one keystroke echoed back
      // `floodBytes` is summed off the input chunks, so it reads identically
      // whether the background terminals parsed them or dropped them — and a
      // flood that never lands is the cheapest possible `echoDegradationX`.
      // A terminal that parsed a 30-round stream has scrolled well past its
      // initial `rows` of buffer; one that parsed nothing has not moved.
      const unparsedCount = (
        terminals: Array<{ buffer: { active: { length: number } } }>
      ): number => terminals.filter((t) => t.buffer.active.length <= TERMINAL_ROWS).length;

      // Worker-ingest mode (DAINTREE_PAINT_FABRIC_WORKER_INGEST=1): the same
      // deterministic workload, but each background terminal's parse runs in a
      // real node worker_thread behind a WorkerParseSession — the live path's
      // isolation, minus Electron plumbing. echoDegradationX must shrink here;
      // with the gate off this scenario is byte-identical to the committed
      // baseline below.
      if (isWorkerIngestPerfMode()) {
        const focused = await createHeadlessTerminal({ cols: 120, rows: 30, scrollback: 1000 });
        const mirrors: Array<Awaited<ReturnType<typeof createHeadlessTerminal>>> = [];
        const sessions: WorkerParseSession[] = [];
        for (let i = 0; i < BACKGROUND_TERMINALS; i += 1) {
          const mirror = await createHeadlessTerminal({ cols: 120, rows: 30, scrollback: 1000 });
          mirrors.push(mirror);
          sessions.push(
            new WorkerParseSession(
              createNodeParseWorkerTransport(),
              { write: (data, callback) => mirror.write(data, callback) },
              // cadenceMs 0: ticks run manually as the per-round drain barrier,
              // keeping every round's measurement deterministic.
              { cols: 120, rows: 30, scrollback: 1000, cadenceMs: 0 }
            )
          );
        }

        try {
          // Worker boot barrier: a snapshot round-trip per session proves the
          // thread is up and its parser loaded. Without this, the solo bracket
          // below overlaps 12 threads still compiling xterm — inflating solo
          // latency and flattering the degradation ratio.
          await Promise.all(sessions.map((session) => session.tickNow()));

          const echoOnce = (): Promise<number> =>
            new Promise<number>((resolve) => {
              const start = performance.now();
              focused.write(ECHO_PAYLOAD, () => resolve(performance.now() - start));
            });

          const soloLatencies: number[] = [];
          for (let round = 0; round < ROUNDS; round += 1) {
            soloLatencies.push(await echoOnce());
          }

          const streams = mirrors.map((_, index) => makeTerminalChunks(ROUNDS, 1800 + index * 16));

          let floodBytes = 0;
          const floodLatencies: number[] = [];
          for (let round = 0; round < ROUNDS; round += 1) {
            for (let t = 0; t < BACKGROUND_TERMINALS; t += 1) {
              const chunk = streams[t]![round]!;
              floodBytes += chunk.length;
              sessions[t]!.feed(chunk);
            }
            // Echo is enqueued while all 12 worker feeds are in flight — the
            // whole point: background parse now rides sibling threads, so the
            // focused write should queue behind (nearly) nothing.
            floodLatencies.push(await echoOnce());
            // Drain barrier: a snapshot resolves only after the authority has
            // parsed every byte fed before it (endpoint FIFO + drain), and the
            // bounded apply also charges the mirror repaint to this round.
            await Promise.all(sessions.map((session) => session.tickNow()));
          }

          const soloP99 = percentile(soloLatencies, 99);
          const floodP99 = percentile(floodLatencies, 99);

          return {
            durationMs: -1,
            metrics: {
              soloEchoP99Ms: soloP99,
              floodEchoP99Ms: floodP99,
              echoDegradationX: soloP99 > 0 ? floodP99 / soloP99 : 0,
              floodBytes,
              floodParseMisses: unparsedCount(mirrors),
            },
          };
        } finally {
          sessions.forEach((session) => session.dispose());
          focused.dispose();
          mirrors.forEach((mirror) => mirror.dispose());
        }
      }

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
            floodParseMisses: unparsedCount(background),
          },
        };
      } finally {
        focused.dispose();
        background.forEach((terminal) => terminal.dispose());
      }
    },
  },
];
