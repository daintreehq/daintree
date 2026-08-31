import { performance } from "node:perf_hooks";

import type { PerfScenario, ScenarioSample } from "../types";
import type { CopyTreeOptions, CopyTreeResult } from "../../../shared/types/ipc/copyTree";
import {
  addBundleGrade,
  addProgressGrade,
  bundleDirectory,
  bundleMisses,
  bundlePath,
  COPY_TREE_SCALES,
  createWorkerFactoryProbe,
  discardBundle,
  emptyBundleGrade,
  emptyProgressGrade,
  gradeBundle,
  gradeInMemory,
  gradeProgress,
  getTree,
  loadCopyTreeModules,
  partialFilesLeftBehind,
  progressMisses,
  scopeSelection,
  type BundleExpectation,
  type BundleGrade,
  type CopyTreeModules,
  type CopyTreeTree,
  type ProgressGrade,
  type ProgressRecord,
} from "../lib/copyTreeFixture";

/**
 * CopyTree context generation — the multi-second wait behind the Copy Context
 * menu action and behind the `copyTree.generate` MCP tool.
 *
 * This is one of the few operations in Daintree where the user genuinely sits
 * and waits: on this repository the bundle is ~31 MB, the ceiling
 * (`MAX_OUTPUT_BYTES`) is 256 MB, and an external agent can drive it five times
 * per ten seconds through MCP. Nothing measured any part of it.
 *
 * Unlike most main-process families here, none of this needs Electron stubbed —
 * `copytree` is an ordinary npm dependency, the offload is `worker_threads`, and
 * there is no `electron` import anywhere on the path. `lib/copyTreeFixture.ts`
 * states what is real and what is not; the two limits to carry into every
 * reading are that the worker is loaded from TypeScript source through `tsx`
 * rather than from the compiled bundle, and that the workspace-host fork and its
 * structured clones (PERF-042..046) are not in the frame.
 *
 * Every scenario declares the same six bundle predicates, one per operation
 * `generate()` performs — the walk, the subject's own stat block, the per-file
 * read and format, the byte arithmetic and publish rename, the partial-file
 * cleanup, and the error path. The expensive middle is graded from the ARTIFACT,
 * not from the result object: file elements are counted in the XML on disk, and
 * a distinct sentinel token planted in every source file must reappear in the
 * bundle. A generator that walked the tree, counted correctly and emitted empty
 * file elements scores the full planted count on `sentinelContentMisses`, which
 * is exactly the "still doing most of its work" defect a stub experiment misses.
 */

const WARMUPS = 1;

/** Directories of the large tree a scoped run selects. 8 × 25 = 200 files. */
const SCOPE_DIRECTORY_COUNT = 8;

/** The scale the A/B and streaming scenarios hold constant. */
const AB_SCALE = "medium";

const BUNDLE_CORRECTNESS = [
  "generateErrorMisses",
  "bundleFileCountMisses",
  "reportedFileCountMisses",
  "sentinelContentMisses",
  "outputSizeMisses",
  "partialFileMisses",
] as const;

/**
 * Declared by the two scenarios that install a progress callback inside the
 * timed bracket. PERF-392 installs none — both of its arms pass `undefined` —
 * so it has no emission work to grade.
 */
const PROGRESS_CORRECTNESS = ["progressMonotonicityMisses", "progressTerminalMisses"] as const;

interface ArmResult {
  ms: number;
  bytes: number;
  files: number;
  progressEvents: number;
}

/** Record each event at the call site, as a structural copy. */
function progressRecorder(): {
  events: ProgressRecord[];
  onProgress: (progress: {
    stage: string;
    progress: number;
    message: string;
    traceId?: string;
  }) => void;
} {
  const events: ProgressRecord[] = [];
  return {
    events,
    onProgress: (progress) => {
      events.push({
        stage: progress.stage,
        progress: progress.progress,
        message: progress.message,
        traceId: progress.traceId,
      });
    },
  };
}

/**
 * Generate one file-backed bundle and grade it.
 *
 * The bundle is written OUTSIDE the tree it is generated from. Writing it
 * inside means the `.part` file — created before the walk starts — is found by
 * the walk, and the bundle carries one file more than was planted.
 */
async function generateToFile(
  modules: CopyTreeModules,
  tree: CopyTreeTree,
  expectation: BundleExpectation,
  label: string,
  options: CopyTreeOptions = {}
): Promise<{ arm: ArmResult; grade: BundleGrade; progress: ProgressGrade }> {
  const outputPath = bundlePath(label);
  const traceId = `perf-${label}`;
  const recorder = progressRecorder();
  const start = performance.now();
  const result: CopyTreeResult = await modules.copyTreeService.generate(
    tree.root,
    options,
    recorder.onProgress,
    traceId,
    outputPath
  );
  const ms = performance.now() - start;

  const grade = gradeBundle(expectation, result, outputPath);
  grade.partialFileMisses += partialFilesLeftBehind(bundleDirectory());
  const bytes = result.outputBytes ?? 0;
  discardBundle(outputPath);

  return {
    arm: { ms, bytes, files: result.fileCount, progressEvents: recorder.events.length },
    grade,
    progress: gradeProgress(traceId, recorder.events),
  };
}

function expectationFor(tree: CopyTreeTree): BundleExpectation {
  return { plantedFiles: tree.plantedFiles, sentinelTokens: tree.sentinelTokens };
}

export const copyTreeScenarios: PerfScenario[] = [
  {
    id: "PERF-390",
    name: "CopyTree Context Generation by Repo Scale",
    description:
      "Wall clock of the real CopyTreeService.generate() streaming a context bundle to a file, across synthetic trees of 120, 700 and 2200 files plus a scopePaths-narrowed run over 8 of the large tree's directories. This is the wait behind the Copy Context menu action and the copyTree.generate MCP tool, and it had no coverage. Graded from the artifact rather than the result object: file elements counted in the XML on disk must equal the planted count, a distinct sentinel token planted in every source file must reappear in the bundle, the reported outputBytes must equal the bytes actually on disk, and no .part file may survive. Progress delivery is graded rather than counted, because the callback is installed inside the bracket and deleting the emissions makes every arm faster with every bundle predicate untouched: the sequence must open at 0, never go backwards, land on 1, carry more than one value, and carry at least one SDK-sourced stage label.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...BUNDLE_CORRECTNESS, ...PROGRESS_CORRECTNESS],
    async run(): Promise<ScenarioSample> {
      const modules = await loadCopyTreeModules();
      const grade = emptyBundleGrade();
      const progress = emptyProgressGrade();
      const metrics: Record<string, number> = {};
      let totalMs = 0;

      for (const scale of COPY_TREE_SCALES) {
        const tree = getTree(scale.label);
        const {
          arm,
          grade: armGrade,
          progress: armProgress,
        } = await generateToFile(modules, tree, expectationFor(tree), scale.label);
        addBundleGrade(grade, armGrade);
        addProgressGrade(progress, armProgress);
        totalMs += arm.ms;
        metrics[`${scale.label}Ms`] = arm.ms;
        metrics[`${scale.label}Files`] = arm.files;
        metrics[`${scale.label}BundleBytes`] = arm.bytes;
        metrics[`${scale.label}ProgressEvents`] = arm.progressEvents;
      }

      // Scope narrowing: the same tree, a subset of its directories. The walk
      // still builds the ignore stack from the root down, so this is not simply
      // "generate a smaller tree" — it is what a folder-scoped Copy Context does.
      const large = getTree("large");
      const selection = scopeSelection(large, SCOPE_DIRECTORY_COUNT);
      const {
        arm: scoped,
        grade: scopedGrade,
        progress: scopedProgress,
      } = await generateToFile(
        modules,
        large,
        { plantedFiles: selection.plantedFiles, sentinelTokens: selection.sentinelTokens },
        "scoped",
        { scopePaths: selection.scopePaths }
      );
      addBundleGrade(grade, scopedGrade);
      addProgressGrade(progress, scopedProgress);
      totalMs += scoped.ms;
      metrics.scopedMs = scoped.ms;
      metrics.scopedFiles = scoped.files;

      const largeMs = metrics.largeMs ?? 0;
      const largeFiles = metrics.largeFiles ?? 0;
      metrics.largeMsPerKFile = largeFiles > 0 ? (largeMs * 1000) / largeFiles : 0;
      metrics.scopeNarrowingMs = largeMs - scoped.ms;

      return {
        durationMs: totalMs,
        metrics: {
          ...metrics,
          progressEventCount: progress.progressEventCount,
          ...bundleMisses(grade),
          ...progressMisses(progress),
        },
        notes: `scales ${COPY_TREE_SCALES.map((s) => s.files).join("/")} files, scoped ${selection.plantedFiles}`,
      };
    },
  },
  {
    id: "PERF-391",
    name: "CopyTree Worker Offload A/B",
    description:
      "The same 700-file generation driven through the real CopytreeWorkerClient three ways on one pass: in-thread with DAINTREE_DISABLE_COPYTREE_WORKER=1 (the shipped kill switch), then on a cold worker_threads worker, then on that worker once warm. Answers what the worker offload costs on its first request and what it saves afterwards. Routing is graded in BOTH directions from a creation counter incremented at the factory call site: the disabled arm must leave it at 0 and must report the client state as not-spawned, and the worker arm must take it to exactly 1 with a live threadId — so a client that ignored the kill switch and one that never reached its worker are separately caught. Progress delivery is graded on all three arms — including across the worker's message port, which is where a dropped `progress` message would otherwise be invisible.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...BUNDLE_CORRECTNESS, ...PROGRESS_CORRECTNESS, "workerRoutingMisses"],
    async run(): Promise<ScenarioSample> {
      const modules = await loadCopyTreeModules();
      const tree = getTree(AB_SCALE);
      const expectation = expectationFor(tree);
      const grade = emptyBundleGrade();
      const progress = emptyProgressGrade();
      let workerRoutingMisses = 0;

      const probe = createWorkerFactoryProbe();
      const previousDisable = process.env.DAINTREE_DISABLE_COPYTREE_WORKER;

      let inProcessMs = 0;
      let coldMs = 0;
      let warmMs = 0;
      let progressEvents = 0;
      let threadId = 0;
      let workerCreations = 0;

      try {
        // --- Arm 1: the shipped kill switch, in-thread. Runs FIRST, while the
        // creation counter is still provably 0.
        process.env.DAINTREE_DISABLE_COPYTREE_WORKER = "1";
        const disabledClient = new modules.CopytreeWorkerClient(probe.factory);
        const disabled = await runThroughClient(disabledClient, tree, expectation, "worker-off");
        addBundleGrade(grade, disabled.grade);
        addProgressGrade(progress, disabled.progress);
        inProcessMs = disabled.ms;
        progressEvents += disabled.progressEvents;
        if (probe.creations() !== 0) workerRoutingMisses += 1;
        if (disabledClient.getGovernanceSnapshot().state !== "not-spawned") {
          workerRoutingMisses += 1;
        }

        // --- Arm 2: cold worker. Spawn, module load inside the thread, the
        // worker's own first config load, then the generation.
        delete process.env.DAINTREE_DISABLE_COPYTREE_WORKER;
        const workerClient = new modules.CopytreeWorkerClient(probe.factory);
        const cold = await runThroughClient(workerClient, tree, expectation, "worker-cold");
        addBundleGrade(grade, cold.grade);
        addProgressGrade(progress, cold.progress);
        coldMs = cold.ms;
        progressEvents += cold.progressEvents;

        if (probe.creations() !== 1) workerRoutingMisses += 1;
        const snapshot = workerClient.getGovernanceSnapshot();
        if (snapshot.state !== "running" || snapshot.alive !== true) workerRoutingMisses += 1;
        if (snapshot.threadId === null || snapshot.threadId === 0) workerRoutingMisses += 1;
        threadId = snapshot.threadId ?? 0;

        // --- Arm 3: the same worker, warm.
        const warm = await runThroughClient(workerClient, tree, expectation, "worker-warm");
        addBundleGrade(grade, warm.grade);
        addProgressGrade(progress, warm.progress);
        warmMs = warm.ms;
        progressEvents += warm.progressEvents;
        if (probe.creations() !== 1) workerRoutingMisses += 1;
        workerCreations = probe.creations();
      } finally {
        if (previousDisable === undefined) {
          delete process.env.DAINTREE_DISABLE_COPYTREE_WORKER;
        } else {
          process.env.DAINTREE_DISABLE_COPYTREE_WORKER = previousDisable;
        }
        await probe.disposeAll();
      }

      return {
        durationMs: inProcessMs + coldMs + warmMs,
        metrics: {
          inProcessMs,
          workerColdMs: coldMs,
          workerWarmMs: warmMs,
          workerSpawnOverheadMs: coldMs - warmMs,
          workerWarmSpeedup: warmMs > 0 ? inProcessMs / warmMs : 0,
          workerCreations,
          workerThreadId: threadId,
          progressCallbacks: progressEvents,
          progressEventCount: progress.progressEventCount,
          workerRoutingMisses,
          ...bundleMisses(grade),
          ...progressMisses(progress),
        },
        notes: `${tree.plantedFiles} files per arm`,
      };
    },
  },
  {
    id: "PERF-392",
    name: "CopyTree Temp-File Streaming Throughput",
    description:
      "What #11528's file-backed path costs against the in-memory one it replaced, at 2200 files on one pass: the real copyStream → pipeline → .part → rename writer through a path handed out by the real reserveContextFilePath (which runs the real ensureContextDir and the real pruneContextDir sweep first), against the same generation through copy(), which assembles the whole document as one string. Then the real readContentPreview positional head read and the real fitContentToResultBudget binary search that shape what an MCP caller actually receives. Both generation arms are graded with the same artifact predicates, and the preview and budget stages carry their own.",
    tier: "heavy",
    modes: ["smoke", "ci", "nightly"],
    warmups: WARMUPS,
    correctness: [...BUNDLE_CORRECTNESS, "previewMisses", "budgetFitMisses", "reservedPathMisses"],
    async run(): Promise<ScenarioSample> {
      const modules = await loadCopyTreeModules();
      const tree = getTree("large");
      const expectation = expectationFor(tree);
      const grade = emptyBundleGrade();
      let reservedPathMisses = 0;
      let previewMisses = 0;
      let budgetFitMisses = 0;

      // --- The real reservation, including the prune sweep it runs first.
      const reserveStart = performance.now();
      const reservedPath = await modules.reserveContextFilePath({
        worktreePath: tree.root,
        branch: "perf-benchmark",
        extension: "xml",
      });
      const reserveMs = performance.now() - reserveStart;

      // The reservation must land inside the product's own context directory
      // and nowhere else — this path is what an MCP caller is handed, and it is
      // also what the prune sweep is allowed to delete.
      const contextDirectory = modules.contextDir();
      if (!reservedPath.startsWith(contextDirectory)) reservedPathMisses += 1;
      if (!reservedPath.endsWith(".xml")) reservedPathMisses += 1;

      // --- Arm 1: streamed to the reserved file.
      const streamStart = performance.now();
      const streamed: CopyTreeResult = await modules.copyTreeService.generate(
        tree.root,
        {},
        undefined,
        "perf-stream",
        reservedPath
      );
      const streamMs = performance.now() - streamStart;
      const streamGrade = gradeBundle(expectation, streamed, reservedPath);
      streamGrade.partialFileMisses += partialFilesLeftBehind(contextDirectory);
      addBundleGrade(grade, streamGrade);
      const bundleBytes = streamed.outputBytes ?? 0;

      // --- The MCP-facing read-back, on the file the arm above published.
      const previewStart = performance.now();
      const preview = await modules.readContentPreview(reservedPath);
      const previewMs = performance.now() - previewStart;
      if (!preview.content.startsWith("<?xml")) previewMisses += 1;
      if (preview.content.length === 0) previewMisses += 1;
      // A bundle this size cannot fit the 32 KiB head, so the truncation flag
      // must be set. The opposite direction is graded by the budget fit below,
      // which must still shrink a head that is already truncated.
      if (bundleBytes > 32 * 1024 && !preview.truncated) previewMisses += 1;

      const fitStart = performance.now();
      const fitted = modules.fitContentToResultBudget(
        preview.content,
        (content, truncated) => ({ filePath: reservedPath, content, contentTruncated: truncated }),
        preview.truncated
      );
      const fitMs = performance.now() - fitStart;
      const serializedBytes = Buffer.byteLength(JSON.stringify(fitted.result), "utf8");
      if (serializedBytes > 48 * 1024) budgetFitMisses += 1;
      if (fitted.content.length === 0) budgetFitMisses += 1;
      if (!fitted.truncated) budgetFitMisses += 1;

      modules.releaseContextFilePath(reservedPath);
      discardBundle(reservedPath);

      // --- Arm 2: the same generation held whole in memory.
      const memoryStart = performance.now();
      const inMemory: CopyTreeResult = await modules.copyTreeService.generate(
        tree.root,
        {},
        undefined,
        "perf-memory"
      );
      const memoryMs = performance.now() - memoryStart;
      addBundleGrade(grade, gradeInMemory(expectation, inMemory));
      const memoryChars = inMemory.content.length;

      return {
        durationMs: streamMs + memoryMs,
        metrics: {
          streamMs,
          inMemoryMs: memoryMs,
          reserveMs,
          previewMs,
          budgetFitMs: fitMs,
          bundleBytes,
          inMemoryChars: memoryChars,
          streamThroughputMbPerSec:
            streamMs > 0 ? bundleBytes / (1024 * 1024) / (streamMs / 1000) : 0,
          streamOverheadRatio: memoryMs > 0 ? streamMs / memoryMs : 0,
          serializedResultBytes: serializedBytes,
          previewMisses,
          budgetFitMisses,
          reservedPathMisses,
          ...bundleMisses(grade),
        },
        notes: `${tree.plantedFiles} files, ${bundleBytes} B bundle`,
      };
    },
  },
];

interface ClientArmResult {
  ms: number;
  progressEvents: number;
  grade: BundleGrade;
  progress: ProgressGrade;
}

type WorkerClient = InstanceType<CopyTreeModules["CopytreeWorkerClient"]>;

async function runThroughClient(
  client: WorkerClient,
  tree: CopyTreeTree,
  expectation: BundleExpectation,
  label: string
): Promise<ClientArmResult> {
  const outputPath = bundlePath(label);
  const traceId = `perf-${label}`;
  const recorder = progressRecorder();
  const start = performance.now();
  const result = await client.generate(tree.root, {}, recorder.onProgress, traceId, outputPath);
  const ms = performance.now() - start;
  const grade = gradeBundle(expectation, result, outputPath);
  grade.partialFileMisses += partialFilesLeftBehind(bundleDirectory());
  discardBundle(outputPath);
  return {
    ms,
    progressEvents: recorder.events.length,
    grade,
    progress: gradeProgress(traceId, recorder.events),
  };
}
