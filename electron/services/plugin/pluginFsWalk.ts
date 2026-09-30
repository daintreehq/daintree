import type { Dirent } from "fs";
import * as path from "path";
import { PLUGIN_INVOKE_MAX_RESULT_BYTES } from "../../../shared/config/pluginBudgets.js";
import type { PluginFsWalkEntry, PluginFsWalkResult } from "../../../shared/types/plugin.js";

export const PLUGIN_FS_WALK_DEFAULT_LIMIT = 10_000;
export const PLUGIN_FS_WALK_MAX_LIMIT = 50_000;
export const PLUGIN_FS_WALK_MAX_DEPTH = 64;
export const PLUGIN_FS_WALK_MAX_PATTERNS = 64;
const MAX_PATTERN_LENGTH = 1024;

/**
 * Result budget for one walk: half the invoke result cap, like `readFiles`, so
 * the reply still fits once relayed and re-encoded.
 */
export const PLUGIN_FS_WALK_MAX_RESULT_BYTES = PLUGIN_INVOKE_MAX_RESULT_BYTES / 2;

/**
 * Directory entries examined in one walk, returned or not. Bounds the cost of
 * a narrow `include` over a huge tree; past it the result is truncated.
 */
export const PLUGIN_FS_WALK_MAX_VISITED = 200_000;

/** Per-entry envelope of the serialized result, beyond the path itself. */
const ENTRY_OVERHEAD_BYTES = 48;
const STAT_CONCURRENCY = 16;

export interface ValidatedWalkCall {
  include: string[] | null;
  exclude: string[];
  maxDepth: number;
  limit: number;
  respectGitignore: boolean;
  includeSize: boolean;
  signal: AbortSignal | undefined;
}

export function validateWalkCall(
  pluginId: string,
  root: unknown,
  options: unknown
): ValidatedWalkCall {
  const fail = (why: string): never => {
    throw new Error(`VALIDATION: plugin "${pluginId}" fs.walk: ${why}`);
  };
  if (typeof root !== "string" || root.length === 0) fail("root must be a non-empty string");
  if (options !== undefined && (options === null || typeof options !== "object")) {
    fail("options must be an object");
  }
  const opts = (options ?? {}) as Record<string, unknown>;
  const patterns = (name: string, value: unknown): string[] | null => {
    if (value === undefined) return null;
    if (!Array.isArray(value)) return fail(`${name} must be an array of glob strings`);
    const list = value as unknown[];
    if (list.length > PLUGIN_FS_WALK_MAX_PATTERNS) {
      fail(`${name} takes at most ${PLUGIN_FS_WALK_MAX_PATTERNS} patterns (got ${list.length})`);
    }
    for (const p of list) {
      if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATTERN_LENGTH) {
        fail(
          `every ${name} pattern must be a non-empty string of at most ${MAX_PATTERN_LENGTH} characters`
        );
      }
    }
    return list as string[];
  };
  const integer = (name: string, value: unknown, min: number, max: number, fallback: number) => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      return fail(`${name} must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  const flag = (name: string, value: unknown, fallback: boolean): boolean => {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") return fail(`${name} must be a boolean`);
    return value;
  };
  const signal = opts.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal))
    fail("signal must be an AbortSignal");
  return {
    include: patterns("include", opts.include),
    exclude: patterns("exclude", opts.exclude) ?? [],
    maxDepth: integer(
      "maxDepth",
      opts.maxDepth,
      1,
      PLUGIN_FS_WALK_MAX_DEPTH,
      PLUGIN_FS_WALK_MAX_DEPTH
    ),
    limit: integer("limit", opts.limit, 1, PLUGIN_FS_WALK_MAX_LIMIT, PLUGIN_FS_WALK_DEFAULT_LIMIT),
    respectGitignore: flag("respectGitignore", opts.respectGitignore, true),
    includeSize: flag("includeSize", opts.includeSize, false),
    signal: signal as AbortSignal | undefined,
  };
}

/**
 * Glob tests (one pattern against one path) one walk may run. `matchesGlob`
 * compiles its pattern on every call, so this bounds the synchronous CPU a
 * wide pattern list over a large tree costs the main process; past it the
 * result is truncated.
 */
export const PLUGIN_FS_WALK_MAX_GLOB_TESTS = 1_000_000;

/** Entries processed between yields to the event loop. */
const YIELD_EVERY = 2_048;

/** The filesystem and git operations a walk performs, injectable for tests. */
export interface WalkIo {
  readdir(dir: string): Promise<Dirent[]>;
  realpath(dir: string): Promise<string>;
  /** A file's size, or `undefined` when it can no longer be stat'ed. */
  fileSize(file: string): Promise<number | undefined>;
  /**
   * Which of the absolute `paths` (all under `cwd`) git ignores and does not
   * track. Rejects when `cwd` is not in a repository or git is unavailable,
   * which turns ignore filtering off for the rest of the walk.
   */
  checkIgnored(cwd: string, paths: string[], signal: AbortSignal | undefined): Promise<Set<string>>;
  /**
   * Whether the repository holds a tracked file that also matches an ignore
   * rule. On a case-insensitive filesystem git can then report that file as
   * ignored under its on-disk spelling, so ignore filtering is turned off
   * rather than risk dropping a tracked file. Omit where that cannot happen.
   */
  hasTrackedIgnored?(cwd: string, signal: AbortSignal | undefined): Promise<boolean>;
  /** Give the event loop a turn. Defaults to `setImmediate`. */
  yieldNow?(): Promise<void>;
}

interface Candidate {
  abs: string;
  rel: string;
  type: "file" | "dir";
}

/** Sort by path with `/` ordering before every other character, so a directory's contents follow it. */
function comparePaths(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const ca = a.charCodeAt(i);
    const cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (ca === 47) return -1;
    if (cb === 47) return 1;
    return ca - cb;
  }
  return a.length - b.length;
}

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Walk `root` — already contained and realpath-resolved by the caller —
 * breadth-first, one directory level at a time. `checkpoint` runs before each
 * directory read and throws to stop the walk (the plugin unloaded).
 *
 * Confinement: directory entries are classified by `readdir`'s own type, so a
 * symbolic link is never followed (nor listed). Each directory is realpath'd
 * immediately before and after it is read, and its listing is dropped unless
 * both still resolve to the path it was reached at, so a directory swapped for
 * a link is not entered. Node offers no descriptor-relative directory reads,
 * so a swap and swap back between those checks is not excluded — the same
 * honest limit `readdir` documents.
 *
 * Cost: bounded by the entry `limit`, the result byte budget, a cap on entries
 * examined and on glob tests, with a yield to the event loop every few
 * thousand entries so a large walk never holds the main process.
 */
export async function runWalk(
  root: string,
  call: ValidatedWalkCall,
  io: WalkIo,
  checkpoint: () => void,
  budgets: { maxVisited?: number; maxGlobTests?: number } = {}
): Promise<PluginFsWalkResult> {
  const maxVisited = budgets.maxVisited ?? PLUGIN_FS_WALK_MAX_VISITED;
  const maxGlobTests = budgets.maxGlobTests ?? PLUGIN_FS_WALK_MAX_GLOB_TESTS;
  const { include, exclude, maxDepth, limit, signal } = call;
  const yieldNow = io.yieldNow ?? defaultYield;
  let ignoreActive = call.respectGitignore;
  let hazardChecked = false;
  const entries: Array<{ path: string; type: "file" | "dir"; abs: string }> = [];
  let bytes = 0;
  let visited = 0;
  let globTests = 0;
  let sinceYield = 0;
  let truncated = false;
  let level: Array<{ abs: string; rel: string }> = [{ abs: root, rel: "" }];

  const pause = async (): Promise<void> => {
    if (++sinceYield < YIELD_EVERY) return;
    sinceYield = 0;
    await yieldNow();
    signal?.throwIfAborted();
    checkpoint();
  };
  // null: the glob budget is spent, and the walk must stop.
  const matchesAny = (patterns: readonly string[], rel: string): boolean | null => {
    for (const pattern of patterns) {
      if (++globTests > maxGlobTests) return null;
      if (path.posix.matchesGlob(rel, pattern)) return true;
    }
    return false;
  };
  const stillAt = async (dir: string): Promise<boolean> =>
    (await io.realpath(dir).catch(() => null)) === dir;

  walk: for (let depth = 1; depth <= maxDepth && level.length > 0; depth++) {
    const candidates: Candidate[] = [];
    let lastLevel = false;
    collect: for (const dir of level) {
      signal?.throwIfAborted();
      checkpoint();
      const isRoot = dir.rel === "";
      if (!isRoot && !(await stillAt(dir.abs))) continue;
      let dirents: Dirent[];
      try {
        dirents = await io.readdir(dir.abs);
      } catch (error) {
        // The root failing is the call failing; a subdirectory that vanished
        // or cannot be read is left out.
        if (isRoot) throw error;
        continue;
      }
      signal?.throwIfAborted();
      if (!(await stillAt(dir.abs))) {
        if (isRoot) throw new Error("TARGET_UNAVAILABLE: the walk root moved while it was read");
        continue;
      }
      if (ignoreActive && !isRoot && dirents.some((d) => d.name === ".git")) {
        // A nested repository or submodule: listed, not entered — the outer
        // repository's ignore rules do not describe its contents.
        continue;
      }
      dirents.sort((a, b) => comparePaths(a.name, b.name));
      for (const dirent of dirents) {
        if (++visited > maxVisited) {
          // Keep what was collected; nothing past this point is examined.
          truncated = true;
          lastLevel = true;
          break collect;
        }
        await pause();
        if (ignoreActive && dirent.name === ".git") continue;
        const type = dirent.isDirectory() ? "dir" : dirent.isFile() ? "file" : null;
        if (type === null) continue;
        const rel = isRoot ? dirent.name : `${dir.rel}/${dirent.name}`;
        if (exclude.length > 0) {
          const excluded = matchesAny(exclude, rel);
          if (excluded === null) {
            truncated = true;
            lastLevel = true;
            break collect;
          }
          if (excluded) continue;
        }
        candidates.push({ abs: path.join(dir.abs, dirent.name), rel, type });
      }
    }

    if (ignoreActive && !hazardChecked && candidates.length > 0 && io.hasTrackedIgnored) {
      hazardChecked = true;
      try {
        if (await io.hasTrackedIgnored(root, signal)) ignoreActive = false;
      } catch {
        signal?.throwIfAborted();
        ignoreActive = false;
      }
      checkpoint();
    }
    let ignored: Set<string> | null = null;
    if (ignoreActive && candidates.length > 0) {
      try {
        ignored = await io.checkIgnored(
          root,
          candidates.map((c) => c.abs),
          signal
        );
      } catch {
        signal?.throwIfAborted();
        // Not a repository, or git is unavailable: nothing to respect.
        ignoreActive = false;
      }
      checkpoint();
    }

    const next: Array<{ abs: string; rel: string }> = [];
    for (const candidate of candidates) {
      if (ignored?.has(candidate.abs)) continue;
      await pause();
      if (candidate.type === "dir" && depth < maxDepth) {
        next.push({ abs: candidate.abs, rel: candidate.rel });
      }
      if (include !== null) {
        const included = matchesAny(include, candidate.rel);
        if (included === null) {
          truncated = true;
          break walk;
        }
        if (!included) continue;
      }
      const cost = Buffer.byteLength(candidate.rel, "utf8") + ENTRY_OVERHEAD_BYTES;
      if (entries.length >= limit || bytes + cost > PLUGIN_FS_WALK_MAX_RESULT_BYTES) {
        truncated = true;
        break walk;
      }
      bytes += cost;
      entries.push({ path: candidate.rel, type: candidate.type, abs: candidate.abs });
    }
    if (lastLevel) break;
    level = next;
  }

  const out: PluginFsWalkEntry[] = entries.map((e) => ({ path: e.path, type: e.type }));
  if (call.includeSize) {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const index = cursor++;
        const entry = entries[index]!;
        if (entry.type !== "file") continue;
        signal?.throwIfAborted();
        const size = await io.fileSize(entry.abs);
        if (size !== undefined) out[index] = { path: entry.path, type: "file", size };
      }
    };
    await Promise.all(Array.from({ length: STAT_CONCURRENCY }, worker));
    checkpoint();
  }
  signal?.throwIfAborted();
  out.sort((a, b) => comparePaths(a.path, b.path));
  return { entries: out, truncated };
}
