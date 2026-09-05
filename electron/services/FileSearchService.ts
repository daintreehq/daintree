import * as fs from "fs/promises";
import * as path from "path";
import { createHardenedGit } from "../utils/hardenedGit.js";
import { Cache } from "../utils/cache.js";
import { logWarn } from "../utils/logger.js";
import { isPathInside } from "../../shared/utils/path.js";
import type { Dirent } from "fs";

interface FileListCacheEntry {
  files: string[];
  normalizedFiles: string[];
  basenameStarts: Int32Array;
  sortedFiles?: string[];
  lastSearchQuery?: string;
  lastSearchCandidates?: number[];
}

/**
 * How long an index stays usable without a filesystem signal.
 *
 * Freshness is driven by the watcher now: `FileSearchCacheInvalidator` drops a
 * worktree's index on every debounced files-changed flush the workspace host
 * reports, so this clock is a fallback rather than the primary mechanism. It
 * still has to exist, because `WatcherController` arms the recursive worktree
 * watch only for ELEVATED worktrees (`_isCurrent || _agentActive`) — a
 * background worktree stays on the cheap `.git/`-only watch and never emits the
 * signal, so its entry has nothing but this clock.
 *
 * Five minutes keeps a whole picker session warm (the ten seconds this replaced
 * lapsed mid-session, and every lapse cost a `git ls-files` plus a synchronous
 * index build on the process that also serves every terminal's IPC) while
 * bounding how stale an unwatched listing can get.
 */
const FILE_LIST_TTL_MS = 300_000;

/**
 * How often expired indexes are swept out.
 *
 * `Cache.get` only drops the one key it was asked for and `set` only evicts by
 * LRU past `maxSize`, so without a sweep an expired entry — `files`,
 * `normalizedFiles`, `basenameStarts`, the optional sorted copy, megabytes on a
 * large repo — stays resident until something reads that exact cwd again.
 *
 * A minute rather than a multiple of the TTL: the sweep is a walk of at most
 * `maxSize` numeric comparisons, so its cost is not worth amortising, and
 * pacing it off the TTL would put worst-case residency at TTL + minutes when
 * the whole point is to stop holding indexes nobody is going to read.
 */
const FILE_LIST_SWEEP_INTERVAL_MS = 60_000;

const FILE_LIST_CACHE = new Cache<string, FileListCacheEntry>({
  maxSize: 30,
  defaultTTL: FILE_LIST_TTL_MS,
});
const FILE_LIST_IN_FLIGHT = new Map<string, Promise<FileListCacheEntry>>();
const FILE_LIST_EPOCHS = new Map<string, number>();

let fileListSweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Armed by the first cached index and disarmed once the cache drains, so an
 * app that never opens the picker never runs it and an idle one stops within a
 * sweep of its last entry expiring. Nothing arms it at import or construction
 * time — a test or perf fixture that loads this module inherits no timer — and
 * `unref()` keeps it from holding the process open either way.
 */
function armFileListSweep(): void {
  if (fileListSweepTimer !== null) return;
  fileListSweepTimer = setInterval(sweepFileListCache, FILE_LIST_SWEEP_INTERVAL_MS);
  fileListSweepTimer.unref?.();
}

function disarmFileListSweep(): void {
  if (fileListSweepTimer === null) return;
  clearInterval(fileListSweepTimer);
  fileListSweepTimer = null;
}

function sweepFileListCache(): void {
  FILE_LIST_CACHE.cleanup();
  if (FILE_LIST_CACHE.size() === 0) disarmFileListSweep();
}

/**
 * Drop one already-resolved cwd.
 *
 * The epoch is bumped even when nothing was cached: a load already in flight
 * captured the previous value and `getFiles` refuses to commit a result whose
 * captured epoch has moved. Epochs are deliberately never pruned — deleting one
 * would let a fenced load's captured value compare equal again through the
 * `?? 0` default and reseed the cache with a listing from before the change.
 */
function invalidateResolvedCwd(resolvedCwd: string): void {
  FILE_LIST_CACHE.invalidate(resolvedCwd);
  FILE_LIST_IN_FLIGHT.delete(resolvedCwd);
  FILE_LIST_EPOCHS.set(resolvedCwd, (FILE_LIST_EPOCHS.get(resolvedCwd) ?? 0) + 1);
}

const MAX_RESULTS_DEFAULT = 50;
const MAX_QUERY_LENGTH = 256;
const MAX_FALLBACK_FILES = 20_000;

// Names hard-skipped by the fallback walker only. Git mode honours .gitignore via
// --exclude-standard, so these are unnecessary there. Includes a few well-known
// noise files (.DS_Store) alongside dirs.
const FALLBACK_SKIP_NAMES = new Set<string>([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "bower_components",
  ".venv",
  ".virtualenv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".cache",
  "coverage",
  ".nyc_output",
  ".DS_Store",
]);

// One-shot per-cwd cap warnings; persists for process lifetime so a 20k-file
// repo logs once at startup, not once per file-watcher invalidation.
const FALLBACK_CAP_WARNED = new Set<string>();

let pathCollator: Intl.Collator | null = null;
function getPathCollator(): Intl.Collator {
  pathCollator ??= new Intl.Collator();
  return pathCollator;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim().slice(0, MAX_QUERY_LENGTH);
  let normalized = trimmed;
  if (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized.startsWith("/")) normalized = normalized.slice(1);
  return normalized.replace(/\/+/g, "/");
}

function scorePath(
  normalizedQuery: string,
  normalizedFile: string,
  basenameStart: number
): number | null {
  if (normalizedQuery.length === 0) return 0;

  const fileIdx = normalizedFile.indexOf(normalizedQuery);
  if (fileIdx === -1) return null;

  let basenameIdx: number;
  if (fileIdx >= basenameStart) {
    basenameIdx = fileIdx - basenameStart;
  } else {
    const inBasename = normalizedFile.indexOf(normalizedQuery, basenameStart);
    basenameIdx = inBasename === -1 ? -1 : inBasename - basenameStart;
  }

  const queryLength = normalizedQuery.length;
  if (basenameIdx === 0 && basenameStart + queryLength === normalizedFile.length) return 0;
  if (fileIdx === 0 && queryLength === normalizedFile.length) return 1;

  if (basenameIdx === 0) return 10;
  if (fileIdx === 0) return 20;
  if (basenameIdx > 0) return 30 + basenameIdx;
  return 50 + fileIdx;
}

function buildScoringInputs(files: string[]): {
  normalizedFiles: string[];
  basenameStarts: Int32Array;
} {
  const normalizedFiles = new Array<string>(files.length);
  const basenameStarts = new Int32Array(files.length);
  for (let i = 0; i < files.length; i++) {
    const lower = files[i].toLowerCase();
    const normalized = lower.endsWith("/") ? lower.slice(0, -1) : lower;
    normalizedFiles[i] = normalized;
    basenameStarts[i] = normalized.lastIndexOf("/") + 1;
  }
  return { normalizedFiles, basenameStarts };
}

function sortedFilesFor(entry: FileListCacheEntry): string[] {
  if (!entry.sortedFiles) {
    const collator = getPathCollator();
    entry.sortedFiles = [...entry.files].sort(
      (a, b) => a.length - b.length || collator.compare(a, b)
    );
  }
  return entry.sortedFiles;
}

function pickTopMatches(entry: FileListCacheEntry, query: string, limit: number): string[] {
  const queryLower = normalizeQuery(query).toLowerCase();
  const normalizedQuery = queryLower.endsWith("/") ? queryLower.slice(0, -1) : queryLower;
  const effectiveLimit = clampInt(limit, 1, 100, MAX_RESULTS_DEFAULT);

  if (normalizedQuery.length === 0) {
    return sortedFilesFor(entry).slice(0, effectiveLimit);
  }

  const best: Array<{ file: string; score: number }> = [];
  const matchingCandidates: number[] = [];
  const previousCandidates = entry.lastSearchCandidates;
  const canNarrowPrevious =
    previousCandidates !== undefined &&
    entry.lastSearchQuery !== undefined &&
    normalizedQuery.startsWith(entry.lastSearchQuery);
  const candidates = canNarrowPrevious ? previousCandidates : undefined;
  let worstIdx = -1;
  let worstScore = -Infinity;

  const candidateCount = candidates?.length ?? entry.files.length;
  for (let candidateIdx = 0; candidateIdx < candidateCount; candidateIdx++) {
    const fileIdx = candidates?.[candidateIdx] ?? candidateIdx;
    const file = entry.files[fileIdx];
    const score = scorePath(
      normalizedQuery,
      entry.normalizedFiles[fileIdx],
      entry.basenameStarts[fileIdx]
    );
    if (score === null) continue;
    matchingCandidates.push(fileIdx);

    if (best.length < effectiveLimit) {
      best.push({ file, score });
      if (score > worstScore) {
        worstScore = score;
        worstIdx = best.length - 1;
      }
      continue;
    }

    if (score >= worstScore) continue;
    best[worstIdx] = { file, score };

    worstScore = -Infinity;
    worstIdx = -1;
    for (let i = 0; i < best.length; i++) {
      if (best[i].score > worstScore) {
        worstScore = best[i].score;
        worstIdx = i;
      }
    }
  }

  entry.lastSearchQuery = normalizedQuery;
  entry.lastSearchCandidates = matchingCandidates;
  const collator = getPathCollator();
  best.sort((a, b) => a.score - b.score || collator.compare(a.file, b.file));
  return best.map((m) => m.file);
}

async function loadFilesFromDisk(cwd: string): Promise<string[]> {
  const queue: string[] = [cwd];
  const results: string[] = [];

  while (queue.length > 0 && results.length < MAX_FALLBACK_FILES) {
    const dir = queue.pop();
    if (!dir) break;

    let entries: Array<Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (FALLBACK_SKIP_NAMES.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(cwd, absolute);
      // APFS stores filenames as NFD on macOS; normalise to match the NFC paths
      // git produces via core.precomposeunicode.
      const relativePosix = toPosixPath(relative).normalize("NFC");

      if (entry.isDirectory()) {
        results.push(`${relativePosix}/`);
        queue.push(absolute);
        if (results.length >= MAX_FALLBACK_FILES) break;
        continue;
      }

      if (!entry.isFile()) continue;
      results.push(relativePosix);
      if (results.length >= MAX_FALLBACK_FILES) break;
    }
  }

  if (results.length >= MAX_FALLBACK_FILES && !FALLBACK_CAP_WARNED.has(cwd)) {
    FALLBACK_CAP_WARNED.add(cwd);
    logWarn("[FileSearchService] loadFilesFromDisk: hit fallback cap", {
      cwd,
      cap: MAX_FALLBACK_FILES,
    });
  }

  const collator = getPathCollator();
  return results.sort((a, b) => collator.compare(a, b));
}

async function loadGitFiles(cwd: string): Promise<string[]> {
  const git = await createHardenedGit(cwd);

  // -z: NUL-delimited output. Required to round-trip filenames containing tabs,
  // newlines, or backslashes; core.quotepath=false alone only suppresses high-bit
  // quoting.
  // No --recurse-submodules: submodules surface as a single gitlink and recursing
  // would require a separate ls-files invocation per submodule and break the
  // cwd-relative path mapping below.
  // No -t / skip-worktree filtering: skip-worktree entries appear as phantoms in
  // the index but are intentionally surfaced so users can still search files they
  // chose not to check out.
  // Running from cwd scopes ls-files to that subtree and emits cwd-relative
  // paths. A non-repository cwd exits non-zero and falls back to the walker.
  const output = await git.raw(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);

  const files: string[] = [];
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf("\0", start);
    if (end === -1) end = output.length;
    if (end > start) files.push(output.slice(start, end));
    start = end + 1;
  }

  const dirs = new Set<string>();
  for (const file of files) {
    let dir = file;
    while (true) {
      const slashIdx = dir.lastIndexOf("/");
      if (slashIdx === -1) break;
      dir = dir.slice(0, slashIdx);
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }

  for (const dir of dirs) files.push(`${dir}/`);
  return files;
}

const NL_STOP_WORDS = new Set([
  "component",
  "file",
  "the",
  "a",
  "an",
  "to",
  "for",
  "of",
  "and",
  "or",
  "in",
  "my",
  "this",
]);

function splitCamelCase(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])([0-9])/g, "$1 $2")
    .replace(/([0-9])([a-zA-Z])/g, "$1 $2")
    .split(/[\s_\-./]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function scorePathNaturalLanguage(tokens: string[], file: string): number | null {
  if (tokens.length === 0) return null;

  const lastSlash = file.lastIndexOf("/");
  const basename = file.slice(lastSlash + 1);
  const nameWithoutExt = basename.replace(/\.[^.]+$/, "");
  const words = splitCamelCase(nameWithoutExt);

  let matched = 0;
  for (const token of tokens) {
    if (
      words.some(
        (w) =>
          w === token ||
          (token.length >= 3 && w.length >= 3 && (w.startsWith(token) || token.startsWith(w)))
      )
    ) {
      matched++;
    }
  }

  if (matched === 0) return null;
  return matched / tokens.length;
}

function pickTopNaturalLanguageMatches(
  files: string[],
  description: string,
  limit: number
): string[] {
  const rawTokens = description
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NL_STOP_WORDS.has(t))
    .flatMap((t) => splitCamelCase(t));

  if (rawTokens.length === 0) return [];

  const scored: Array<{ file: string; score: number; pathLen: number }> = [];
  for (const file of files) {
    if (file.endsWith("/")) continue;
    const score = scorePathNaturalLanguage(rawTokens, file);
    if (score === null) continue;
    scored.push({ file, score, pathLen: file.length });
  }

  scored.sort((a, b) => b.score - a.score || a.pathLen - b.pathLen);
  return scored.slice(0, limit).map((s) => s.file);
}

export class FileSearchService {
  async search(payload: { cwd: string; query: string; limit?: number }): Promise<string[]> {
    try {
      const resolvedCwd = path.resolve(payload.cwd);
      const limit = clampInt(payload.limit, 1, 100, MAX_RESULTS_DEFAULT);

      const entry = await this.getFiles(resolvedCwd);

      return pickTopMatches(entry, payload.query, limit);
    } catch {
      return [];
    }
  }

  async searchNaturalLanguage(payload: {
    cwd: string;
    description: string;
    limit?: number;
  }): Promise<string[]> {
    try {
      const resolvedCwd = path.resolve(payload.cwd);
      const limit = clampInt(payload.limit, 1, 100, 20);

      const entry = await this.getFiles(resolvedCwd);

      return pickTopNaturalLanguageMatches(entry.files, payload.description, limit);
    } catch {
      return [];
    }
  }

  invalidate(cwd: string): void {
    invalidateResolvedCwd(path.resolve(cwd));
    if (FILE_LIST_CACHE.size() === 0) disarmFileListSweep();
  }

  /**
   * Drop `root`'s index and every cached index beneath it.
   *
   * The watcher reports a change against a worktree root, but the cache is
   * keyed by whatever cwd a caller searched, and `files.search` is an
   * ActionService action — so it is also an MCP tool, whose `cwd` is supplied by
   * the caller (`systemActions.ts`). An agent that searches a subdirectory
   * caches an entry under that subpath, and a root-scoped drop would leave it
   * to outlive every change made to it.
   */
  invalidateUnder(root: string): void {
    const resolvedRoot = path.resolve(root);
    // The root itself always, cached or not, so this keeps `invalidate`'s
    // fencing contract for a load in flight against the root.
    const targets = new Set<string>([resolvedRoot]);

    // `Cache.forEach` skips expired entries without deleting them, so sweep
    // first: an expired descendant would otherwise be invisible here and
    // survive the invalidation that was supposed to remove it.
    FILE_LIST_CACHE.cleanup();
    FILE_LIST_CACHE.forEach((_entry, key) => {
      if (isPathInside(key, resolvedRoot)) targets.add(key);
    });
    for (const key of FILE_LIST_IN_FLIGHT.keys()) {
      if (isPathInside(key, resolvedRoot)) targets.add(key);
    }

    for (const target of targets) invalidateResolvedCwd(target);
    if (FILE_LIST_CACHE.size() === 0) disarmFileListSweep();
  }

  /**
   * Run the expiry sweep now. The timer's own body, exposed so tests and the
   * retention benchmark exercise the shipped path rather than a copy of it.
   */
  sweep(): void {
    sweepFileListCache();
  }

  getCacheStats(): ReturnType<Cache<string, FileListCacheEntry>["getStats"]> {
    return FILE_LIST_CACHE.getStats();
  }

  /**
   * Drop every index and stop the sweep.
   *
   * For tests and perf fixtures. The app has no need of it: the timer is
   * `unref()`'d and disarms itself once the cache drains. In-flight keys are
   * fenced rather than merely forgotten, so a load still settling cannot reseed
   * the cache after teardown.
   */
  dispose(): void {
    for (const key of [...FILE_LIST_IN_FLIGHT.keys()]) invalidateResolvedCwd(key);
    FILE_LIST_CACHE.clear();
    disarmFileListSweep();
  }

  private async loadFileList(cwd: string): Promise<string[]> {
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stats = await fs.stat(cwd);
    } catch {
      return [];
    }

    if (!stats.isDirectory()) {
      return [];
    }

    try {
      const gitFiles = await loadGitFiles(cwd);
      if (gitFiles.length > 0) return gitFiles;
    } catch {
      // ignore; fall back to filesystem walk
    }

    return loadFilesFromDisk(cwd);
  }

  private async getFiles(resolvedCwd: string): Promise<FileListCacheEntry> {
    const cached = FILE_LIST_CACHE.get(resolvedCwd);
    if (cached) {
      return cached;
    }

    const existing = FILE_LIST_IN_FLIGHT.get(resolvedCwd);
    if (existing) {
      return existing;
    }

    const epoch = FILE_LIST_EPOCHS.get(resolvedCwd) ?? 0;
    const loadPromise: Promise<FileListCacheEntry> = this.loadFileList(resolvedCwd)
      .then((loaded) => {
        const { normalizedFiles, basenameStarts } = buildScoringInputs(loaded);
        const entry: FileListCacheEntry = {
          files: loaded,
          normalizedFiles,
          basenameStarts,
        };
        if ((FILE_LIST_EPOCHS.get(resolvedCwd) ?? 0) === epoch) {
          FILE_LIST_CACHE.set(resolvedCwd, entry);
          armFileListSweep();
        }
        return entry;
      })
      .finally(() => {
        if (FILE_LIST_IN_FLIGHT.get(resolvedCwd) === loadPromise) {
          FILE_LIST_IN_FLIGHT.delete(resolvedCwd);
        }
      });

    FILE_LIST_IN_FLIGHT.set(resolvedCwd, loadPromise);
    return loadPromise;
  }
}

export const fileSearchService = new FileSearchService();
