import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRng } from "./workloads";
import type { FileTreeNode } from "../../../shared/types/ipc";
import type { StagingFileEntry, StagingStatus } from "../../../shared/types/git";

/**
 * Fixture for the panel scenarios (PERF-240..246): file browser, Review Hub and
 * the file viewer.
 *
 * What is REAL here, driven unmodified through its own entry points:
 *
 * - `FileTreeService.getFileTree` — the single directory-listing implementation
 *   behind every file-browser panel, against synthetic trees on a real
 *   filesystem. Every `readdir`, `lstat`, symlink probe and collator sort is
 *   the product's.
 * - `src/panels/file-browser/fileBrowserTree.ts` — `flattenTree`,
 *   `createVisibilityFilter`, `countHiddenRows`, `refreshTargets`,
 *   `pruneListings`, `sortFileNodes`. These are pure and have no DOM
 *   dependency, so the row-building half of the panel runs here exactly as it
 *   runs in the renderer.
 * - `DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN` — the shipped junk list, read from the
 *   preferences store rather than restated, so a change to the defaults moves
 *   the benchmark instead of silently diverging from it.
 * - `electron/utils/git.ts#getPerFileDiffStats` — the real batched
 *   `git diff --numstat` + parse + 5s cache behind every Review Hub churn
 *   column, driven through a real `createHardenedGit` client against a real
 *   dirty repository.
 * - `reviewHubUtils` (`sortFiles`, `matchesFilter`, `sumChurn`),
 *   `generatedFileClassifier.isGeneratedFile` and
 *   `reviewReadiness.deriveReviewReadiness` — the exact derivation
 *   `ReviewHubContent` runs on every status refresh.
 * - `codeMirrorLanguages.CODEMIRROR_LANGUAGES` plus CodeMirror's own
 *   `LanguageDescription.matchFilename`, `desc.load()` and the Lezer parse the
 *   file viewer's `CodeViewer` mounts an editor on.
 *
 * What is NOT real, stated precisely because each bounds what the numbers mean:
 *
 * - **There is no renderer and no paint.** Nothing here measures a frame. Every
 *   duration is the work a commit has to finish before React can render, never
 *   the time to pixels; every headline that could be a count is reported as one.
 * - **`ipcMain` does not exist**, so no IPC handler is driven. Two consequences:
 *   the file browser's listings are taken straight from `FileTreeService`
 *   rather than through `fileBrowser.ts`'s validation + project-scope guard,
 *   and `handleGetStagingStatus` — a closure inside `registerGitWriteHandlers`,
 *   reachable only through `ipcMain.handle` — cannot be called at all. The
 *   ~40-line `status.files` → `StagingFileEntry[]` mapping inside it is
 *   therefore reproduced by {@link mapStagingEntries} below and reported as its
 *   own `mappingMs` so its share is visible rather than folded into a real
 *   number. Both git calls it wraps, and every consumer downstream of it, are
 *   the product's. Driving the handler would also be defeated by its own
 *   20-per-10s rate limit, which a benchmark iterating more than twenty times
 *   would trip.
 * - **No IPC transport, no debounce, no scheduler.** The file browser fetches
 *   listings through a 6-deep concurrency queue with retry backoff, and the
 *   Review Hub defers its filter query through `useDeferredValue`. Those are
 *   pacing mechanisms in the renderer; the work they pace is what is measured.
 * - **The file viewer's parse is not first paint.** Production mounts a
 *   CodeMirror `EditorView`, which parses incrementally against the viewport
 *   under a time budget. `ensureSyntaxTree` here forces the same Lezer parse to
 *   completion, so the figure is the document's total parse cost — the ceiling
 *   search, goto-line and sticky-scope eventually pay — not the wait before the
 *   first screenful appears. `CodeViewer`'s `BASE_EXTENSIONS` are not applied
 *   (they pull `@codemirror/view` decorations that need a DOM); they add no
 *   parse work.
 * - **The main-process file read is out of frame.** `files.ts#handleRead`'s
 *   realpath containment, `O_NOFOLLOW` open, 8 KiB null-byte scan and LFS
 *   sniff are all inside the same unreachable handler closure. The fixture
 *   reads the file with `fs.readFile` and reports that separately.
 *
 * Fixture git calls use `execFileSync` (`spawnSync`), which does not route
 * through `ChildProcess.prototype.spawn`, so setup never pollutes a spawn
 * counter a sibling scenario installed.
 */

// --- Environment -------------------------------------------------------------
// `electron/utils/git.ts` pulls the logger, which resolves its file destination
// from DAINTREE_USER_DATA at module eval. Product modules are loaded lazily
// below so importing this fixture never triggers that.

let envReady = false;

function ensurePerfEnv(): void {
  if (envReady) return;
  if (!process.env.DAINTREE_USER_DATA) {
    const userData = mkdtempSync(join(tmpdir(), "daintree-perf-userdata-"));
    process.env.DAINTREE_USER_DATA = userData;
    // Exit-only: DAINTREE_USER_DATA is process-wide and other fixtures read it,
    // so it must outlive `disposePanelFixtures()`.
    removeOnExit(userData);
  }
  envReady = true;
}

const tempRoots: string[] = [];

/**
 * Registered before anything is written into the directory: a fixture that
 * throws half-way through building would otherwise leave tens of thousands of
 * files behind on the runner.
 */
function removeOnExit(path: string): void {
  process.on("exit", () => {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best-effort: a leaked temp dir must never fail a benchmark run.
    }
  });
}

/** Exit cleanup plus explicit disposal, for the roots this fixture owns. */
function registerCleanup(path: string): void {
  tempRoots.push(path);
  removeOnExit(path);
}

/**
 * Delete every directory this fixture built, now rather than at process exit.
 *
 * The `exit` handler above covers a benchmark run, which ends by exiting. It
 * does NOT cover a vitest worker, which is torn down by the pool without ever
 * emitting `exit` — so a test that drives these scenarios leaks the whole
 * ~70 MB of synthetic trees and repositories on every `npm test` unless it
 * calls this. Memoized fixtures are cleared too, so a later caller rebuilds
 * rather than reading paths that are gone.
 */
export function disposePanelFixtures(): void {
  for (const path of tempRoots.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Best-effort.
    }
  }
  browserFixture = null;
  reviewFixture = null;
  viewerFixture = null;
}

function makeRoot(prefix: string): string {
  // realpath matters on macOS, where `mkdtemp` hands back `/var/...` while git
  // and `fs.realpath` report `/private/var/...`. `FileTreeService` compares the
  // canonical target against the canonical root, and `getPerFileDiffStats`
  // re-keys numstat output by stripping the realpath'd toplevel prefix — both
  // silently produce nothing when the two spellings disagree.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  registerCleanup(root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "perf",
      GIT_AUTHOR_EMAIL: "perf@example.invalid",
      GIT_COMMITTER_NAME: "perf",
      GIT_COMMITTER_EMAIL: "perf@example.invalid",
    },
  });
}

// --- File browser tree fixture ----------------------------------------------

/**
 * What one directory was built to contain, bucketed by how a correct panel must
 * treat each name.
 *
 * The buckets are assigned when the file is written, from the generator's own
 * intent — no pattern is matched to produce them. That is what makes the
 * expectations below an INDEPENDENT oracle: if the shipped junk list and the
 * product's glob matcher both broke in the same direction, a manifest derived
 * from them would agree with the broken output, and this one would not.
 */
export interface DirManifest {
  /** Plain files. Visible under every visibility setting. */
  ordinaryFiles: string[];
  /** Plain subdirectories. Visible, and descendable when expanded. */
  ordinaryDirs: string[];
  /** Dot-prefixed, matching NO shipped junk pattern — the dotfile toggle's set. */
  dotfiles: string[];
  /** Written specifically to match a shipped junk pattern. Never a visible row. */
  junk: string[];
}

/** Directory path (repo-relative, "" = root) to what was written there. */
export type TreeManifest = ReadonlyMap<string, DirManifest>;

export interface BrowseTree {
  path: string;
  manifest: TreeManifest;
  /** Every ordinary directory, path-sorted — the pool expansions are drawn from. */
  directories: string[];
  /** The deepest chain of ordinary directories, root-first. */
  spine: string[];
  entryCount: number;
}

const DIR_WORDS = [
  "components",
  "services",
  "hooks",
  "store",
  "panels",
  "handlers",
  "config",
  "utils",
  "widgets",
  "adapters",
] as const;

const FILE_WORDS = [
  "Terminal",
  "Worktree",
  "Panel",
  "Agent",
  "Project",
  "Session",
  "Recipe",
  "Forge",
  "Theme",
  "Plugin",
] as const;

const FILE_SUFFIXES = ["Service", "Controller", "Store", "View", "Row", "Bar"] as const;
const FILE_EXTENSIONS = [".ts", ".tsx", ".css", ".md", ".json"] as const;

/** Dot-prefixed names deliberately chosen to match none of the shipped globs. */
const DOTFILE_NAMES = [".env", ".gitignore", ".editorconfig", ".npmrc", ".nvmrc"] as const;

/** Names written to match the shipped junk list, one per pattern family. */
const JUNK_NAMES = [".DS_Store", "Thumbs.db", "desktop.ini", "._cache"] as const;

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

interface TreeSpec {
  /** Subdirectory count at each level; length is the tree's depth. */
  branching: readonly number[];
  filesPerDir: number;
  seed: number;
}

function buildTree(root: string, name: string, spec: TreeSpec): BrowseTree {
  const treePath = join(root, name);
  mkdirSync(treePath, { recursive: true });

  const rng = createRng(spec.seed);
  const manifest = new Map<string, DirManifest>();
  const directories: string[] = [];
  let entryCount = 0;
  let dirIndex = 0;

  const build = (relative: string, depth: number): void => {
    const absolute = relative === "" ? treePath : join(treePath, relative);
    const entry: DirManifest = { ordinaryFiles: [], ordinaryDirs: [], dotfiles: [], junk: [] };
    const used = new Set<string>();
    const here = (child: string) => (relative === "" ? child : `${relative}/${child}`);

    for (let i = 0; i < spec.filesPerDir; i += 1) {
      const fileName = `${pick(rng, FILE_WORDS)}${pick(rng, FILE_SUFFIXES)}${i}${pick(rng, FILE_EXTENSIONS)}`;
      if (used.has(fileName)) continue;
      used.add(fileName);
      writeFileSync(join(absolute, fileName), "//\n");
      entry.ordinaryFiles.push(fileName);
    }

    // Spread hidden entries across the tree rather than into every directory:
    // a filter that costs the same everywhere would hide how much of the walk
    // is spent on rows that never render.
    if (dirIndex % 2 === 0) {
      const dotfile = DOTFILE_NAMES[dirIndex % DOTFILE_NAMES.length]!;
      writeFileSync(join(absolute, dotfile), "\n");
      entry.dotfiles.push(dotfile);
    }
    if (dirIndex % 3 === 0) {
      const junkName = JUNK_NAMES[dirIndex % JUNK_NAMES.length]!;
      writeFileSync(join(absolute, junkName), "\n");
      entry.junk.push(junkName);
    }
    if (relative === "") {
      // `.git` is a shipped junk default rather than a structural exclusion,
      // so the browser has to filter it like any other name.
      mkdirSync(join(absolute, ".git"), { recursive: true });
      writeFileSync(join(absolute, ".git", "HEAD"), "ref: refs/heads/main\n");
      entry.junk.push(".git");
    }

    dirIndex += 1;

    const branch = spec.branching[depth] ?? 0;
    for (let i = 0; i < branch; i += 1) {
      const dirName = `${pick(rng, DIR_WORDS)}-${depth}-${i}`;
      if (used.has(dirName)) continue;
      used.add(dirName);
      mkdirSync(join(absolute, dirName), { recursive: true });
      entry.ordinaryDirs.push(dirName);
      directories.push(here(dirName));
    }

    entryCount +=
      entry.ordinaryFiles.length +
      entry.ordinaryDirs.length +
      entry.dotfiles.length +
      entry.junk.length;
    manifest.set(relative, entry);

    for (const dirName of entry.ordinaryDirs) {
      build(here(dirName), depth + 1);
    }
  };

  build("", 0);
  directories.sort();

  // First-child chain to the bottom: the deep subtree PERF-243 walks.
  const spine: string[] = [];
  let cursor = "";
  for (;;) {
    const first = manifest.get(cursor)?.ordinaryDirs[0];
    if (!first) break;
    cursor = cursor === "" ? first : `${cursor}/${first}`;
    spine.push(cursor);
  }

  return { path: treePath, manifest, directories, spine, entryCount };
}

export interface FileBrowserFixture {
  root: string;
  /** Single-app repo shape: ~4,500 entries over 376 directories, depth 6. */
  representative: BrowseTree;
  /** Monorepo shape: ~11,500 entries over 445 wider directories. */
  large: BrowseTree;
  /** Small, fully-expandable tree the refresh scenario is free to mutate. */
  mutable: BrowseTree;
}

let browserFixture: FileBrowserFixture | null = null;

export function getFileBrowserFixture(): FileBrowserFixture {
  if (browserFixture) return browserFixture;
  const root = makeRoot("daintree-perf-panels-browse-");
  browserFixture = {
    root,
    representative: buildTree(root, "app-tree", {
      branching: [4, 3, 2, 2, 2, 2],
      filesPerDir: 10,
      seed: 240,
    }),
    large: buildTree(root, "large-tree", {
      branching: [5, 4, 3, 2, 2],
      filesPerDir: 24,
      seed: 241,
    }),
    mutable: buildTree(root, "mutable-tree", {
      branching: [3, 3, 2, 2],
      filesPerDir: 6,
      seed: 242,
    }),
  };
  return browserFixture;
}

/**
 * A deterministic expansion of `count` directories spread evenly over the whole
 * tree, so the selection is not biased toward the shallow end. Ancestors are
 * pulled in because a directory whose parent is collapsed contributes no rows —
 * `flattenTree` never reaches it — and an expectation that counted it would be
 * comparing against rows the panel is correct not to have produced.
 */
export function pickExpansion(tree: BrowseTree, count: number): Set<string> {
  const expanded = new Set<string>();
  const stride = Math.max(1, Math.floor(tree.directories.length / Math.max(1, count)));
  for (let i = 0; i < tree.directories.length && expanded.size < count; i += stride) {
    const dir = tree.directories[i]!;
    const segments = dir.split("/");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      expanded.add(segments.slice(0, depth).join("/"));
    }
  }
  return expanded;
}

/**
 * Every row a correct tree must render for this expansion, derived from what
 * the generator wrote rather than from what the product returned.
 *
 * A tree that produced nothing scores the whole set as missing; a filter that
 * quietly dropped ignored files along with the junk scores every dropped path.
 * Both directions are counted, because over-producing (junk leaking into the
 * rows) is the failure the other half of the filter has to be held to.
 */
export function expectedVisiblePaths(
  tree: BrowseTree,
  expanded: ReadonlySet<string>,
  hideDotfiles: boolean
): Set<string> {
  const paths = new Set<string>();
  const walk = (dir: string): void => {
    const entry = tree.manifest.get(dir);
    if (!entry) return;
    const here = (name: string) => (dir === "" ? name : `${dir}/${name}`);
    for (const name of entry.ordinaryFiles) paths.add(here(name));
    if (!hideDotfiles) for (const name of entry.dotfiles) paths.add(here(name));
    for (const name of entry.ordinaryDirs) {
      const child = here(name);
      paths.add(child);
      if (expanded.has(child)) walk(child);
    }
  };
  walk("");
  return paths;
}

/**
 * Same collation the service and the panel both sort by — natural-numeric with
 * a codepoint tie-break — constructed here rather than imported so the expected
 * order is not the product's own comparator grading its own output.
 */
const EXPECTED_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true });

function compareExpectedNames(a: string, b: string): number {
  const collated = EXPECTED_NAME_COLLATOR.compare(a, b);
  if (collated !== 0) return collated;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Every row a correct tree must render, IN THE ORDER it must render them.
 *
 * A set comparison cannot see ordering, and ordering is the whole of what a
 * sort does: an identity `sortFileNodes` produces exactly the same set of rows
 * as a working one, so membership alone scores a no-op sort as healthy. Folders
 * lead at every level (the grouping is structural and survives both
 * directions), each group is name-ordered, and an expanded directory's subtree
 * follows its own row — the depth-first walk `flattenTree` performs.
 *
 * Only the `name` key is modelled, in both directions. That is the key the
 * panel opens on and the only one whose expectation is derivable from the
 * generator alone: `size` and `modified` would have to be read back off disk,
 * which is the product's input rather than an independent oracle.
 */
export function expectedVisibleRowOrder(
  tree: BrowseTree,
  expanded: ReadonlySet<string>,
  hideDotfiles: boolean,
  direction: "asc" | "desc" = "asc"
): string[] {
  const flip = direction === "desc" ? -1 : 1;
  const order = (names: readonly string[]): string[] =>
    [...names].sort((a, b) => compareExpectedNames(a, b) * flip);

  const rows: string[] = [];
  const walk = (dir: string): void => {
    const entry = tree.manifest.get(dir);
    if (!entry) return;
    const here = (name: string) => (dir === "" ? name : `${dir}/${name}`);
    for (const name of order(entry.ordinaryDirs)) {
      const child = here(name);
      rows.push(child);
      if (expanded.has(child)) walk(child);
    }
    const files = hideDotfiles ? entry.ordinaryFiles : [...entry.ordinaryFiles, ...entry.dotfiles];
    for (const name of order(files)) rows.push(here(name));
  };
  walk("");
  return rows;
}

/**
 * Positions at which two row sequences disagree, plus the length difference.
 *
 * Deliberately positional rather than a set diff: reordered rows are the same
 * rows, and the failure being caught here is one where every path is present
 * and the order is wrong.
 */
export function sequenceMismatchCount(
  expected: readonly string[],
  actual: readonly string[]
): number {
  let misses = Math.abs(expected.length - actual.length);
  const shared = Math.min(expected.length, actual.length);
  for (let i = 0; i < shared; i += 1) {
    if (expected[i] !== actual[i]) misses += 1;
  }
  return misses;
}

/**
 * The hidden-row tallies a correct `countHiddenRows` must report. Junk wins over
 * the dotfile toggle for a name that is both, matching the product's rule that
 * a row the toggle cannot recover must not be offered as recoverable.
 */
export function expectedHiddenCounts(
  tree: BrowseTree,
  expanded: ReadonlySet<string>,
  hideDotfiles: boolean
): { dotfiles: number; alwaysHidden: number } {
  let dotfiles = 0;
  let alwaysHidden = 0;
  const walk = (dir: string): void => {
    const entry = tree.manifest.get(dir);
    if (!entry) return;
    alwaysHidden += entry.junk.length;
    if (hideDotfiles) dotfiles += entry.dotfiles.length;
    for (const name of entry.ordinaryDirs) {
      const child = dir === "" ? name : `${dir}/${name}`;
      if (expanded.has(child)) walk(child);
    }
  };
  walk("");
  return { dotfiles, alwaysHidden };
}

/** Size of the symmetric difference between two path sets. */
export function setDifferenceCount(
  expected: ReadonlySet<string>,
  actual: ReadonlySet<string>
): number {
  let misses = 0;
  for (const path of expected) if (!actual.has(path)) misses += 1;
  for (const path of actual) if (!expected.has(path)) misses += 1;
  return misses;
}

// --- Product module loading --------------------------------------------------

export interface FileTreeModule {
  getFileTree: (basePath: string, dirPath?: string) => Promise<FileTreeNode[]>;
}

let fileTreePromise: Promise<FileTreeModule> | null = null;

export function loadFileTreeModule(): Promise<FileTreeModule> {
  if (!fileTreePromise) {
    ensurePerfEnv();
    fileTreePromise = import("../../../electron/services/FileTreeService").then((mod) => ({
      getFileTree: (basePath: string, dirPath?: string) =>
        mod.fileTreeService.getFileTree(basePath, dirPath),
    }));
  }
  return fileTreePromise;
}

export type BrowserTreeModule = typeof import("../../../src/panels/file-browser/fileBrowserTree");

let browserTreePromise: Promise<BrowserTreeModule> | null = null;

export function loadBrowserTreeModule(): Promise<BrowserTreeModule> {
  if (!browserTreePromise) {
    ensurePerfEnv();
    browserTreePromise = import("../../../src/panels/file-browser/fileBrowserTree");
  }
  return browserTreePromise;
}

let hiddenPatternsPromise: Promise<readonly string[]> | null = null;

/**
 * The shipped junk list, read from the preferences store rather than restated
 * here so an edit to the defaults moves the benchmark with it. The store is a
 * persisted zustand store: importing it constructs one and registers it, which
 * is inert in a plain Node process beyond a localStorage warning.
 */
export function loadAlwaysHiddenPatterns(): Promise<readonly string[]> {
  if (!hiddenPatternsPromise) {
    ensurePerfEnv();
    hiddenPatternsPromise = import("../../../src/store/preferencesStore").then(
      (mod) => mod.DEFAULT_FILE_BROWSER_ALWAYS_HIDDEN
    );
  }
  return hiddenPatternsPromise;
}

/**
 * Fetch the root plus every expanded directory through the real
 * `FileTreeService`, as a restored panel does when its snapshot replays.
 */
export async function listDirectories(
  basePath: string,
  directories: readonly string[]
): Promise<{ listings: Map<string, readonly FileTreeNode[]>; nodes: number }> {
  const { getFileTree } = await loadFileTreeModule();
  const listings = new Map<string, readonly FileTreeNode[]>();
  let nodes = 0;
  for (const dir of directories) {
    const listed = await getFileTree(basePath, dir);
    listings.set(dir, listed);
    nodes += listed.length;
  }
  return { listings, nodes };
}

/** Every row path a flatten produced, for comparison against the manifest. */
export function rowPathSet(rows: ReadonlyArray<{ path: string }>): Set<string> {
  return new Set(rows.map((row) => row.path));
}

/** The content every generated ordinary file is written with, so a touch reverts exactly. */
const ORDINARY_FILE_CONTENT = "//\n";

export interface TreeMutation {
  /** Added file that must appear as a row after a refresh. */
  visiblePath: string;
  /** Added file matching a shipped junk pattern — must never become a row. */
  junkPath: string;
  /** Existing file rewritten in place. */
  touchedPath: string;
  /** Bytes `touchedPath` holds before the edit, and after it. */
  touchedBytesBefore: number;
  touchedBytesAfter: number;
  writeVisible: () => void;
  writeJunk: () => void;
  writeTouch: () => void;
  revert: () => void;
}

/**
 * Prepare — but do not perform — the three writes a refresh has to survive: a
 * new visible file, a new file the junk list hides, and an in-place edit of an
 * existing one.
 *
 * Each write is a separate call because a sweep can only be said to have
 * observed a change that happened after the previous sweep. Performing all
 * three up front leaves any sweep but the first measuring a refresh over an
 * unchanged tree, which is a real number for a different question.
 *
 * The junk write is the interesting one. It is the shape of the staleness bug
 * this family exists to price — a change the tree's tick source can miss
 * entirely — and it is why the refresh scenario reports the hidden tally as
 * well as the rows: the listing does see the file (`FileTreeService` returns
 * every entry and leaves visibility to the caller), so a correct panel must
 * count it as hidden rather than not know about it.
 *
 * The in-place edit changes the file's byte length, so the listing a sweep
 * returns carries the evidence of whether it re-read the directory at all.
 *
 * `revert` restores the directory to exactly what the manifest describes, so an
 * iteration cannot leak state into the next one or into another scenario
 * sharing the tree.
 */
export function mutateTree(
  tree: BrowseTree,
  target: { visibleDir: string; junkDir: string; touchDir: string },
  token: string
): TreeMutation {
  const visibleName = `AddedService${token}.ts`;
  const junkName = `._added${token}`;
  const visiblePath =
    target.visibleDir === "" ? visibleName : `${target.visibleDir}/${visibleName}`;
  const junkPath = target.junkDir === "" ? junkName : `${target.junkDir}/${junkName}`;

  const touchName = tree.manifest.get(target.touchDir)?.ordinaryFiles[0];
  if (!touchName) throw new Error(`mutateTree: ${target.touchDir} holds no ordinary file to touch`);
  const touchedPath = target.touchDir === "" ? touchName : `${target.touchDir}/${touchName}`;
  const editedContent = `// edited ${token}\n`;

  return {
    visiblePath,
    junkPath,
    touchedPath,
    touchedBytesBefore: Buffer.byteLength(ORDINARY_FILE_CONTENT),
    touchedBytesAfter: Buffer.byteLength(editedContent),
    writeVisible: () => writeFileSync(join(tree.path, visiblePath), ORDINARY_FILE_CONTENT),
    writeJunk: () => writeFileSync(join(tree.path, junkPath), "\n"),
    writeTouch: () => writeFileSync(join(tree.path, touchedPath), editedContent),
    revert: () => {
      rmSync(join(tree.path, visiblePath), { force: true });
      rmSync(join(tree.path, junkPath), { force: true });
      writeFileSync(join(tree.path, touchedPath), ORDINARY_FILE_CONTENT);
    },
  };
}

/** The listed byte size of one path, or null when the sweep never listed it. */
export function listedSizeOf(
  listings: ReadonlyMap<string, readonly FileTreeNode[]>,
  relativePath: string
): number | null {
  const slash = relativePath.lastIndexOf("/");
  const dir = slash === -1 ? "" : relativePath.slice(0, slash);
  for (const node of listings.get(dir) ?? []) {
    if (node.path === relativePath) return node.size ?? null;
  }
  return null;
}

// --- Review Hub fixture ------------------------------------------------------

export interface ReviewRepo {
  path: string;
  /** Tracked files modified and `git add`ed. */
  stagedPaths: string[];
  /** Tracked files modified and left in the working tree. */
  unstagedPaths: string[];
  /** New files never added to the index. */
  untrackedPaths: string[];
  /** Changed paths `isGeneratedFile` must classify as generated. */
  generatedPaths: string[];
  /** Glob typed into a section filter, and the paths it must select. */
  filterGlob: string;
  filterPrefix: string;
  changedLinesPerFile: number;
  /**
   * Churn the changeset was WRITTEN to contain, totalled over every tracked
   * change on both sides.
   *
   * Every touched file is rewritten under a different seed, so no line survives
   * and numstat's answer is fixed by the generator: the new length in, the
   * committed length out. Untracked files contribute nothing — they have no
   * numstat entry at all — which is the same set the scenario excludes from its
   * read.
   *
   * This is what makes `sumChurn` answerable: a version returning `{ins: 0,
   * del: 0}` produces a perfectly plausible churn chip, and nothing derived
   * from the product's own output can tell it apart from a quiet changeset.
   */
  expectedInsertions: number;
  expectedDeletions: number;
}

export interface ReviewFixture {
  root: string;
  /** A day's work: ~48 changed files. */
  representative: ReviewRepo;
  /** A long-running branch: ~400 changed files at higher churn. */
  large: ReviewRepo;
}

const REVIEW_AREAS = ["src/services", "src/components", "electron/handlers", "shared/config"];

function sourceLines(seed: number, count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(`export const value_${seed}_${i} = compute(${seed * 31 + i}, { retries: 3 });`);
  }
  return `${lines.join("\n")}\n`;
}

function buildReviewRepo(
  root: string,
  name: string,
  spec: { trackedFiles: number; staged: number; unstaged: number; untracked: number; churn: number }
): ReviewRepo {
  const repoPath = join(root, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  git(repoPath, ["config", "commit.gpgsign", "false"]);
  git(repoPath, ["config", "core.fsmonitor", "false"]);

  const tracked: string[] = [];
  for (let i = 0; i < spec.trackedFiles; i += 1) {
    const area = REVIEW_AREAS[i % REVIEW_AREAS.length]!;
    const relative = `${area}/module${i}.ts`;
    mkdirSync(join(repoPath, area), { recursive: true });
    writeFileSync(join(repoPath, relative), sourceLines(i, spec.churn * 2));
    tracked.push(relative);
  }
  // Generated files are part of every real changeset and are what the section's
  // generated tier and its "hide generated" toggle sort and filter on.
  const generatedTracked = ["package-lock.json", "dist/bundle.js", "src/api.generated.ts"];
  for (const relative of generatedTracked) {
    const slash = relative.lastIndexOf("/");
    if (slash > 0) mkdirSync(join(repoPath, relative.slice(0, slash)), { recursive: true });
    writeFileSync(join(repoPath, relative), sourceLines(9000, spec.churn));
  }
  git(repoPath, ["add", "-A"]);
  git(repoPath, ["commit", "-m", "baseline"]);

  const touch = (relative: string, salt: number): void => {
    writeFileSync(join(repoPath, relative), sourceLines(salt, spec.churn * 2));
  };

  const stagedPaths = tracked.slice(0, spec.staged);
  const unstagedPaths = tracked.slice(spec.staged, spec.staged + spec.unstaged);
  for (const [index, relative] of stagedPaths.entries()) touch(relative, 5000 + index);
  for (const relative of generatedTracked) touch(relative, 9100);
  git(repoPath, ["add", "--", ...stagedPaths, ...generatedTracked]);
  for (const [index, relative] of unstagedPaths.entries()) touch(relative, 6000 + index);

  const untrackedPaths: string[] = [];
  for (let i = 0; i < spec.untracked; i += 1) {
    const relative = `src/new/added${i}.ts`;
    mkdirSync(join(repoPath, "src/new"), { recursive: true });
    writeFileSync(join(repoPath, relative), sourceLines(7000 + i, spec.churn));
    untrackedPaths.push(relative);
  }

  // Ordinary tracked files are rewritten at the length they were committed at,
  // so every line is replaced one for one. The generated ones were committed at
  // half that length and rewritten at full length, which makes their insertions
  // and deletions deliberately unequal — a `sumChurn` that returned the same
  // number for both would otherwise satisfy a symmetric expectation.
  const rewrittenLines = (stagedPaths.length + unstagedPaths.length) * spec.churn * 2;

  return {
    path: repoPath,
    stagedPaths: [...stagedPaths, ...generatedTracked],
    unstagedPaths,
    untrackedPaths,
    generatedPaths: generatedTracked,
    filterGlob: "src/services/**",
    filterPrefix: "src/services/",
    changedLinesPerFile: spec.churn * 2,
    expectedInsertions: rewrittenLines + generatedTracked.length * spec.churn * 2,
    expectedDeletions: rewrittenLines + generatedTracked.length * spec.churn,
  };
}

/**
 * The order the Review Hub must list a section in under its default sort, from
 * the paths the generator wrote.
 *
 * Generated files are a tier of their own below everything else — the product's
 * rule, restated here rather than read back from `isGeneratedFile`, because the
 * fixture already knows which files it wrote as generated. Without an ordered
 * expectation an identity `sortFiles` is indistinguishable from a working one:
 * `git status` hands its files over in path order already, so only the tier
 * boundary moves.
 */
export function expectedReviewOrder(
  paths: readonly string[],
  generatedPaths: readonly string[]
): string[] {
  const generated = new Set(generatedPaths);
  const byPath = (a: string, b: string) => a.localeCompare(b);
  return [
    ...paths.filter((path) => !generated.has(path)).sort(byPath),
    ...paths.filter((path) => generated.has(path)).sort(byPath),
  ];
}

let reviewFixture: ReviewFixture | null = null;

export function getReviewFixture(): ReviewFixture {
  if (reviewFixture) return reviewFixture;
  const root = makeRoot("daintree-perf-panels-review-");
  reviewFixture = {
    root,
    representative: buildReviewRepo(root, "day-branch", {
      trackedFiles: 120,
      staged: 18,
      unstaged: 22,
      untracked: 5,
      churn: 30,
    }),
    large: buildReviewRepo(root, "long-branch", {
      trackedFiles: 600,
      staged: 190,
      unstaged: 210,
      untracked: 20,
      churn: 60,
    }),
  };
  return reviewFixture;
}

export interface ReviewModules {
  createHardenedGit: typeof import("../../../electron/utils/hardenedGit").createHardenedGit;
  getPerFileDiffStats: typeof import("../../../electron/utils/git").getPerFileDiffStats;
  clearStagingDiffStatCache: () => void;
  reviewHubUtils: typeof import("../../../src/components/Worktree/ReviewHub/reviewHubUtils");
  isGeneratedFile: typeof import("../../../src/components/Worktree/generatedFileClassifier").isGeneratedFile;
  deriveReviewReadiness: typeof import("../../../src/components/Worktree/ReviewHub/reviewReadiness").deriveReviewReadiness;
}

let reviewModulesPromise: Promise<ReviewModules> | null = null;

export function loadReviewModules(): Promise<ReviewModules> {
  if (!reviewModulesPromise) {
    ensurePerfEnv();
    reviewModulesPromise = (async () => {
      const [hardenedGit, gitUtils, hubUtils, classifier, readiness] = await Promise.all([
        import("../../../electron/utils/hardenedGit"),
        import("../../../electron/utils/git"),
        import("../../../src/components/Worktree/ReviewHub/reviewHubUtils"),
        import("../../../src/components/Worktree/generatedFileClassifier"),
        import("../../../src/components/Worktree/ReviewHub/reviewReadiness"),
      ]);
      return {
        createHardenedGit: hardenedGit.createHardenedGit,
        getPerFileDiffStats: gitUtils.getPerFileDiffStats,
        clearStagingDiffStatCache: gitUtils.__clearStagingDiffStatCacheForTesting,
        reviewHubUtils: hubUtils,
        isGeneratedFile: classifier.isGeneratedFile,
        deriveReviewReadiness: readiness.deriveReviewReadiness,
      };
    })();
  }
  return reviewModulesPromise;
}

/**
 * The `status.files` → staged/unstaged split from `handleGetStagingStatus`.
 *
 * Reproduced, not real — see the scope note at the top of this file. Kept
 * byte-for-byte equivalent to the handler's loop (index/working-dir letters,
 * the conflicted skip, the untracked override) so the entry list the Review Hub
 * derivation is measured against is the list the product would hand it, and
 * timed separately so its share is never mistaken for measured product cost.
 */
export function mapStagingEntries(status: {
  files: ReadonlyArray<{ path: string; index: string; working_dir: string }>;
  conflicted?: string[];
}): { staged: StagingFileEntry[]; unstaged: StagingFileEntry[] } {
  const mapStatus = (s: string): StagingFileEntry["status"] => {
    switch (s) {
      case "M":
        return "modified";
      case "A":
        return "added";
      case "D":
        return "deleted";
      case "R":
        return "renamed";
      case "C":
        return "copied";
      case "U":
        return "conflicted";
      case "?":
        return "untracked";
      case "!":
        return "ignored";
      default:
        return "modified";
    }
  };

  const staged: StagingFileEntry[] = [];
  const unstaged: StagingFileEntry[] = [];
  const conflictedSet = new Set(status.conflicted ?? []);

  for (const file of status.files) {
    if (conflictedSet.has(file.path)) continue;
    const indexStatus = file.index;
    const workingStatus = file.working_dir;
    if (indexStatus && indexStatus !== " " && indexStatus !== "?") {
      staged.push({
        path: file.path,
        status: mapStatus(indexStatus),
        insertions: null,
        deletions: null,
      });
    }
    if (workingStatus && workingStatus !== " ") {
      unstaged.push({
        path: file.path,
        status: workingStatus === "?" ? "untracked" : mapStatus(workingStatus),
        insertions: null,
        deletions: null,
      });
    }
  }
  return { staged, unstaged };
}

/**
 * A `StagingStatus` for the readiness derivation, carrying the entries the two
 * real git reads produced. Every field the derivation branches on is filled
 * from what the fixture repository actually is (clean index state, no upstream,
 * no remote), so the summary it returns is a reading of real state.
 */
export function stagingStatusFor(
  staged: StagingFileEntry[],
  unstaged: StagingFileEntry[],
  currentBranch: string | null
): StagingStatus {
  return {
    staged,
    unstaged,
    conflicted: [],
    conflictedFiles: [],
    isDetachedHead: false,
    currentBranch,
    hasRemote: false,
    pushDestination: null,
    pullSource: null,
    repoState: "CLEAN",
    rebaseStep: null,
    rebaseTotalSteps: null,
    rebaseSequence: null,
  };
}

// --- File viewer fixture -----------------------------------------------------

export interface ViewerFixture {
  root: string;
  /** A TypeScript source file just under the product's preview byte ceiling. */
  largeSource: { path: string; bytes: number; lines: number };
}

let viewerFixture: ViewerFixture | null = null;

/**
 * Sized from the real `FILE_PREVIEW_MAX_BYTES`, so the fixture stays the
 * largest file the viewer will ever be asked to open regardless of what the
 * ceiling is set to in production.
 */
export async function getViewerFixture(): Promise<ViewerFixture> {
  if (viewerFixture) return viewerFixture;
  const { FILE_PREVIEW_MAX_BYTES } = await import("../../../electron/utils/fileLimits");
  const root = makeRoot("daintree-perf-panels-viewer-");
  const budget = Math.floor(FILE_PREVIEW_MAX_BYTES * 0.92);

  const lines: string[] = [
    `import { compute, resolve } from "./runtime";`,
    `import type { Options, Result } from "./types";`,
    "",
  ];
  let bytes = lines.join("\n").length;
  let index = 0;
  while (bytes < budget) {
    const block = [
      `export interface Options${index} {`,
      `  readonly retries: number;`,
      `  readonly backoff: "expo" | "linear";`,
      `  readonly label?: string;`,
      `}`,
      ``,
      `export class Handler${index} implements Result {`,
      `  private readonly cache = new Map<string, number>();`,
      `  constructor(private readonly options: Options${index}) {}`,
      `  resolve(key: string): number {`,
      `    const hit = this.cache.get(key);`,
      `    if (hit !== undefined) return hit;`,
      `    const next = compute(${index}, { retries: this.options.retries });`,
      `    this.cache.set(key, next);`,
      `    return next;`,
      `  }`,
      `}`,
      ``,
      `export function select${index}<T extends Options>(input: T[]): T | undefined {`,
      `  return input.find((entry) => resolve(entry) === ${index});`,
      `}`,
      ``,
    ];
    for (const line of block) {
      lines.push(line);
      bytes += line.length + 1;
    }
    index += 1;
  }

  const source = lines.join("\n");
  const filePath = join(root, "src", "LargeModule.ts");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(filePath, source);

  viewerFixture = {
    root,
    largeSource: {
      path: filePath,
      bytes: Buffer.byteLength(source, "utf-8"),
      lines: lines.length,
    },
  };
  return viewerFixture;
}

export interface ViewerModules {
  CODEMIRROR_LANGUAGES: typeof import("../../../src/components/FileViewer/codeMirrorLanguages").CODEMIRROR_LANGUAGES;
  LanguageDescription: typeof import("@codemirror/language").LanguageDescription;
  ensureSyntaxTree: typeof import("@codemirror/language").ensureSyntaxTree;
  EditorState: typeof import("@codemirror/state").EditorState;
}

let viewerModulesPromise: Promise<ViewerModules> | null = null;

export function loadViewerModules(): Promise<ViewerModules> {
  if (!viewerModulesPromise) {
    ensurePerfEnv();
    viewerModulesPromise = (async () => {
      const [registry, language, state] = await Promise.all([
        import("../../../src/components/FileViewer/codeMirrorLanguages"),
        import("@codemirror/language"),
        import("@codemirror/state"),
      ]);
      return {
        CODEMIRROR_LANGUAGES: registry.CODEMIRROR_LANGUAGES,
        LanguageDescription: language.LanguageDescription,
        ensureSyntaxTree: language.ensureSyntaxTree,
        EditorState: state.EditorState,
      };
    })();
  }
  return viewerModulesPromise;
}
