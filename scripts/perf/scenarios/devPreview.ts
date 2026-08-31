import type { PerfScenario } from "../types";
import {
  addMissCounts,
  buildAnsiBindStreamPlan,
  buildFailureStreamPlans,
  buildSingleBindStreamPlan,
  buildSplitBindStreamPlan,
  buildStartupStreamPlan,
  createDevPreviewSession,
  createSharedDevPreviewDeps,
  devPreviewPassMisses,
  disposeDevPreviewSession,
  emptyMissCounts,
  runDevPreviewOutputPass,
  runExitClassificationPass,
  runInterleavedDevPreviewPasses,
  DevPreviewPassDriver,
  EXIT_SPEC_TABLE,
  type DevPreviewStreamPlan,
} from "../lib/devPreviewOutputFixture";

/**
 * PERF-020..024 drive `processDevPreviewOutput` and `classifyDevPreviewExit` —
 * the real per-chunk handler behind `DevPreviewSessionService.handleData` and
 * the real exit classifier — with the real `UrlDetector`.
 *
 * Read `lib/devPreviewOutputFixture.ts` for what is and is not in frame. The
 * short version: the parse path is production's, `pollServerReadiness` is the
 * one dep replaced (it would otherwise open real sockets to arbitrary localhost
 * ports), and nothing here starts a dev server, so no number below includes
 * server startup.
 */

/**
 * Corpora are built once, lazily, and shared across iterations. They used to be
 * generated inside `run()`, where fixture construction is wall-clocked as if it
 * were detection latency.
 */
let cached: {
  startup: DevPreviewStreamPlan;
  concurrentA: DevPreviewStreamPlan;
  concurrentB: DevPreviewStreamPlan;
  switchDelivered: DevPreviewStreamPlan[];
  switchSuperseded: DevPreviewStreamPlan[];
  restart: DevPreviewStreamPlan[];
  failures: DevPreviewStreamPlan[];
} | null = null;

const SWITCH_SESSIONS = 14;
const RESTARTS = 30;

function plans(): NonNullable<typeof cached> {
  if (cached) return cached;

  const switchDelivered: DevPreviewStreamPlan[] = [];
  const switchSuperseded: DevPreviewStreamPlan[] = [];
  for (let i = 0; i < SWITCH_SESSIONS; i += 1) {
    // Deterministic split, not a seeded coin flip: an rng-chosen supersede set
    // makes the two halves of the oracle a different size on every iteration,
    // and a signed predicate over a moving denominator is unreadable.
    const superseded = i % 2 === 1;
    const plan = buildSplitBindStreamPlan({
      port: 4400 + i,
      noise: 20,
      deliverTail: !superseded,
      seed: 900 + i,
    });
    (superseded ? switchSuperseded : switchDelivered).push(plan);
  }

  const restart: DevPreviewStreamPlan[] = [];
  for (let i = 0; i < RESTARTS; i += 1) {
    // Each restart binds a different port and a different URL shape, so a
    // detector that answered from stale state — the previous restart's URL —
    // is a miss rather than a coincidence.
    const port = 5300 + i;
    switch (i % 4) {
      case 0:
        restart.push(
          buildStartupStreamPlan({ segments: 1, firstPort: port, noisePerSegment: 2, seed: i })
        );
        break;
      case 1:
        restart.push(
          buildSingleBindStreamPlan({ port, host: "127.0.0.1", noise: 2, seed: 100 + i })
        );
        break;
      case 2:
        restart.push(buildSingleBindStreamPlan({ port, host: "[::1]", noise: 2, seed: 200 + i }));
        break;
      default:
        restart.push(buildAnsiBindStreamPlan({ port, noise: 2, seed: 300 + i }));
    }
  }

  cached = {
    startup: buildStartupStreamPlan({
      segments: 4,
      firstPort: 5101,
      noisePerSegment: 8,
      seed: 20,
    }),
    concurrentA: buildStartupStreamPlan({
      segments: 3,
      firstPort: 5601,
      noisePerSegment: 8,
      seed: 21,
    }),
    concurrentB: buildSingleBindStreamPlan({
      port: 5701,
      host: "127.0.0.1",
      noise: 12,
      seed: 22,
    }),
    switchDelivered,
    switchSuperseded,
    restart,
    failures: buildFailureStreamPlans(24),
  };
  return cached;
}

export const devPreviewScenarios: PerfScenario[] = [
  {
    id: "PERF-020",
    name: "DevPreview Startup URL Detection",
    description:
      "Replay a dev-server startup log through the real per-chunk handler " +
      "(processDevPreviewOutput + UrlDetector): four port bindings, each " +
      "followed by a framework readiness line and an HMR compile burst, with " +
      "five near-miss decoys planted before every bind. Reports how many " +
      "chunks the product needed before it asked to poll a URL.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 10, ci: 20, nightly: 28 },
    warmups: 2,
    correctness: [
      "urlMisses",
      "decoyHits",
      "readyMarkerMisses",
      "compileArmMisses",
      "compileClearMisses",
      "diagnosticRingMisses",
    ],
    run() {
      const plan = plans().startup;
      const shared = createSharedDevPreviewDeps();
      const session = createDevPreviewSession("panel-020", "project-020");
      const result = runDevPreviewOutputPass(plan, session, shared);
      disposeDevPreviewSession(session);
      const misses = devPreviewPassMisses(plan, result, shared.rings);

      return {
        durationMs: -1,
        metrics: {
          chunkCount: result.chunksProcessed,
          chunksBeforeUrlCount: result.firstPolledFrameIndex,
          pollCount: result.polledUrls.length,
          diagnosticEvents: result.diagnosticEvents,
          decoyLineCount: plan.decoyFrames,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-021",
    name: "DevPreview Dual Concurrent Startup",
    description:
      "Two dev-preview sessions' output interleaved a chunk at a time through " +
      "the real handler, sharing one UrlDetector and one diagnostics ring map " +
      "the way the main process does. Each session is graded only against its " +
      "own planted binds, so a session that reported its neighbour's URL " +
      "scores decoyHits — the two streams bind different ports on different " +
      "loopback hosts precisely so cross-talk is visible.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 16, nightly: 24 },
    warmups: 1,
    correctness: [
      "urlMisses",
      "decoyHits",
      "readyMarkerMisses",
      "compileArmMisses",
      "compileClearMisses",
      "diagnosticRingMisses",
    ],
    run() {
      const { concurrentA, concurrentB } = plans();
      const shared = createSharedDevPreviewDeps();
      const sessionA = createDevPreviewSession("panel-021-a", "project-021");
      const sessionB = createDevPreviewSession("panel-021-b", "project-021");
      const [resultA, resultB] = runInterleavedDevPreviewPasses([
        new DevPreviewPassDriver(concurrentA, sessionA, shared, "terminal-021-a"),
        new DevPreviewPassDriver(concurrentB, sessionB, shared, "terminal-021-b"),
      ]);
      disposeDevPreviewSession(sessionA);
      disposeDevPreviewSession(sessionB);

      const misses = addMissCounts(
        devPreviewPassMisses(concurrentA, resultA!, shared.rings),
        devPreviewPassMisses(concurrentB, resultB!, shared.rings)
      );

      return {
        durationMs: -1,
        metrics: {
          chunkCount: resultA!.chunksProcessed + resultB!.chunksProcessed,
          pollCount: resultA!.polledUrls.length + resultB!.polledUrls.length,
          slowestChunksBeforeUrlCount: Math.max(
            resultA!.firstPolledFrameIndex,
            resultB!.firstPolledFrameIndex
          ),
          diagnosticEvents: resultA!.diagnosticEvents + resultB!.diagnosticEvents,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-022",
    name: "DevPreview Detection Across a Superseded Switch",
    description:
      "A worktree switch lands mid-line: the URL is split across two chunks " +
      "INSIDE the hostname, so neither half is a URL and the answer exists " +
      "only in scanOutput's rolling carry-over buffer. Half the sessions are " +
      "superseded before the tail arrives and must report nothing, half " +
      "receive it and must report the exact bind. Both halves are graded on " +
      "the same run, so a detector that matches http://loc eagerly and one " +
      "that lost the carry-over buffer are distinguishable.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 6, nightly: 10 },
    warmups: 1,
    correctness: ["urlMisses", "decoyHits", "readyMarkerMisses", "diagnosticRingMisses"],
    run() {
      const { switchDelivered, switchSuperseded } = plans();
      const shared = createSharedDevPreviewDeps();
      const misses = emptyMissCounts();
      let completedSessions = 0;
      let supersededSessions = 0;
      let chunksProcessed = 0;

      for (const plan of switchDelivered) {
        const session = createDevPreviewSession(`panel-022-d${completedSessions}`, "project-022");
        const result = runDevPreviewOutputPass(plan, session, shared);
        disposeDevPreviewSession(session);
        addMissCounts(misses, devPreviewPassMisses(plan, result, shared.rings));
        chunksProcessed += result.chunksProcessed;
        completedSessions += 1;
      }

      for (const plan of switchSuperseded) {
        const session = createDevPreviewSession(`panel-022-s${supersededSessions}`, "project-022");
        const result = runDevPreviewOutputPass(plan, session, shared);
        disposeDevPreviewSession(session);
        // `plan.expectedPolls` is empty for these, so every poll the product
        // made lands in `decoyHits`. That is the whole point of the half.
        addMissCounts(misses, devPreviewPassMisses(plan, result, shared.rings));
        chunksProcessed += result.chunksProcessed;
        supersededSessions += 1;
      }

      return {
        durationMs: -1,
        metrics: {
          completedSessionCount: completedSessions,
          supersededSessionCount: supersededSessions,
          chunkCount: chunksProcessed,
          diagnosticRingCount: shared.rings.size,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-023",
    name: "DevPreview Hard Restart Loop x30",
    description:
      "Thirty restarts, each a fresh session on a fresh port — the state " +
      "spawnSessionTerminal leaves behind — replayed through the real " +
      "handler. The bind rotates across the four forms production actually " +
      "prints: plain localhost, 127.0.0.1, [::1], and Vite's ANSI-split port " +
      "where the digits sit inside an SGR run and only the strip-and-rescan " +
      "pass can reach them.",
    tier: "heavy",
    modes: ["ci", "nightly"],
    iterations: { ci: 5, nightly: 8 },
    warmups: 1,
    correctness: [
      "urlMisses",
      "decoyHits",
      "readyMarkerMisses",
      "compileArmMisses",
      "compileClearMisses",
      "diagnosticRingMisses",
    ],
    run() {
      const restartPlans = plans().restart;
      const shared = createSharedDevPreviewDeps();
      const misses = emptyMissCounts();
      let restarts = 0;
      let chunksProcessed = 0;
      let maxChunksToUrl = 0;

      for (const plan of restartPlans) {
        const session = createDevPreviewSession(`panel-023-${restarts}`, "project-023");
        const result = runDevPreviewOutputPass(plan, session, shared);
        disposeDevPreviewSession(session);
        addMissCounts(misses, devPreviewPassMisses(plan, result, shared.rings));
        chunksProcessed += result.chunksProcessed;
        maxChunksToUrl = Math.max(maxChunksToUrl, result.firstPolledFrameIndex);
        restarts += 1;
      }

      return {
        durationMs: -1,
        metrics: {
          restarts,
          chunkCount: chunksProcessed,
          maxChunksBeforeUrlCount: maxChunksToUrl,
          diagnosticRingCount: shared.rings.size,
          ...misses,
        },
      };
    },
  },
  {
    id: "PERF-024",
    name: "DevPreview Stop and Exit Classification",
    description:
      "The teardown path: the real classifyDevPreviewExit over a 20-row spec " +
      "table in BOTH directions — seven rows must classify to null (clean " +
      "exit, SIGTERM/SIGINT/SIGHUP/SIGPIPE, and the SIGKILL case that falls " +
      "through to the exit-code tier), thirteen to a named type including the " +
      "SIGABRT-with-heap-OOM row an exit-code-only classifier gets wrong. " +
      "Paired with four output-classified failures driven through the real " +
      "per-chunk handler, each graded on the type AND the status it routes to.",
    tier: "fast",
    modes: ["smoke", "ci", "nightly"],
    iterations: { smoke: 8, ci: 16, nightly: 22 },
    warmups: 1,
    correctness: ["exitClassMisses", "errorClassMisses", "decoyHits", "diagnosticRingMisses"],
    run() {
      const failurePlans = plans().failures;
      const shared = createSharedDevPreviewDeps();
      const misses = emptyMissCounts();
      let faults = 0;
      let chunksProcessed = 0;

      for (const plan of failurePlans) {
        const session = createDevPreviewSession(`panel-024-${faults}`, "project-024");
        const result = runDevPreviewOutputPass(plan, session, shared);
        disposeDevPreviewSession(session);
        addMissCounts(misses, devPreviewPassMisses(plan, result, shared.rings));
        chunksProcessed += result.chunksProcessed;
        faults += 1;
      }

      const exit = runExitClassificationPass();

      return {
        durationMs: -1,
        metrics: {
          exitCaseCount: exit.classifications,
          cleanExitRowCount: exit.nullRowsGraded,
          faultExitRowCount: exit.errorRowsGraded,
          specTableRowCount: EXIT_SPEC_TABLE.length,
          outputFaultCount: faults,
          chunkCount: chunksProcessed,
          exitClassMisses: exit.exitClassMisses,
          errorClassMisses: misses.errorClassMisses,
          decoyHits: misses.decoyHits,
          diagnosticRingMisses: misses.diagnosticRingMisses,
        },
      };
    },
  },
];
