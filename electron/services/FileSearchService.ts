import * as fs from "fs/promises";
import type { Dir, Dirent } from "fs";
import * as path from "path";
import { createStrictExitGit } from "../utils/hardenedGit.js";
import { Cache } from "../utils/cache.js";
import { logWarn } from "../utils/logger.js";
import { isPathInside } from "../../shared/utils/path.js";

interface FileListCacheEntry {
  files: string[];
  normalizedFiles: string[];
  basenameStarts: Int32Array;
  shortestFiles?: string[];
  /** `shortestFiles` without directory entries, for a files-only empty query. */
  shortestOnlyFiles?: string[];
  lastSearchQuery?: string;
  lastSearchCandidates?: number[];
  /**
   * Built by the first natural-language search against this listing and
   * dropped with it, so a project that never resolves a spoken file name never
   * pays for one.
   */
  naturalLanguageIndex?: NaturalLanguageIndex;
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
 * `normalizedFiles`, `basenameStarts`, megabytes on a large repo — stays
 * resident until something reads that exact cwd again.
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
/**
 * Also the fence. A load commits its index only while it is still this map's
 * value for its cwd, and every invalidation deletes the entry, so a load the
 * invalidation overtook can never commit: its key is gone, or a newer load has
 * taken it. Holding the fence in the entry itself means invalidating a cwd
 * nobody is loading stores nothing, and the map drains as loads settle.
 */
const FILE_LIST_IN_FLIGHT = new Map<string, Promise<FileListCacheEntry>>();

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
 * Do two resolved scopes overlap — is either one inside the other?
 *
 * Both directions, because the cache is keyed by whatever cwd a caller
 * searched. A change under a worktree invalidates listings taken INSIDE it, and
 * also any wider listing that already contains the changed subtree — an MCP
 * search rooted at a parent directory caches exactly that.
 *
 * Case-folded on Windows only, where the filesystem is case-insensitive and
 * `path.resolve` preserves whatever spelling the caller used, so `C:\\Repo` and
 * `c:\\repo` are one directory that would otherwise never match each other.
 * Symlink aliases (`/var` vs `/private/var` on macOS) are still distinct keys
 * and fall back to the TTL; canonicalising would put a `realpath` syscall on
 * this path and cannot resolve a directory that has just been deleted.
 */
function scopesOverlap(a: string, b: string): boolean {
  const left = process.platform === "win32" ? a.toLowerCase() : a;
  const right = process.platform === "win32" ? b.toLowerCase() : b;
  return isPathInside(left, right) || isPathInside(right, left);
}

/**
 * Drop one already-resolved cwd: its index, and the in-flight entry that a load
 * still running needs in order to commit (see `FILE_LIST_IN_FLIGHT`).
 */
function invalidateResolvedCwd(resolvedCwd: string): void {
  FILE_LIST_CACHE.invalidate(resolvedCwd);
  FILE_LIST_IN_FLIGHT.delete(resolvedCwd);
}

const MAX_RESULTS_DEFAULT = 50;
const MAX_RESULTS_LIMIT = 100;
const MAX_QUERY_LENGTH = 256;
const MAX_FALLBACK_FILES = 20_000;
// Raw entries a directory handle reads per call. The walker pulls them one at a
// time and stops at the cap, so a directory far wider than the remaining budget
// costs at most one batch of surplus reads rather than every entry it holds.
// Kept small because a filesystem that reports no entry type has each batch
// resolved with synchronous lstat calls on this thread.
const FALLBACK_READ_BATCH = 32;

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
  // Indexed paths are POSIX-style everywhere; only Windows treats `\` as a
  // separator, so POSIX keeps matching a literal backslash in a filename.
  let normalized = process.platform === "win32" ? trimmed.replace(/\\/g, "/") : trimmed;
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

/**
 * The empty-query ranking, cut at the largest page any caller can ask for, so
 * every limit is a prefix of one cached list rather than of its own selection.
 */
function shortestFilesFor(entry: FileListCacheEntry, filesOnly: boolean): string[] {
  if (filesOnly) {
    entry.shortestOnlyFiles ??= selectShortestFiles(
      entry.files.filter((file) => !file.endsWith("/")),
      MAX_RESULTS_LIMIT
    );
    return entry.shortestOnlyFiles;
  }
  entry.shortestFiles ??= selectShortestFiles(entry.files, MAX_RESULTS_LIMIT);
  return entry.shortestFiles;
}

/**
 * The first `count` paths of a stable sort by length then locale, without
 * sorting the whole index on the process that serves every terminal's IPC.
 *
 * The index tie-break is the stability `Array.prototype.sort` gives paths the
 * collator calls equal, made explicit: it turns the order into a total one, and
 * the smallest `count` elements of a total order are exactly the first `count`
 * of the stable sort. A bounded max-heap holds the best seen so far, and most
 * paths are longer than its worst, so they are rejected on a length comparison
 * without reaching the collator.
 */
function selectShortestFiles(files: string[], count: number): string[] {
  const collator = getPathCollator();
  const compare = (a: number, b: number): number => {
    const byLength = files[a].length - files[b].length;
    if (byLength !== 0) return byLength;
    return collator.compare(files[a], files[b]) || a - b;
  };

  const heap: number[] = [];
  const siftDown = (): void => {
    let parent = 0;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let largest = parent;
      if (left < heap.length && compare(heap[left], heap[largest]) > 0) largest = left;
      if (right < heap.length && compare(heap[right], heap[largest]) > 0) largest = right;
      if (largest === parent) return;
      [heap[parent], heap[largest]] = [heap[largest], heap[parent]];
      parent = largest;
    }
  };

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    if (heap.length < count) {
      let child = heap.push(fileIdx) - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (compare(heap[child], heap[parent]) <= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
      continue;
    }
    if (compare(fileIdx, heap[0]) >= 0) continue;
    heap[0] = fileIdx;
    siftDown();
  }

  return heap.sort(compare).map((fileIdx) => files[fileIdx]);
}

interface ScoredMatch {
  file: string;
  score: number;
}

// The one total order used both to admit candidates and to sort survivors, so
// every limit returns a prefix of the same ranking. The raw-string fallback
// covers canonically equivalent paths the collator calls equal.
function compareMatches(a: ScoredMatch, b: ScoredMatch): number {
  if (a.score !== b.score) return a.score - b.score;
  const byLocale = getPathCollator().compare(a.file, b.file);
  if (byLocale !== 0) return byLocale;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

function findWorstIdx(best: ScoredMatch[]): number {
  let worstIdx = 0;
  for (let i = 1; i < best.length; i++) {
    if (compareMatches(best[i], best[worstIdx]) > 0) worstIdx = i;
  }
  return worstIdx;
}

function pickTopMatches(
  entry: FileListCacheEntry,
  query: string,
  limit: number,
  filesOnly = false
): string[] {
  const queryLower = normalizeQuery(query).toLowerCase();
  const normalizedQuery = queryLower.endsWith("/") ? queryLower.slice(0, -1) : queryLower;
  const effectiveLimit = clampInt(limit, 1, MAX_RESULTS_LIMIT, MAX_RESULTS_DEFAULT);

  if (normalizedQuery.length === 0) {
    return shortestFilesFor(entry, filesOnly).slice(0, effectiveLimit);
  }

  const best: ScoredMatch[] = [];
  const matchingCandidates: number[] = [];
  const previousCandidates = entry.lastSearchCandidates;
  const canNarrowPrevious =
    previousCandidates !== undefined &&
    entry.lastSearchQuery !== undefined &&
    normalizedQuery.startsWith(entry.lastSearchQuery);
  const candidates = canNarrowPrevious ? previousCandidates : undefined;
  let worstIdx = -1;

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
    // Recorded before the files-only skip: the next query narrows from this
    // list whatever it asks for, and must still find the directories.
    matchingCandidates.push(fileIdx);
    if (filesOnly && file.endsWith("/")) continue;

    const match = { file, score };
    if (best.length < effectiveLimit) {
      best.push(match);
      if (worstIdx === -1 || compareMatches(match, best[worstIdx]) > 0) {
        worstIdx = best.length - 1;
      }
      continue;
    }

    if (compareMatches(match, best[worstIdx]) >= 0) continue;
    best[worstIdx] = match;
    worstIdx = findWorstIdx(best);
  }

  entry.lastSearchQuery = normalizedQuery;
  entry.lastSearchCandidates = matchingCandidates;
  best.sort(compareMatches);
  return best.map((m) => m.file);
}

async function loadFilesFromDisk(cwd: string): Promise<string[]> {
  const queue: string[] = [cwd];
  const results: string[] = [];

  while (queue.length > 0 && results.length < MAX_FALLBACK_FILES) {
    const dir = queue.pop();
    if (!dir) break;

    let handle: Dir;
    try {
      handle = await fs.opendir(dir, { bufferSize: FALLBACK_READ_BATCH });
    } catch {
      continue;
    }

    // The handle's iterator closes the handle when it finishes or is returned, so
    // nothing here calls `close`. Entries are on disk order, not the name order
    // `readdir` sorts into: only a capped walk can tell, and it keeps whichever
    // entries the filesystem lists first.
    const entries = handle[Symbol.asyncIterator]();
    try {
      while (true) {
        let step: IteratorResult<Dirent>;
        try {
          step = await entries.next();
        } catch {
          // A read that fails part-way, whatever the error, keeps the entries
          // already taken from it. Only the read is guarded: an error thrown by
          // the body below is a bug here, and rejects instead of caching a
          // silently partial index.
          break;
        }
        if (step.done) break;
        const entry = step.value;

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
    } finally {
      // Closes the handle on the cap break or a throwing body; after exhaustion
      // or a failed read the iterator has already finished and this does nothing.
      try {
        await entries.return?.();
      } catch {
        // A close that fails leaves nothing to recover, and must not replace the
        // error of the body that was already unwinding.
      }
    }
  }

  if (results.length >= MAX_FALLBACK_FILES && !FALLBACK_CAP_WARNED.has(cwd)) {
    FALLBACK_CAP_WARNED.add(cwd);
    logWarn("[FileSearchService] loadFilesFromDisk: hit fallback cap", {
      cwd,
      cap: MAX_FALLBACK_FILES,
    });
  }

  // Disk order is not name order, so paths the collator calls equal (zero-width
  // joiners, soft hyphens) are ordered by raw string rather than by where the
  // filesystem happened to list them.
  const collator = getPathCollator();
  return results.sort((a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}

async function loadGitFiles(cwd: string): Promise<string[]> {
  // Strict exit: an empty listing is taken as final, so a git that died without
  // output has to reject and reach the walker rather than read as "all ignored".
  const git = await createStrictExitGit(cwd);

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

  // ls-files prints an unmerged path once per index stage (base/ours/theirs), so
  // exact repeats are dropped here. Exact-string only: case and Unicode variants
  // are distinct paths and stay separate.
  const seen = new Set<string>();
  let start = 0;
  while (start < output.length) {
    let end = output.indexOf("\0", start);
    if (end === -1) end = output.length;
    if (end > start) seen.add(output.slice(start, end));
    start = end + 1;
  }
  const files = [...seen];

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

const UNICODE_SPACE = /\s/;

function isWordSeparator(code: number): boolean {
  if (code < 128) {
    return (
      code === 32 ||
      (code >= 9 && code <= 13) ||
      code === 95 ||
      code === 45 ||
      code === 46 ||
      code === 47
    );
  }
  return UNICODE_SPACE.test(String.fromCharCode(code));
}

const isLower = (code: number): boolean => code >= 97 && code <= 122;
const isUpper = (code: number): boolean => code >= 65 && code <= 90;
const isDigit = (code: number): boolean => code >= 48 && code <= 57;

/**
 * Lowercase words of a name, split at `\s`, `_`, `-`, `.` and `/`, at a
 * lower-to-upper step (`fooBar`), before the last capital of an acronym that
 * runs into a word (`HTMLParser`), and between letters and digits (`s3Client`).
 * ASCII letters only, as the regex passes this replaced did. One scan with no
 * intermediate strings, because a natural-language index runs it over every
 * basename in the tree.
 *
 * @internal Exported for tests only.
 */
export function splitCamelCase(name: string): string[] {
  const words: string[] = [];
  let start = 0;
  for (let i = 0; i <= name.length; i++) {
    if (i === name.length) {
      if (i > start) words.push(name.slice(start, i).toLowerCase());
      break;
    }
    const code = name.charCodeAt(i);
    if (isWordSeparator(code)) {
      if (i > start) words.push(name.slice(start, i).toLowerCase());
      start = i + 1;
      continue;
    }
    if (i === start) continue;
    const prev = name.charCodeAt(i - 1);
    const boundary =
      (isLower(prev) && isUpper(code)) ||
      (isUpper(prev) && isUpper(code) && i + 1 < name.length && isLower(name.charCodeAt(i + 1))) ||
      ((isLower(prev) || isUpper(prev)) && isDigit(code)) ||
      (isDigit(prev) && (isLower(code) || isUpper(code)));
    if (boundary) {
      words.push(name.slice(start, i).toLowerCase());
      start = i;
    }
  }
  return words;
}

function wordMatchesToken(word: string, token: string): boolean {
  return (
    word === token ||
    (token.length >= 3 && word.length >= 3 && (word.startsWith(token) || token.startsWith(word)))
  );
}

/**
 * Every file's basename words, split once per index rather than once per
 * description. Words are interned: a file holds ids into `vocabulary`, so a
 * description is compared against each distinct word once, however many files
 * share it, and the index costs a few bytes per word rather than an array of
 * strings per file.
 */
interface NaturalLanguageIndex {
  vocabulary: string[];
  /** File `i`'s word ids are `fileWords[wordStarts[i]]` up to `wordStarts[i + 1]`; none for a directory. */
  wordStarts: Int32Array;
  fileWords: Int32Array;
}

/** The basename less its last extension: `a.test.ts` is `a.test`, `.env` is empty, `Makefile` and `notes.` stay whole. */
function nameWithoutExtension(file: string): string {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot !== -1 && dot < name.length - 1 ? name.slice(0, dot) : name;
}

function buildNaturalLanguageIndex(files: string[]): NaturalLanguageIndex {
  const vocabulary: string[] = [];
  const wordIds = new Map<string, number>();
  const wordStarts = new Int32Array(files.length + 1);
  let fileWords = new Int32Array(Math.max(16, files.length * 4));
  let wordCount = 0;

  const append = (wordId: number): void => {
    if (wordCount === fileWords.length) {
      const grown = new Int32Array(fileWords.length * 2);
      grown.set(fileWords);
      fileWords = grown;
    }
    fileWords[wordCount++] = wordId;
  };

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    wordStarts[fileIdx] = wordCount;
    const file = files[fileIdx];
    if (file.endsWith("/")) continue;

    for (const word of splitCamelCase(nameWithoutExtension(file))) {
      let wordId = wordIds.get(word);
      if (wordId === undefined) {
        wordId = vocabulary.push(word) - 1;
        wordIds.set(word, wordId);
      }
      append(wordId);
    }
  }
  wordStarts[files.length] = wordCount;

  return { vocabulary, wordStarts, fileWords: fileWords.slice(0, wordCount) };
}

/**
 * The `limit` best files for a description, best first, in the order a stable
 * sort by score then path length would give them.
 *
 * Every file is scored against the same token list, so comparing matched-token
 * counts orders exactly as comparing `matched / tokens.length` did, without
 * floating point. The file index is the stability of that sort made explicit:
 * with it the order is total, and the first `limit` of a total order are the
 * `limit` smallest, which a bounded heap finds without sorting every match.
 */
function pickTopNaturalLanguageMatches(
  entry: FileListCacheEntry,
  description: string,
  limit: number
): string[] {
  const tokens = description
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0 && !NL_STOP_WORDS.has(t))
    .flatMap((t) => splitCamelCase(t));

  if (tokens.length === 0) return [];

  const index = (entry.naturalLanguageIndex ??= buildNaturalLanguageIndex(entry.files));
  const { vocabulary, wordStarts, fileWords } = index;

  // A repeated token counts once per occurrence, as it always has: its weight
  // is how many times the description says it.
  const tokenWeights = new Map<string, number>();
  for (const token of tokens) tokenWeights.set(token, (tokenWeights.get(token) ?? 0) + 1);
  const distinctTokens = [...tokenWeights.keys()];
  const weights = distinctTokens.map((token) => tokenWeights.get(token)!);

  const files = entry.files;
  const matchedOf = new Int32Array(files.length);

  // Tokens are matched thirty-two at a time: bit `t` of `tokenMasks[wordId]` is
  // set when the word matches the group's token `t`. A file's matched tokens
  // are the OR of its words' masks, so a token two of its words match
  // (`ProfileProfiles`) still counts once. One mask array is reused for every
  // group, so the scratch stays at four bytes a word and a file however long
  // the description.
  const tokenMasks = new Int32Array(vocabulary.length);
  for (let first = 0; first < distinctTokens.length; first += 32) {
    const groupSize = Math.min(32, distinctTokens.length - first);
    if (first > 0) tokenMasks.fill(0);
    for (let wordId = 0; wordId < vocabulary.length; wordId++) {
      for (let t = 0; t < groupSize; t++) {
        if (wordMatchesToken(vocabulary[wordId], distinctTokens[first + t])) {
          tokenMasks[wordId] |= 1 << t;
        }
      }
    }
    for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
      let bits = 0;
      const end = wordStarts[fileIdx + 1];
      for (let i = wordStarts[fileIdx]; i < end; i++) bits |= tokenMasks[fileWords[i]];
      while (bits !== 0) {
        const lowest = bits & -bits;
        matchedOf[fileIdx] += weights[first + 31 - Math.clz32(lowest)];
        bits ^= lowest;
      }
    }
  }

  const compare = (a: number, b: number): number =>
    matchedOf[b] - matchedOf[a] || files[a].length - files[b].length || a - b;

  // A max-heap of the best files seen so far: its root is the worst of them.
  const heap: number[] = [];
  const siftDown = (): void => {
    let parent = 0;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let worst = parent;
      if (left < heap.length && compare(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && compare(heap[right], heap[worst]) > 0) worst = right;
      if (worst === parent) return;
      [heap[parent], heap[worst]] = [heap[worst], heap[parent]];
      parent = worst;
    }
  };

  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    if (matchedOf[fileIdx] === 0) continue;
    if (heap.length < limit) {
      let child = heap.push(fileIdx) - 1;
      while (child > 0) {
        const parent = (child - 1) >> 1;
        if (compare(heap[child], heap[parent]) <= 0) break;
        [heap[parent], heap[child]] = [heap[child], heap[parent]];
        child = parent;
      }
      continue;
    }
    if (compare(fileIdx, heap[0]) >= 0) continue;
    heap[0] = fileIdx;
    siftDown();
  }

  return heap.sort(compare).map((fileIdx) => files[fileIdx]);
}

export class FileSearchService {
  /** Every file under `cwd`, from the same cached listing searches use; empty on failure. */
  async listFiles(cwd: string): Promise<readonly string[]> {
    try {
      return (await this.getFiles(path.resolve(cwd))).files;
    } catch {
      return [];
    }
  }

  async search(payload: {
    cwd: string;
    query: string;
    limit?: number;
    filesOnly?: boolean;
  }): Promise<string[]> {
    try {
      const resolvedCwd = path.resolve(payload.cwd);
      const limit = clampInt(payload.limit, 1, MAX_RESULTS_LIMIT, MAX_RESULTS_DEFAULT);

      const entry = await this.getFiles(resolvedCwd);

      return pickTopMatches(entry, payload.query, limit, payload.filesOnly === true);
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

      return pickTopNaturalLanguageMatches(entry, payload.description, limit);
    } catch {
      return [];
    }
  }

  invalidate(cwd: string): void {
    invalidateResolvedCwd(path.resolve(cwd));
    if (FILE_LIST_CACHE.size() === 0) disarmFileListSweep();
  }

  /**
   * Drop every cached index whose scope overlaps `root` — the root itself, the
   * listings taken beneath it, and any wider listing that contains it.
   *
   * The watcher reports a change against a worktree root, but the cache is
   * keyed by whatever cwd a caller searched, and `files.search` is an
   * ActionService action — so it is also an MCP tool, whose `cwd` is supplied by
   * the caller (`systemActions.ts`). An agent can cache an index under a
   * subdirectory or over a parent directory, and a root-only drop would leave
   * either one to outlive every change made to it.
   */
  invalidateUnder(root: string): void {
    const resolvedRoot = path.resolve(root);
    const targets = new Set<string>();

    // `Cache.forEach` skips expired entries without deleting them, so sweep
    // first: an expired descendant would otherwise be invisible here and
    // survive the invalidation that was supposed to remove it.
    FILE_LIST_CACHE.cleanup();
    FILE_LIST_CACHE.forEach((_entry, key) => {
      if (scopesOverlap(key, resolvedRoot)) targets.add(key);
    });
    for (const key of FILE_LIST_IN_FLIGHT.keys()) {
      if (scopesOverlap(key, resolvedRoot)) targets.add(key);
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
   * How many cwd keys the index cache and the in-flight loads hold between
   * them, for tests that check invalidation leaves nothing behind once loads
   * settle.
   */
  getRetainedKeyCount(): number {
    return FILE_LIST_CACHE.size() + FILE_LIST_IN_FLIGHT.size;
  }

  /**
   * The natural-language word index cached for `cwd`, if one has been built,
   * as an opaque handle: tests compare it by identity to tell an index reused
   * from one rebuilt. Read without touching the cache's recency or hit counts.
   */
  peekNaturalLanguageIndex(cwd: string): object | undefined {
    const resolvedCwd = path.resolve(cwd);
    let index: object | undefined;
    FILE_LIST_CACHE.forEach((entry, key) => {
      if (key === resolvedCwd) index = entry.naturalLanguageIndex;
    });
    return index;
  }

  /**
   * Drop every index and stop the sweep.
   *
   * For tests and perf fixtures. The app has no need of it: the timer is
   * `unref()`'d and disarms itself once the cache drains. Clearing the
   * in-flight map is what fences a load still settling, so it cannot reseed the
   * cache after teardown.
   */
  dispose(): void {
    FILE_LIST_IN_FLIGHT.clear();
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
      // A successful listing is the answer even when it is empty: inside a work
      // tree, empty means nothing under cwd is tracked or unignored, and the walker
      // below doesn't read .gitignore, so falling through would list ignored files.
      // That includes a folder a parent repository ignores (a home directory
      // tracked with `*`): git can't tell that apart from an ignored subtree.
      return await loadGitFiles(cwd);
    } catch {
      // Not inside a work tree, or git can't run here: walk the disk instead.
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

    const loadPromise: Promise<FileListCacheEntry> = this.loadFileList(resolvedCwd)
      .then((loaded) => {
        const { normalizedFiles, basenameStarts } = buildScoringInputs(loaded);
        const entry: FileListCacheEntry = {
          files: loaded,
          normalizedFiles,
          basenameStarts,
        };
        if (FILE_LIST_IN_FLIGHT.get(resolvedCwd) === loadPromise) {
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
