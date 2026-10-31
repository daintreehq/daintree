import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import { armBystanderProbe, type BystanderProbe, type BystanderReading } from "../lib/bystander";
import type { PerfScenario, ScenarioSample } from "../types";
import {
  buildMarkdownDiff,
  parseMarkdownBlocks,
  MARKDOWN_DIFF_MAX_BLOCKS,
  MARKDOWN_DIFF_MAX_LINES,
  type MarkdownDiffResult,
} from "../../../src/components/Worktree/markdownBlockDiff";
import { MarkdownDiffClient } from "../../../src/services/MarkdownDiffService";
import {
  OPEN_FIXTURES,
  STEP_FIXTURES,
  buildMarkdownDiffFixture,
  type MarkdownDiffFixture,
} from "../lib/markdownDiffFixture";
import {
  createNodeMarkdownDiffWorkerFactory,
  type NodeMarkdownDiffWorkerHarness,
} from "../lib/nodeMarkdownDiffWorkerTransport";

// The rendered-Markdown diff engine (#15679): `buildMarkdownDiff` rebuilds the
// old document from the patch, parses both sides with remark + GFM, and runs
// the block LCS, pairing pass and word diff. It used to run inside a render on
// the renderer's main thread; documents over 16 KB now go to a worker through
// `MarkdownDiffClient`. Both scenarios measure the old path (the engine called
// directly, on this loop) and the new one (the unmodified client driving a real
// worker thread running the same engine) in the same run, so the before/after
// comes from one machine in one session.
//
// The headline is main-thread availability — the bystander probe — because
// that is what the change moves. Time-to-verdict is reported beside it and is
// expected to be about the same or slightly worse on the worker: the work is
// identical, plus two structured clones and a thread hop. A dead worker blocks
// nothing and posts perfect stall numbers, so every reading is paired with
// predicates proving the worker arm produced the engine's exact output, on the
// worker thread.

const PROBE_CADENCE_MS = 8;
const WORKER_KEY = "perf-pane";

/** Documents at or past this size are the ones the issue asks to see drop. */
const LARGE_DOCUMENT_BYTES = 200_000;

function verdictOf(result: MarkdownDiffResult | null): string {
  if (result === null) return "superseded";
  return result.ok ? "ok" : result.reason;
}

/**
 * Apparatus checks, made outside every bracket: the fixture is the size it
 * claims, carries its edits, and reaches its verdict for the reason it claims.
 * A refused fixture must be refused by the BLOCK ceiling, after both parses —
 * the issue's case — not by the line ceiling, which refuses before any parse
 * and would make the in-thread arm look nearly free.
 */
function fixtureMisses(fixture: MarkdownDiffFixture, reference: MarkdownDiffResult): number {
  let misses = 0;
  const { spec } = fixture;
  if (fixture.sourceBytes < spec.targetBytes) misses++;
  if (fixture.editedLines === 0) misses++;
  if (fixture.sourceLines > MARKDOWN_DIFF_MAX_LINES) misses++;
  const blocks = parseMarkdownBlocks(fixture.input.newSource ?? "").blocks.length;
  if (spec.expected === "too-large" ? blocks <= MARKDOWN_DIFF_MAX_BLOCKS : blocks > MARKDOWN_DIFF_MAX_BLOCKS) {
    misses++;
  }
  if (verdictOf(reference) !== spec.expected) misses++;
  return misses;
}

function blockCount(fixture: MarkdownDiffFixture): number {
  return parseMarkdownBlocks(fixture.input.newSource ?? "").blocks.length;
}

interface ArmOutcome {
  result: MarkdownDiffResult | null;
  verdictMs: number;
  reading: BystanderReading;
}

/**
 * Run one arm under its own probe, with a collection in front so it does not
 * inherit the previous arm's garbage. The probe holds a referenced timer, so it
 * is stopped on every exit path.
 */
async function measureArm(
  watches: BystanderProbe[],
  work: () => MarkdownDiffResult | null | Promise<MarkdownDiffResult | null>
): Promise<ArmOutcome> {
  globalThis.gc?.();
  const watch = await armBystanderProbe({ cadenceMs: PROBE_CADENCE_MS });
  watches.push(watch);
  const start = performance.now();
  const result = await work();
  const verdictMs = performance.now() - start;
  return { result, verdictMs, reading: watch.stop() };
}

function sleepUntil(target: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, target - performance.now())));
}

/**
 * Routing evidence for a worker arm: exactly one worker thread, every request
 * the client posted was delivered back, the worker's own tally ran each of
 * them, and it ran them off this thread. A client that quietly fell back to
 * building in-thread would post nothing and fail here rather than report a
 * main-thread block as a property of the worker.
 */
async function routingMisses(
  harnesses: readonly NodeMarkdownDiffWorkerHarness[],
  expectedPosts: number | null
): Promise<{ misses: number; executed: number; posted: number }> {
  const harness = harnesses[0];
  if (harnesses.length !== 1 || !harness) return { misses: 1, executed: 0, posted: 0 };
  let misses = harness.failures.length;
  const stats = await harness.stats();
  if (stats.threadId === 0) misses++;
  if (expectedPosts !== null && harness.posted.length !== expectedPosts) misses++;
  if (!isDeepStrictEqual(harness.posted, harness.delivered)) misses++;
  if (!isDeepStrictEqual(harness.posted, stats.executedIds)) misses++;
  return { misses, executed: stats.executedIds.length, posted: harness.posted.length };
}

export const markdownDiffScenarios: PerfScenario[] = [
  {
    id: "PERF-419",
    name: "Rendered Markdown Diff - Main-Thread Cost by Document Size",
    description:
      "buildMarkdownDiff over seven generated documents sized to the issue's (#15679) table — 9, " +
      "67, 103, 217 and 236 KB within the block ceiling, then 328 KB and a 5,000-line changelog " +
      "both refused by the 500-block ceiling after both parses — each a single-hunk patch editing " +
      "one line in fifty. Each document is built twice per iteration: in-thread (the engine on this " +
      "loop, as the render-time useMemo ran it) and through the unmodified MarkdownDiffClient on a " +
      "warm node:worker_threads worker running the same engine, each arm under its own bystander " +
      "probe with a collection in front. durationMs is the summed worker time-to-verdict; the " +
      "per-document LongestStallMs pairs are the finding. Worker spawn and module load are excluded " +
      "from the arms and reported once as workerColdStartMs. The worker arm's result must deep-equal " +
      "the in-thread engine's (verdict, every block, pairing, segment and inline range), and must be " +
      "shown to have crossed to the worker thread and back.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: ["verdictMisses", "modelMisses", "fixtureMisses", "workerRoutingMisses", "probeMisses"],
    async run(): Promise<ScenarioSample> {
      const fixtures = OPEN_FIXTURES.map(buildMarkdownDiffFixture);
      const { factory, harnesses } = createNodeMarkdownDiffWorkerFactory();
      const client = new MarkdownDiffClient(factory);
      const watches: BystanderProbe[] = [];
      const metrics: Record<string, number> = {};
      let verdictMisses = 0;
      let modelMisses = 0;
      let fixtureMissCount = 0;
      let probeMisses = 0;
      let workerTotalMs = 0;
      let inThreadMaxStall = 0;
      let workerMaxStall = 0;
      let largeInThreadMaxStall = 0;
      let largeWorkerMaxStall = 0;

      try {
        // Spawn and module-load on a discarded build of the smallest document:
        // a one-off per session, which folded into an arm would read as an
        // ongoing foreground cost.
        const coldStart = performance.now();
        const warm = await client.build(WORKER_KEY, fixtures[0]!.input);
        metrics.workerColdStartMs = performance.now() - coldStart;
        if (verdictOf(warm) !== fixtures[0]!.spec.expected) verdictMisses++;

        for (const fixture of fixtures) {
          const { label } = fixture.spec;
          const reference = buildMarkdownDiff(fixture.input);
          fixtureMissCount += fixtureMisses(fixture, reference);

          const inThread = await measureArm(watches, () => buildMarkdownDiff(fixture.input));
          const worker = await measureArm(watches, () => client.build(WORKER_KEY, fixture.input));

          if (verdictOf(inThread.result) !== fixture.spec.expected) verdictMisses++;
          if (verdictOf(worker.result) !== fixture.spec.expected) verdictMisses++;
          if (!isDeepStrictEqual(worker.result, reference)) modelMisses++;
          if (!isDeepStrictEqual(inThread.result, reference)) modelMisses++;
          probeMisses += inThread.reading.probeMisses + worker.reading.probeMisses;

          metrics[`${label}SourceBytes`] = fixture.sourceBytes;
          metrics[`${label}PatchBytes`] = fixture.patchBytes;
          metrics[`${label}BlockCount`] = blockCount(fixture);
          metrics[`${label}InThreadVerdictMs`] = inThread.verdictMs;
          metrics[`${label}WorkerVerdictMs`] = worker.verdictMs;
          metrics[`${label}InThreadLongestStallMs`] = inThread.reading.longestStallMs;
          metrics[`${label}WorkerLongestStallMs`] = worker.reading.longestStallMs;
          metrics[`${label}InThreadBlockedMs`] = inThread.reading.blockedMs;
          metrics[`${label}WorkerBlockedMs`] = worker.reading.blockedMs;

          workerTotalMs += worker.verdictMs;
          inThreadMaxStall = Math.max(inThreadMaxStall, inThread.reading.longestStallMs);
          workerMaxStall = Math.max(workerMaxStall, worker.reading.longestStallMs);
          if (fixture.sourceBytes >= LARGE_DOCUMENT_BYTES) {
            largeInThreadMaxStall = Math.max(largeInThreadMaxStall, inThread.reading.longestStallMs);
            largeWorkerMaxStall = Math.max(largeWorkerMaxStall, worker.reading.longestStallMs);
          }
        }

        // One warm-up plus one build per document, each posted, delivered and
        // run on the worker thread.
        const routing = await routingMisses(harnesses, fixtures.length + 1);
        metrics.workerExecutedJobs = routing.executed;
        metrics.workerRoutingMisses = routing.misses;
      } finally {
        watches.forEach((watch) => watch.stop());
        client.dispose();
        await Promise.all(harnesses.map((harness) => harness.close()));
      }

      return {
        durationMs: workerTotalMs,
        metrics: {
          ...metrics,
          inThreadLongestStallMs: inThreadMaxStall,
          workerLongestStallMs: workerMaxStall,
          largeInThreadLongestStallMs: largeInThreadMaxStall,
          largeWorkerLongestStallMs: largeWorkerMaxStall,
          verdictMisses,
          modelMisses,
          fixtureMisses: fixtureMissCount,
          probeMisses,
        },
      };
    },
  },
  {
    id: "PERF-420",
    name: "Rendered Markdown Diff - Stepping Between Two Long Documents",
    description:
      "A reviewer holding j/k across two ~217 KB documents: eight selections alternating between " +
      "them, one every 50 ms on an absolute schedule, under one pane's key. The in-thread arm builds " +
      "each selection when its turn comes, as the render-time useMemo did on every step, so later " +
      "keystrokes wait behind earlier builds; the worker arm hands each to the unmodified " +
      "MarkdownDiffClient without waiting, so its admission gate runs the build in flight and the " +
      "last selection and supersedes the rest. finalSelectionMs is from the last keystroke's " +
      "scheduled time to its verdict — a service-level completion time, not keystroke-to-paint. " +
      "durationMs is the worker arm's finalSelectionMs. The final result must deep-equal the engine's " +
      "for the last document on both arms, no earlier worker request may deliver a verdict after " +
      "a newer one was issued (and any it delivers before must be its own document's), and the " +
      "worker arm must be shown to have run on the " +
      "worker thread. Executed job counts are reported, not graded.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 4, ci: 8, nightly: 12 },
    warmups: 1,
    correctness: [
      "finalSelectionMisses",
      "supersededResolutionMisses",
      "fixtureMisses",
      "workerRoutingMisses",
      "probeMisses",
    ],
    async run(): Promise<ScenarioSample> {
      const SELECTIONS = 8;
      const INTERVAL_MS = 50;
      const fixtures = STEP_FIXTURES.map(buildMarkdownDiffFixture);
      const references = fixtures.map((fixture) => buildMarkdownDiff(fixture.input));
      const sequence = Array.from({ length: SELECTIONS }, (_, index) => index % fixtures.length);
      const finalIndex = sequence[SELECTIONS - 1]!;
      const finalReference = references[finalIndex]!;

      const { factory, harnesses } = createNodeMarkdownDiffWorkerFactory();
      const client = new MarkdownDiffClient(factory);
      const watches: BystanderProbe[] = [];
      let fixtureMissCount = 0;
      let finalSelectionMisses = 0;
      let supersededResolutionMisses = 0;
      let probeMisses = 0;
      let workerFinalMs = 0;
      const metrics: Record<string, number> = {};

      fixtures.forEach((fixture, index) => {
        fixtureMissCount += fixtureMisses(fixture, references[index]!);
      });
      if (isDeepStrictEqual(references[0], references[1])) fixtureMissCount++;

      try {
        const warm = await client.build(WORKER_KEY, fixtures[0]!.input);
        if (!isDeepStrictEqual(warm, references[0])) finalSelectionMisses++;

        let inThreadFinalMs = 0;
        const inThread = await measureArm(watches, async () => {
          const origin = performance.now();
          let last: MarkdownDiffResult | null = null;
          for (let step = 0; step < SELECTIONS; step++) {
            const scheduled = origin + step * INTERVAL_MS;
            await sleepUntil(scheduled);
            last = buildMarkdownDiff(fixtures[sequence[step]!]!.input);
            if (step === SELECTIONS - 1) inThreadFinalMs = performance.now() - scheduled;
          }
          return last;
        });

        // Each earlier request with what it resolved to, when, and when the next
        // selection superseded it.
        const earlier: Array<
          Promise<{ result: MarkdownDiffResult | null; settledAt: number; document: number }>
        > = [];
        const supersededAt: number[] = [];
        const worker = await measureArm(watches, async () => {
          const origin = performance.now();
          let last: Promise<MarkdownDiffResult | null> = Promise.resolve(null);
          let lastScheduled = origin;
          for (let step = 0; step < SELECTIONS; step++) {
            lastScheduled = origin + step * INTERVAL_MS;
            await sleepUntil(lastScheduled);
            if (step > 0) supersededAt.push(performance.now());
            last = client.build(WORKER_KEY, fixtures[sequence[step]!]!.input);
            if (step < SELECTIONS - 1) {
              const document = sequence[step]!;
              earlier.push(last.then((result) => ({ result, settledAt: performance.now(), document })));
            }
          }
          const result = await last;
          workerFinalMs = performance.now() - lastScheduled;
          return result;
        });

        if (!isDeepStrictEqual(inThread.result, finalReference)) finalSelectionMisses++;
        if (!isDeepStrictEqual(worker.result, finalReference)) finalSelectionMisses++;
        // A build that finished before the next keystroke may deliver its own
        // document; once a newer selection exists, only null is acceptable.
        (await Promise.all(earlier)).forEach(({ result, settledAt, document }, index) => {
          if (result === null) return;
          if (settledAt >= supersededAt[index]!) supersededResolutionMisses++;
          else if (!isDeepStrictEqual(result, references[document])) supersededResolutionMisses++;
        });
        probeMisses += inThread.reading.probeMisses + worker.reading.probeMisses;

        const routing = await routingMisses(harnesses, null);
        // The warm-up and at least the final selection must have run there.
        const routingFloor = routing.executed < 2 ? 1 : 0;

        Object.assign(metrics, {
          inThreadFinalSelectionMs: inThreadFinalMs,
          workerFinalSelectionMs: workerFinalMs,
          inThreadLongestStallMs: inThread.reading.longestStallMs,
          workerLongestStallMs: worker.reading.longestStallMs,
          inThreadBlockedMs: inThread.reading.blockedMs,
          workerBlockedMs: worker.reading.blockedMs,
          inThreadExecutedJobs: SELECTIONS,
          // Less the warm-up, which is not part of the burst.
          workerExecutedJobs: routing.executed - 1,
          workerPosted: routing.posted - 1,
          workerRoutingMisses: routing.misses + routingFloor,
          sourceBytes: Math.min(...fixtures.map((fixture) => fixture.sourceBytes)),
        });
      } finally {
        watches.forEach((watch) => watch.stop());
        client.dispose();
        await Promise.all(harnesses.map((harness) => harness.close()));
      }

      return {
        durationMs: workerFinalMs,
        metrics: {
          ...metrics,
          finalSelectionMisses,
          supersededResolutionMisses,
          fixtureMisses: fixtureMissCount,
          probeMisses,
        },
      };
    },
  },
];
