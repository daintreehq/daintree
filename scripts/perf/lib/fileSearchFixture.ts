import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createPerfTempRoot } from "./tempRoots";
import { createRng } from "./workloads";

/**
 * Fixture for the file-picker scenarios (PERF-190..192).
 *
 * Drives the real `FileSearchService` (electron/services/FileSearchService.ts)
 * — the single implementation behind the `@`-mention picker and the file
 * palette — against synthetic git repos. Nothing is mocked: the service shells
 * out to `git ls-files` exactly as it does in the app, so the cold path
 * measures real subprocess + parse cost and the warm path measures the real
 * per-keystroke scan over the cached path list.
 *
 * Fixture git calls use execFileSync (spawnSync), which does not route through
 * ChildProcess.prototype.spawn, so setup never pollutes any spawn counters a
 * sibling scenario installs.
 */

/**
 * A tracked file the fallback filesystem walker can never return: `dist` is in
 * FileSearchService's FALLBACK_SKIP_NAMES, so only `git ls-files` surfaces it.
 * Searching for it proves which listing path actually ran — without it, a
 * totally broken `git ls-files` degrades silently to the walker and the
 * benchmark reports walker time while claiming to measure git.
 */
export const GIT_ONLY_SENTINEL = "dist/git-listing-sentinel.ts";

/** Representative single-app repo — Daintree itself sits at ~3,100 files. */
export const REPRESENTATIVE_FILE_COUNT = 3200;

/** Large monorepo, still under the service's 20k fallback cap. */
export const MONOREPO_FILE_COUNT = 12000;

const TOP_LEVEL = [
  "src",
  "electron",
  "shared",
  "packages",
  "plugins",
  "scripts",
  "docs",
  "e2e",
] as const;

const MID_LEVEL = [
  "components",
  "services",
  "hooks",
  "store",
  "lib",
  "utils",
  "handlers",
  "panels",
  "config",
  "types",
] as const;

const LEAF_WORDS = [
  "Terminal",
  "Worktree",
  "Panel",
  "Agent",
  "Project",
  "Session",
  "Search",
  "Recipe",
  "Forge",
  "Theme",
  "Plugin",
  "Notification",
  "Palette",
  "Diff",
  "Browser",
  "Layout",
  "Window",
  "Pty",
] as const;

const SUFFIXES = [
  "Service",
  "Controller",
  "Manager",
  "Store",
  "View",
  "Bar",
  "Dialog",
  "Registry",
  "Client",
  "Handler",
] as const;

const EXTENSIONS = [".ts", ".tsx", ".test.ts", ".css", ".md", ".json"] as const;

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

/**
 * Deterministic, realistically-shaped repo paths: three-to-four segments deep,
 * CamelCase leaf names with the extension mix of a TypeScript app. Shape
 * matters — the service scores basename-prefix, path-prefix and substring hits
 * separately, so a flat directory of `file-N.txt` would exercise one branch of
 * `scorePath` and flatter it.
 */
function buildRelativePaths(count: number, seed: number): string[] {
  const rng = createRng(seed);
  const paths = new Set<string>();
  let guard = 0;

  while (paths.size < count && guard < count * 12) {
    guard += 1;
    const top = pick(rng, TOP_LEVEL);
    const mid = pick(rng, MID_LEVEL);
    const leaf = `${pick(rng, LEAF_WORDS)}${pick(rng, SUFFIXES)}`;
    const ext = pick(rng, EXTENSIONS);
    // ~40% get a fourth segment, so the tree has both shallow and deep files.
    const deep = rng() < 0.4 ? `/${pick(rng, LEAF_WORDS).toLowerCase()}` : "";
    // A numeric discriminator keeps names unique without making them unrealistic;
    // only ~30% carry one, so plenty of clean basenames survive for prefix hits.
    const disc = rng() < 0.3 ? `${Math.floor(rng() * 900)}` : "";
    paths.add(`${top}/${mid}${deep}/${leaf}${disc}${ext}`);
  }

  return [...paths];
}

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "ignore"],
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

export interface FileSearchRepo {
  path: string;
  /** Number of generated tracked paths (directories are added by the service). */
  fileCount: number;
}

export interface FileSearchFixture {
  root: string;
  representative: FileSearchRepo;
  monorepo: FileSearchRepo;
}

/**
 * Number of worktree indexes the retention scenario holds at once. Matches
 * `FILE_LIST_CACHE`'s `maxSize`, so the measurement is of a full cache rather
 * than of whatever fraction of one happened to fit.
 */
export const RETENTION_REPO_COUNT = 30;

/** Paths per retention repo — a representative worktree, thirty times over. */
export const RETENTION_FILE_COUNT = 3200;

let fixture: FileSearchFixture | null = null;

function buildRepo(root: string, name: string, fileCount: number, seed: number): FileSearchRepo {
  const repoPath = join(root, name);
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ["init", "-b", "main"]);
  appendFileSync(
    join(repoPath, ".git", "config"),
    "\n[commit]\n\tgpgsign = false\n[core]\n\tfsmonitor = false\n"
  );

  const relativePaths = buildRelativePaths(fileCount, seed);
  // Import the same committed corpus directly into a pack, then populate the
  // index without a checkout. The 30-repo retention fixture otherwise spends
  // its Windows liveness deadline on Git startup and object-file setup.
  const contents = "//\n";
  const message = "fixture tree\n";
  const importStream = [
    "blob",
    "mark :1",
    `data ${Buffer.byteLength(contents)}`,
    contents,
    "commit refs/heads/main",
    "committer perf <perf@example.invalid> 1 +0000",
    `data ${Buffer.byteLength(message)}`,
    message,
    ...[...relativePaths, GIT_ONLY_SENTINEL].map((relative) => `M 100644 :1 ${relative}`),
    "",
    "done",
    "",
  ].join("\n");
  git(repoPath, ["fast-import", "--quiet"], importStream);
  git(repoPath, ["read-tree", "HEAD"]);

  return { path: repoPath, fileCount: relativePaths.length };
}

/**
 * Build both repos once per process. ~15k realistic paths share one tiny blob
 * in the index; the measured `git ls-files` and scoring work is unchanged.
 */
export function getFileSearchFixture(): FileSearchFixture {
  if (fixture) return fixture;

  // realpath matters: on macOS `mkdtemp` hands back a /var/... path while git
  // reports /private/var/... from `rev-parse --show-toplevel`. FileSearchService
  // derives its pathspec from `path.relative(gitRoot, cwd)`, so the mismatch
  // yields a bogus `../../..` pathspec, `git ls-files` returns nothing, and the
  // service silently falls back to its filesystem walk — the benchmark would
  // then time the walker while claiming to measure git.
  // Registered before the repos are built: a fixture that throws half-way
  // through would otherwise leave ~15k files behind on the runner.
  const root = createPerfTempRoot("daintree-perf-filesearch-", { canonical: true });

  fixture = {
    root,
    representative: buildRepo(root, "app-repo", REPRESENTATIVE_FILE_COUNT, 190),
    monorepo: buildRepo(root, "monorepo", MONOREPO_FILE_COUNT, 191),
  };

  return fixture;
}

let retentionRepos: FileSearchRepo[] | null = null;

/**
 * A fleet of distinct worktrees, one cache entry each.
 *
 * Built with the same index-only fixture as `buildRepo`: `fast-import`
 * commits every path against one shared blob and nothing is
 * written to the working tree, so thirty 3,200-path repos cost thirty git
 * inits rather than 96,000 files on disk. `git ls-files --cached` still returns
 * the full corpus, which is what `FileSearchService` reads, so each entry is
 * the full-size index the retention number is about.
 */
export function getFileSearchRetentionRepos(): FileSearchRepo[] {
  if (retentionRepos) return retentionRepos;

  const root = createPerfTempRoot("daintree-perf-filesearch-fleet-", { canonical: true });
  const repos: FileSearchRepo[] = [];
  for (let index = 0; index < RETENTION_REPO_COUNT; index += 1) {
    // A distinct seed per repo: identical path arrays across thirty entries
    // would let the engine intern one copy of every string and understate
    // exactly the retention this measures.
    repos.push(buildRepo(root, `worktree-${index}`, RETENTION_FILE_COUNT, 1000 + index));
  }

  retentionRepos = repos;
  return retentionRepos;
}

/**
 * Add a tracked path to a fixture repo and return it, so a scenario can prove
 * an invalidated listing actually got rebuilt rather than merely re-timed.
 * Index-only, matching how the repo was built.
 *
 * Pair every call with `removeTrackedPath` in a `finally`: the fixture is built
 * once per process and shared across every iteration, so a probe left behind
 * grows the measured corpus with each one and two runs of the same scenario
 * would no longer be measuring the same repository.
 */
export function addTrackedPath(repo: FileSearchRepo, relativePath: string): string {
  const blob = git(repo.path, ["hash-object", "-w", "--stdin"], "//\n").trim();
  git(repo.path, ["update-index", "--add", "--index-info"], `100644 ${blob}\t${relativePath}\n`);
  return relativePath;
}

/** Undo `addTrackedPath`, restoring the repo to its generated corpus. */
export function removeTrackedPath(repo: FileSearchRepo, relativePath: string): void {
  git(repo.path, ["update-index", "--force-remove", relativePath]);
}

/**
 * Move `Date.now()` forward for the duration of a measurement.
 *
 * `Cache` decides expiry against `Date.now()`, so this is what lets a scenario
 * ask "what does the picker do when the user comes back after a pause" without
 * the scenario itself pausing. `performance.now()` is untouched, so every timing
 * in the bracket is still real elapsed time — only the cache's age arithmetic
 * moves. Always restore in a `finally`: the offset is process-global.
 */
export function withClockOffset<T>(offsetMs: number, body: () => T): T {
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + offsetMs;
  try {
    return body();
  } finally {
    Date.now = realNow;
  }
}

/** Async form of `withClockOffset`, for a bracket that awaits a search. */
export async function withClockOffsetAsync<T>(
  offsetMs: number,
  body: () => Promise<T>
): Promise<T> {
  const realNow = Date.now;
  Date.now = () => realNow.call(Date) + offsetMs;
  try {
    return await body();
  } finally {
    Date.now = realNow;
  }
}

export interface FileSearchModule {
  fileSearchService: import("../../../electron/services/FileSearchService").FileSearchService;
}

export interface FileSearchInvalidationModule {
  fileSearchCacheInvalidator: import("../../../electron/services/workspace-client/fileSearchCacheInvalidation").FileSearchCacheInvalidator;
}

let modulePromise: Promise<FileSearchModule> | null = null;
let invalidationModulePromise: Promise<FileSearchInvalidationModule> | null = null;

function ensureUserDataDir(): void {
  if (!process.env.DAINTREE_USER_DATA) {
    process.env.DAINTREE_USER_DATA = createPerfTempRoot("daintree-perf-userdata-");
  }
}

/**
 * Loaded lazily: FileSearchService pulls in the logger, which resolves its file
 * destination from DAINTREE_USER_DATA at module eval.
 */
export function loadFileSearchModule(): Promise<FileSearchModule> {
  if (!modulePromise) {
    ensureUserDataDir();
    modulePromise = import("../../../electron/services/FileSearchService").then((mod) => ({
      fileSearchService: mod.fileSearchService,
    }));
  }
  return modulePromise;
}

/**
 * The production watcher-to-cache decision, loadable on its own.
 *
 * `FileSearchCacheInvalidator` is deliberately separate from
 * `WorkspaceHostEventRouter` so a benchmark can drive the real rule — the
 * `workingTreeChangedAt` comparison and the descendant-scoped drop — without
 * the router's `electron`, store and renderer-broadcast imports. What is NOT in
 * the bracket, and must not be claimed from it: the filesystem watch itself,
 * its debounce, and the utility-process hop that carries the snapshot to main.
 */
export function loadFileSearchInvalidationModule(): Promise<FileSearchInvalidationModule> {
  if (!invalidationModulePromise) {
    ensureUserDataDir();
    invalidationModulePromise =
      import("../../../electron/services/workspace-client/fileSearchCacheInvalidation").then(
        (mod) => ({ fileSearchCacheInvalidator: mod.fileSearchCacheInvalidator })
      );
  }
  return invalidationModulePromise;
}

/**
 * Queries a user actually types into the `@` picker, expanded one keystroke at
 * a time by the scenarios. Every prefix is a full re-scan of the path list, so
 * the short prefixes cost the most (nearly everything still matches and
 * survives into the top-N heap).
 *
 * Each must actually match this fixture's generated vocabulary — the scenarios
 * assert that per query, because a query silently matching nothing measures the
 * reject path while reporting itself as typing latency. Leaf names are
 * `{Word}{Suffix}{digits?}{ext}`, so a literal like `theme.css` never matches;
 * use a word, a path prefix, a Word+Suffix pair, or an extension.
 */
export const TYPED_FILE_QUERIES = [
  "terminal",
  "src/comp",
  "WorktreeService",
  ".css",
  "notif",
] as const;

/**
 * A query with no match anywhere. This is the true worst case: `scorePath`
 * returns null for every path, so the scan can never terminate early and the
 * full list is walked.
 */
export const NO_MATCH_QUERY = "zzqqxvnomatch";
