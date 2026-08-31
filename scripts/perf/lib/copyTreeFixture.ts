import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import type { CopyTreeResult } from "../../../shared/types/ipc/copyTree";
import { createPerfTempRoot } from "./tempRoots";

/**
 * The REAL CopyTree context-generation path for PERF-390..392, in a plain Node
 * process.
 *
 * `copyTree.generate` is one of the few genuinely multi-second waits a user
 * sits through with nothing else to do: it is a menu action, it is the
 * `copyTree.generate` MCP tool an external agent calls, and on this repository
 * the bundle it produces is ~31 MB. Nothing measured it. The whole path is
 * ordinary Node — `copytree` is a plain npm dependency, the offload is
 * `worker_threads`, and there is no `electron` import anywhere on it — so
 * unlike most of this harness's main-process families nothing here needs a
 * stub to run.
 *
 * WHAT IS REAL
 *   - `electron/services/CopyTreeService.ts` unmodified, driven through its
 *     shipped `generate()` entry point, including the real lazy `import(
 *     "copytree")`, the real `ConfigManager.create({ userConfig: false,
 *     strict: true })` defaults load, the real `buildSdkOptions` mapping, and
 *     both output modes: `copy()` (whole document as one string) and
 *     `copyStream()` → `pipeline()` → `.part` file → `rename()`.
 *   - `electron/services/copyTreeOutputFile.ts` unmodified: the real
 *     `reserveContextFilePath` (which runs the real `ensureContextDir` and the
 *     real `pruneContextDir` sweep before every reservation), the real
 *     `readContentPreview` positional-read head, and the real
 *     `fitContentToResultBudget` binary search.
 *   - `electron/workspace-host/CopytreeWorkerClient.ts` unmodified, including
 *     its real `DAINTREE_DISABLE_COPYTREE_WORKER` kill switch, its real
 *     generation fence, and the real `electron/workspace-host/copytreeWorker.ts`
 *     running on a real `worker_threads` Worker.
 *   - The real `copytree` SDK at the version this repo pins, walking a real
 *     directory tree of real files on a real filesystem.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **The worker is loaded from TypeScript source through `tsx`**, not from
 *     the `dist-electron/.../copytreeWorker.js` bundle production resolves via
 *     `resolveCopytreeWorkerPath()`. The thread, the port, the protocol and the
 *     service inside it are all real; the module-load half of the cold-start
 *     number includes `tsx`'s loader and pays for parsing TypeScript that
 *     production has already compiled away. Read PERF-391's cold worker figure
 *     as an upper bound on spawn cost, and its warm figure as the real one.
 *   - **The worker is re-`ref()`d by this fixture.** `CopytreeWorkerClient`
 *     calls `worker.unref()` so the worker can never keep the workspace-host
 *     alive on its own; in the host something else holds the process open, and
 *     in a bare benchmark process nothing does, so an unref'd worker lets Node
 *     exit with the measurement still in flight. The factory this fixture hands
 *     the client schedules a `ref()` for the turn after the client's `unref()`.
 *     Nothing on the measured path is touched by it.
 *   - **No workspace-host and no main process.** Production reaches this code
 *     through `WorkspaceClient` → the forked workspace-host → the worker, and
 *     hands the result back across two more structured-clone boundaries.
 *     PERF-042..046 price those boundaries; none of them is in these numbers.
 *     What travels back in production is a few hundred bytes of metadata
 *     (#11528), so the omission is small — but it is an omission.
 *   - **No renderer and no progress UI.** `onProgress` is throttled to 100 ms
 *     by `buildSdkOptions` and its callbacks are counted here, never rendered.
 *   - **The trees are synthetic.** They are uniform ASCII TypeScript-shaped
 *     files with no binaries, no `.gitignore`, no git repository and no
 *     symlinks, so the SDK's exclusion stages all run and all exclude nothing.
 *     That is deliberate: it makes the planted file count an exact oracle. It
 *     also means these numbers do not include the ignore-matching cost a real
 *     repository with a deep `.gitignore` pays.
 *
 * TEMP-DIR HYGIENE
 *   Everything this fixture creates lives under ONE `mkdtemp` root, and
 *   `process.env.TMPDIR` is repointed at that root during
 *   {@link ensureCopyTreeEnv} so that `copyTreeOutputFile`'s own
 *   `os.tmpdir()/daintree-context` directory — which it resolves per call, not
 *   at import — lands inside it too. The root is removed on process exit.
 */

// --- Environment -------------------------------------------------------------

let fixtureRoot: string | null = null;
let realTmpDir: string | null = null;

/**
 * Create the single temp root and repoint the environment at it.
 *
 * Must run before any product module is imported: `electron/utils/logger.ts`
 * resolves its log destination from `DAINTREE_USER_DATA` at module evaluation.
 */
function ensureCopyTreeEnv(): string {
  if (fixtureRoot !== null) return fixtureRoot;
  realTmpDir = tmpdir();
  const root = createPerfTempRoot("daintree-perf-copytree-", { parent: realTmpDir });
  fixtureRoot = root;

  const userData = join(root, "userdata");
  mkdirSync(userData, { recursive: true });
  process.env.DAINTREE_USER_DATA ??= userData;

  // Repointed AFTER the root itself was created under the real temp dir, so
  // the root is not nested inside a previous run's root. `contextDir()` reads
  // `os.tmpdir()` on every call, so this captures the product's own bundle
  // directory without touching the module.
  process.env.TMPDIR = root;

  return root;
}

/** The real `os.tmpdir()` as it was before this fixture repointed `TMPDIR`. */
export function realTempDir(): string {
  ensureCopyTreeEnv();
  return realTmpDir ?? tmpdir();
}

// --- Synthetic trees ---------------------------------------------------------

/**
 * Marker written into every planted file, one distinct token per file.
 *
 * A single sentinel proves one file's bytes reached the bundle. A token per
 * file proves EVERY file's bytes did, which is the term that covers the read
 * and format stages: a generator that walked the tree, counted correctly and
 * emitted empty `<ct:file>` elements scores the full planted count here.
 */
function sentinelToken(index: number): string {
  return `DTPERF-${index}-END`;
}

const SENTINEL_PATTERN = /DTPERF-(\d+)-END/g;

/** Files per directory. Wide enough that the walk crosses many directories. */
const FILES_PER_DIR = 25;

export interface CopyTreeScale {
  /** Stable label used in metric names and arm lookups. */
  label: string;
  files: number;
  /** Approximate bytes of body per file, before the sentinel line. */
  bytesPerFile: number;
}

/**
 * The scales PERF-390 sweeps.
 *
 * `large` is sized so one streamed generation lands in the low hundreds of
 * milliseconds on a developer machine — the same order as the wait a user
 * actually sits through on a mid-sized repository — without making a smoke run
 * take minutes.
 */
export const COPY_TREE_SCALES: readonly CopyTreeScale[] = [
  { label: "small", files: 120, bytesPerFile: 700 },
  { label: "medium", files: 700, bytesPerFile: 700 },
  { label: "large", files: 2200, bytesPerFile: 700 },
] as const;

export interface CopyTreeTree {
  label: string;
  root: string;
  /** Files this fixture wrote into the tree. The oracle's expected count. */
  plantedFiles: number;
  /** One token per planted file, in planting order. */
  sentinelTokens: ReadonlySet<string>;
  /** Directory names under the root, in creation order. */
  directories: readonly string[];
}

const trees = new Map<string, CopyTreeTree>();

function buildTree(scale: CopyTreeScale): CopyTreeTree {
  const root = ensureCopyTreeEnv();
  const treeRoot = join(root, `tree-${scale.label}`);
  const line = "export const padding = 1; // filler filler filler filler filler\n";
  const repeat = Math.max(1, Math.ceil(scale.bytesPerFile / line.length));
  const tokens = new Set<string>();
  const directories: string[] = [];

  for (let index = 0; index < scale.files; index += 1) {
    const dirName = `pkg${Math.floor(index / FILES_PER_DIR)}`;
    if (index % FILES_PER_DIR === 0) {
      mkdirSync(join(treeRoot, dirName), { recursive: true });
      directories.push(dirName);
    }
    const token = sentinelToken(index);
    tokens.add(token);
    writeFileSync(join(treeRoot, dirName, `mod${index}.ts`), `// ${token}\n${line.repeat(repeat)}`);
  }

  return {
    label: scale.label,
    root: treeRoot,
    plantedFiles: scale.files,
    sentinelTokens: tokens,
    directories,
  };
}

/** Build (once) and return the synthetic tree for a scale. */
export function getTree(label: string): CopyTreeTree {
  const existing = trees.get(label);
  if (existing !== undefined) return existing;
  const scale = COPY_TREE_SCALES.find((candidate) => candidate.label === label);
  if (scale === undefined) {
    throw new Error(`perf copytree fixture: unknown scale "${label}"`);
  }
  const tree = buildTree(scale);
  trees.set(label, tree);
  return tree;
}

/**
 * The subset of a tree a `scopePaths` run must produce.
 *
 * Derived from this fixture's own planting arithmetic — `FILES_PER_DIR` files
 * per directory, in index order — never by asking the subject what it found.
 */
export interface CopyTreeScopeSelection {
  scopePaths: string[];
  plantedFiles: number;
  sentinelTokens: ReadonlySet<string>;
}

export function scopeSelection(tree: CopyTreeTree, directoryCount: number): CopyTreeScopeSelection {
  const dirs = tree.directories.slice(0, directoryCount);
  const tokens = new Set<string>();
  let files = 0;
  for (let dirIndex = 0; dirIndex < dirs.length; dirIndex += 1) {
    for (let offset = 0; offset < FILES_PER_DIR; offset += 1) {
      const fileIndex = dirIndex * FILES_PER_DIR + offset;
      if (fileIndex >= tree.plantedFiles) break;
      tokens.add(sentinelToken(fileIndex));
      files += 1;
    }
  }
  return { scopePaths: [...dirs], plantedFiles: files, sentinelTokens: tokens };
}

// --- Product modules ---------------------------------------------------------

type CopyTreeServiceModule = typeof import("../../../electron/services/CopyTreeService");
type OutputFileModule = typeof import("../../../electron/services/copyTreeOutputFile");
type WorkerClientModule = typeof import("../../../electron/workspace-host/CopytreeWorkerClient");

export interface CopyTreeModules {
  copyTreeService: CopyTreeServiceModule["copyTreeService"];
  reserveContextFilePath: OutputFileModule["reserveContextFilePath"];
  releaseContextFilePath: OutputFileModule["releaseContextFilePath"];
  pruneContextDir: OutputFileModule["pruneContextDir"];
  readContentPreview: OutputFileModule["readContentPreview"];
  fitContentToResultBudget: OutputFileModule["fitContentToResultBudget"];
  contextDir: OutputFileModule["contextDir"];
  MAX_OUTPUT_BYTES: number;
  CopytreeWorkerClient: WorkerClientModule["CopytreeWorkerClient"];
}

let modulesPromise: Promise<CopyTreeModules> | null = null;

export function loadCopyTreeModules(): Promise<CopyTreeModules> {
  if (modulesPromise === null) {
    ensureCopyTreeEnv();
    modulesPromise = (async () => {
      const [service, outputFile, workerClient] = await Promise.all([
        import("../../../electron/services/CopyTreeService"),
        import("../../../electron/services/copyTreeOutputFile"),
        import("../../../electron/workspace-host/CopytreeWorkerClient"),
      ]);
      return {
        copyTreeService: service.copyTreeService,
        reserveContextFilePath: outputFile.reserveContextFilePath,
        releaseContextFilePath: outputFile.releaseContextFilePath,
        pruneContextDir: outputFile.pruneContextDir,
        readContentPreview: outputFile.readContentPreview,
        fitContentToResultBudget: outputFile.fitContentToResultBudget,
        contextDir: outputFile.contextDir,
        MAX_OUTPUT_BYTES: outputFile.MAX_OUTPUT_BYTES,
        CopytreeWorkerClient: workerClient.CopytreeWorkerClient,
      };
    })();
  }
  return modulesPromise;
}

// --- Worker plumbing ---------------------------------------------------------

const WORKER_SOURCE_URL = new URL(
  "../../../electron/workspace-host/copytreeWorker.ts",
  import.meta.url
);

export interface WorkerFactoryProbe {
  /** Hand this to `new CopytreeWorkerClient(factory)`. */
  factory: () => Worker;
  /**
   * Worker starts this factory actually made, incremented AT THE CALL SITE
   * rather than read back from the client's own snapshot.
   *
   * PERF-391 grades routing with it in both directions: the disabled arm runs
   * against a client whose probe must still read 0 afterwards, and the worker
   * arm's must read exactly 1. A client that quietly ignored
   * `DAINTREE_DISABLE_COPYTREE_WORKER` and spawned anyway fails the first half;
   * one that never reached its worker at all fails the second.
   */
  creations: () => number;
  /**
   * Terminate whatever this factory started.
   *
   * `CopytreeWorkerClient` deliberately never terminates its worker — Electron
   * 37+ crashes on repeated spawn/terminate cycles inside a `utilityProcess` —
   * so the worker outlives the client by design. In a benchmark process that
   * would leave one live thread per iteration, so the FIXTURE (which owns the
   * `Worker` object it constructed) tears its own down. Plain Node has none of
   * the Electron constraint that motivates the product's policy.
   */
  disposeAll: () => Promise<void>;
}

export function createWorkerFactoryProbe(): WorkerFactoryProbe {
  let creations = 0;
  const workers: Worker[] = [];
  return {
    factory: () => {
      creations += 1;
      const worker = new Worker(WORKER_SOURCE_URL);
      workers.push(worker);
      // The client `unref()`s the worker synchronously after this returns. Undo
      // it on the next turn so a bare benchmark process stays alive for the
      // reply it is waiting on.
      setImmediate(() => worker.ref());
      return worker;
    },
    creations: () => creations,
    disposeAll: async () => {
      // Terminating trips the client's own `exit` handler, which logs
      // "copytree worker down; falling back to in-process generation" through
      // the product logger — correct behaviour reacting to a teardown the
      // FIXTURE caused, not a finding. Silence the console leg for the two
      // turns it takes to arrive so it does not interleave with the run's own
      // output; the file leg is untouched.
      const warn = console.warn;
      const error = console.error;
      console.warn = () => undefined;
      console.error = () => undefined;
      try {
        await Promise.all(workers.map((worker) => worker.terminate()));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      } finally {
        console.warn = warn;
        console.error = error;
        workers.length = 0;
      }
    },
  };
}

// --- Output paths ------------------------------------------------------------

let outputSequence = 0;

/**
 * A destination for one generated bundle, OUTSIDE every synthetic tree.
 *
 * Writing the bundle inside the tree it is generated from is a trap this
 * fixture hit while being written: the `.part` file is created before the walk
 * starts, the walk finds it, and the bundle reports one more file than was
 * planted. The oracle catches that — which is the point — but the fixture must
 * not manufacture it.
 */
export function bundlePath(label: string): string {
  const root = ensureCopyTreeEnv();
  const dir = join(root, "bundles");
  mkdirSync(dir, { recursive: true });
  outputSequence += 1;
  return join(dir, `bundle-${label}-${outputSequence}.xml`);
}

/** Remove a bundle and any `.part` sibling once it has been graded. */
export function discardBundle(path: string): void {
  rmSync(path, { force: true });
}

// --- Grading -----------------------------------------------------------------

/**
 * One accumulator per operation `generate()` performs, so a lost stage cannot
 * hide behind an aggregate another stage still satisfies.
 *
 *   `generateErrorMisses`     — the call produced a result rather than an
 *                               error-shaped one. Everything else is
 *                               conditional on this, so it is graded first.
 *   `bundleFileCountMisses`   — file elements counted IN THE BUNDLE ON DISK
 *                               equal this fixture's planted count. Read out of
 *                               the artifact, not out of the subject's own
 *                               `stats`, so a walk that stopped early cannot
 *                               self-report a full count.
 *   `reportedFileCountMisses` — the subject's `fileCount` agrees with the same
 *                               planted count. Separate from the term above
 *                               because a bundle and a stat block that disagree
 *                               is a different defect from either being wrong.
 *   `sentinelContentMisses`   — the symmetric difference between the planted
 *                               per-file tokens and the tokens present in the
 *                               bundle. This is the term that covers the read
 *                               and format stages: emitting the right number of
 *                               empty file elements scores the full count.
 *   `outputSizeMisses`        — the reported `outputBytes` equals the actual
 *                               bytes on disk at the FINAL path, and the file
 *                               exists there. Covers the counted-chunk
 *                               arithmetic, the pipeline and the publish rename.
 *   `partialFileMisses`       — no `.part` file survived the run.
 *
 * An empty bundle fails the count, the sentinel and the size terms at once.
 */
export interface BundleGrade {
  generateErrorMisses: number;
  bundleFileCountMisses: number;
  reportedFileCountMisses: number;
  sentinelContentMisses: number;
  outputSizeMisses: number;
  partialFileMisses: number;
}

export function emptyBundleGrade(): BundleGrade {
  return {
    generateErrorMisses: 0,
    bundleFileCountMisses: 0,
    reportedFileCountMisses: 0,
    sentinelContentMisses: 0,
    outputSizeMisses: 0,
    partialFileMisses: 0,
  };
}

export function addBundleGrade(into: BundleGrade, from: BundleGrade): BundleGrade {
  into.generateErrorMisses += from.generateErrorMisses;
  into.bundleFileCountMisses += from.bundleFileCountMisses;
  into.reportedFileCountMisses += from.reportedFileCountMisses;
  into.sentinelContentMisses += from.sentinelContentMisses;
  into.outputSizeMisses += from.outputSizeMisses;
  into.partialFileMisses += from.partialFileMisses;
  return into;
}

export function bundleMisses(grade: BundleGrade): Record<string, number> {
  return {
    generateErrorMisses: grade.generateErrorMisses,
    bundleFileCountMisses: grade.bundleFileCountMisses,
    reportedFileCountMisses: grade.reportedFileCountMisses,
    sentinelContentMisses: grade.sentinelContentMisses,
    outputSizeMisses: grade.outputSizeMisses,
    partialFileMisses: grade.partialFileMisses,
  };
}

/** File elements in a copytree XML bundle, counted without an XML parser. */
export function countBundleFileEntries(document: string): number {
  let count = 0;
  let cursor = document.indexOf("<ct:file ");
  while (cursor !== -1) {
    count += 1;
    cursor = document.indexOf("<ct:file ", cursor + 1);
  }
  return count;
}

/** Every per-file sentinel token present in a bundle, in one pass. */
export function tokensInBundle(document: string): Set<string> {
  const found = new Set<string>();
  SENTINEL_PATTERN.lastIndex = 0;
  let match = SENTINEL_PATTERN.exec(document);
  while (match !== null) {
    found.add(match[0]);
    match = SENTINEL_PATTERN.exec(document);
  }
  return found;
}

/** Elements of `expected` absent from `actual`, plus elements of `actual` not expected. */
export function symmetricDifferenceSize(
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>
): number {
  let misses = 0;
  for (const token of expected) if (!actual.has(token)) misses += 1;
  for (const token of actual) if (!expected.has(token)) misses += 1;
  return misses;
}

export interface BundleExpectation {
  plantedFiles: number;
  sentinelTokens: ReadonlySet<string>;
}

/**
 * Grade one file-backed generation against the fixture's own arithmetic.
 *
 * Nothing here calls back into `CopyTreeService`. The expected file count and
 * the expected token set are what this fixture wrote to disk before the timed
 * bracket opened; the actual ones are read out of the artifact the bracket
 * produced.
 */
export function gradeBundle(
  expectation: BundleExpectation,
  result: CopyTreeResult,
  outputPath: string
): BundleGrade {
  const grade = emptyBundleGrade();

  if (result.error !== undefined || result.filePath !== outputPath) {
    grade.generateErrorMisses += 1;
    // Every remaining term is a claim about an artifact that was not produced.
    grade.bundleFileCountMisses += expectation.plantedFiles;
    grade.reportedFileCountMisses += expectation.plantedFiles;
    grade.sentinelContentMisses += expectation.sentinelTokens.size;
    grade.outputSizeMisses += 1;
    return grade;
  }

  if (result.fileCount !== expectation.plantedFiles) {
    grade.reportedFileCountMisses += Math.abs(result.fileCount - expectation.plantedFiles);
  }

  let onDiskBytes = -1;
  try {
    onDiskBytes = statSync(outputPath).size;
  } catch {
    onDiskBytes = -1;
  }
  if (onDiskBytes < 0 || result.outputBytes !== onDiskBytes) {
    grade.outputSizeMisses += 1;
  }
  // A zero-byte artifact is self-consistent — it reports zero and zero is what
  // is on disk — so the equality above passes it. Any tree this fixture plants
  // has files in it, so an empty bundle is a failure of the write half and must
  // score here as well as on the count and sentinel terms.
  if (expectation.plantedFiles > 0 && onDiskBytes === 0) {
    grade.outputSizeMisses += 1;
  }

  let document = "";
  try {
    document = readFileSync(outputPath, "utf8");
  } catch {
    document = "";
  }

  const entries = countBundleFileEntries(document);
  if (entries !== expectation.plantedFiles) {
    grade.bundleFileCountMisses += Math.abs(entries - expectation.plantedFiles);
  }
  grade.sentinelContentMisses += symmetricDifferenceSize(
    expectation.sentinelTokens,
    tokensInBundle(document)
  );

  return grade;
}

/**
 * Grade the in-memory arm, which returns the document as a string and writes
 * nothing. The size and partial terms have no subject here, so they are left at
 * zero rather than being scored against an artifact that was never asked for.
 */
export function gradeInMemory(expectation: BundleExpectation, result: CopyTreeResult): BundleGrade {
  const grade = emptyBundleGrade();
  if (result.error !== undefined) {
    grade.generateErrorMisses += 1;
    grade.bundleFileCountMisses += expectation.plantedFiles;
    grade.reportedFileCountMisses += expectation.plantedFiles;
    grade.sentinelContentMisses += expectation.sentinelTokens.size;
    return grade;
  }
  if (result.fileCount !== expectation.plantedFiles) {
    grade.reportedFileCountMisses += Math.abs(result.fileCount - expectation.plantedFiles);
  }
  const entries = countBundleFileEntries(result.content);
  if (entries !== expectation.plantedFiles) {
    grade.bundleFileCountMisses += Math.abs(entries - expectation.plantedFiles);
  }
  grade.sentinelContentMisses += symmetricDifferenceSize(
    expectation.sentinelTokens,
    tokensInBundle(result.content)
  );
  return grade;
}

/** Directory bundles are written into, for the partial-file sweep. */
export function bundleDirectory(): string {
  const dir = join(ensureCopyTreeEnv(), "bundles");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * `.part` files still sitting in the bundle directory.
 *
 * `streamToFile` publishes by renaming `<path>.<uuid>.part` onto the final path
 * and unlinks the partial on every failure branch, so one left behind means the
 * publish half did not complete. Counted off the filesystem after each arm
 * rather than inferred from the result the subject returned.
 */
export function partialFilesLeftBehind(directory: string = bundleDirectory()): number {
  try {
    return readdirSync(directory).filter((name) => name.endsWith(".part")).length;
  } catch {
    return 0;
  }
}
