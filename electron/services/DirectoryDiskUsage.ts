import { spawn, type ChildProcess } from "node:child_process";
import fsPromises from "node:fs/promises";
import type { BigIntStats, Dirent, Stats } from "node:fs";
import path from "node:path";

/**
 * Past this many `du` operands the frontier falls back to the walk rather than
 * splitting the list: separate `du` runs can't see each other's hard links, so
 * their totals would count a shared inode twice.
 */
export const MAX_DU_OPERANDS = 2_000;

/** Concurrent `lstat`s per directory in the walk. */
const WALK_STAT_BATCH = 32;

/**
 * Tries per measurement. A scan that races a change in the tree (a build
 * replacing its output, a directory renamed under it) fails rather than
 * reporting a partial total, and usually succeeds when run again.
 */
const ATTEMPTS = 2;

type Platform = NodeJS.Platform;

export interface MeasureDirectoryOptions {
  /** Nested roots that belong to someone else; never traversed or counted. */
  exclude?: readonly string[];
  signal?: AbortSignal;
  platform?: Platform;
}

/**
 * The bytes `root` occupies on disk, with `exclude`d subtrees left out, or
 * null when the figure couldn't be completed. A partial total is never
 * returned: an unreadable or vanished entry, a cancelled run or a failed `du`
 * all answer null (after one retry), so the caller can say "unknown" rather
 * than an undercount.
 *
 * POSIX runs `du` out of process, which keeps the traversal off this event
 * loop; Windows has no `du` and walks instead. Neither follows symlinks.
 */
export async function measureDirectorySize(
  root: string,
  options: MeasureDirectoryOptions = {}
): Promise<number | null> {
  const { signal } = options;
  const platform = options.platform ?? process.platform;
  const resolvedRoot = path.resolve(root);
  const exclude = nearestNestedRoots(resolvedRoot, options.exclude ?? [], platform);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (signal?.aborted) return null;
    const outcome = await measureOnce(resolvedRoot, exclude, platform, signal);
    if (outcome.kind === "measured") return outcome.bytes;
    if (outcome.kind === "final") return null;
  }
  return null;
}

/** `retry` when the scan may have raced a change in the tree; `final` when trying again can't help. */
type Outcome = { kind: "measured"; bytes: number } | { kind: "retry" } | { kind: "final" };

async function measureOnce(
  root: string,
  exclude: readonly string[],
  platform: Platform,
  signal: AbortSignal | undefined
): Promise<Outcome> {
  try {
    const stat = await fsPromises.lstat(root);
    if (!stat.isDirectory()) return { kind: "final" };
  } catch {
    return { kind: "final" };
  }

  const walk = async (): Promise<Outcome> => {
    const bytes = await walkDirectorySize(root, exclude, platform, signal);
    return bytes === null ? { kind: "retry" } : { kind: "measured", bytes };
  };
  if (platform === "win32") return walk();

  let frontier: Frontier | null;
  try {
    frontier = await buildFrontier(root, exclude, platform, signal);
  } catch {
    return { kind: "retry" };
  }
  if (signal?.aborted) return { kind: "final" };
  if (frontier === null) return walk();
  if (frontier.operands.length === 0) {
    return { kind: "measured", bytes: frontier.directoryBytes };
  }
  const du = await runDu(frontier.operands, signal);
  if (du.kind === "aborted") return { kind: "final" };
  if (du.kind === "failed") return { kind: "retry" };
  return { kind: "measured", bytes: du.kb * 1024 + frontier.directoryBytes };
}

function comparablePath(p: string, platform: Platform): string {
  return platform === "win32" ? p.toLowerCase() : p;
}

/** True when `child` is strictly inside `parent`, by path component. */
export function isStrictlyInside(parent: string, child: string, platform: Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const rel = pathApi.relative(comparablePath(parent, platform), comparablePath(child, platform));
  if (rel === "" || pathApi.isAbsolute(rel)) return false;
  // `..` as a whole component, not a name that starts with two dots.
  return rel !== ".." && !rel.startsWith(`..${pathApi.sep}`);
}

/**
 * The excluded roots inside `root`, collapsed to the outermost: a root nested
 * in another excluded root is already left out with its parent.
 */
function nearestNestedRoots(
  root: string,
  exclude: readonly string[],
  platform: Platform
): string[] {
  const inside = exclude
    .map((p) => path.resolve(p))
    .filter((p) => isStrictlyInside(root, p, platform));
  return inside.filter(
    (candidate) =>
      !inside.some((other) => other !== candidate && isStrictlyInside(other, candidate, platform))
  );
}

interface Frontier {
  /** Disjoint paths whose subtrees make up the root minus the excluded roots. */
  operands: string[];
  /**
   * The directories opened to reach an excluded root. They aren't operands, so
   * `du` never sees their own blocks; they are added back here.
   */
  directoryBytes: number;
}

function allocatedBytes(stat: Stats | BigIntStats, platform: Platform): number {
  if (platform === "win32") return Number(stat.size);
  return Number(stat.blocks) * 512;
}

/**
 * Expands only the directories on the way to an excluded root, so `du` is
 * handed every sibling subtree and never the excluded one. Null when the
 * operand list would outgrow {@link MAX_DU_OPERANDS}.
 */
async function buildFrontier(
  root: string,
  exclude: readonly string[],
  platform: Platform,
  signal: AbortSignal | undefined
): Promise<Frontier | null> {
  if (exclude.length === 0) return { operands: [root], directoryBytes: 0 };

  const operands: string[] = [];
  let directoryBytes = 0;
  const pending: Array<{ dir: string; exclude: string[] }> = [{ dir: root, exclude: [...exclude] }];

  while (pending.length > 0) {
    if (signal?.aborted) return null;
    const { dir, exclude: within } = pending.pop()!;
    directoryBytes += allocatedBytes(await fsPromises.lstat(dir), platform);
    const excluded = new Set(within.map((p) => comparablePath(p, platform)));
    const names = await fsPromises.readdir(dir);
    for (const name of names) {
      const full = path.join(dir, name);
      if (excluded.has(comparablePath(full, platform))) continue;
      const deeper = within.filter((p) => isStrictlyInside(full, p, platform));
      if (deeper.length > 0) {
        const stat = await fsPromises.lstat(full).catch(() => null);
        // A symlink on the way to an excluded root is an operand like any
        // other: `du` counts the link, not what it points at.
        if (stat?.isDirectory()) {
          pending.push({ dir: full, exclude: deeper });
          continue;
        }
      }
      operands.push(full);
      if (operands.length > MAX_DU_OPERANDS) return null;
    }
  }
  return { operands, directoryBytes };
}

type DuOutcome = { kind: "total"; kb: number } | { kind: "failed" } | { kind: "aborted" };

/** Enough of `du`'s output to hold its closing line; per-operand lines before it are dropped. */
const DU_TAIL_CHARS = 4096;

/**
 * One `du -skc` over every operand, so hard links shared between operands are
 * counted once, read from the grand-total line. BSD and GNU `du` agree on
 * `-s`, `-k` and `-c`; their exclusion flags don't, which is why exclusion is
 * done by choosing operands instead.
 *
 * Only a clean exit counts: `du` exits non-zero whenever it skipped something
 * — permission denied, an I/O error, or an entry that vanished between being
 * listed and being read — and its total then leaves out bytes that may still
 * be there. Settles only once the process has exited, so a caller holding a
 * concurrency slot doesn't release it while `du` is still reading the disk;
 * an abort kills it outright, since a read-only scan has nothing to clean up.
 */
function runDu(operands: readonly string[], signal: AbortSignal | undefined): Promise<DuOutcome> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ kind: "aborted" });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn("du", ["-skc", "--", ...operands], {
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve({ kind: "failed" });
      return;
    }
    let tail = "";
    let settled = false;
    const settle = (outcome: DuOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(signal?.aborted ? { kind: "aborted" } : outcome);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-DU_TAIL_CHARS);
    });
    child.on("error", () => {
      // Never started (no `du` on PATH): there will be no exit to wait for.
      if (child.pid === undefined) settle({ kind: "failed" });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        settle({ kind: "failed" });
        return;
      }
      const kb = parseDuGrandTotal(tail);
      settle(kb === null ? { kind: "failed" } : { kind: "total", kb });
    });
  });
}

/** The kilobytes on `du -c`'s closing `total` line, or null when it's absent or malformed. */
export function parseDuGrandTotal(stdout: string): number | null {
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");
  const last = lines.at(-1);
  if (!last) return null;
  const match = /^(\d+)\s+total$/.exec(last.trim());
  if (!match) return null;
  const kb = Number(match[1]);
  return Number.isSafeInteger(kb) && Number.isSafeInteger(kb * 1024) ? kb : null;
}

/**
 * The tree walked with `lstat`: Windows, where there is no `du`, and POSIX
 * trees whose frontier is too wide for one `du` call. Hard links are counted
 * once by device and inode; symlinks and junctions are counted as themselves
 * and never followed. Any entry that can't be read — vanished mid-walk
 * included, as with `du` — abandons the figure.
 */
async function walkDirectorySize(
  root: string,
  exclude: readonly string[],
  platform: Platform,
  signal: AbortSignal | undefined
): Promise<number | null> {
  const excluded = new Set(exclude.map((p) => comparablePath(p, platform)));
  const seenLinked = new Set<string>();
  const stack: string[] = [root];
  let total = 0;
  try {
    while (stack.length > 0) {
      if (signal?.aborted) return null;
      const dir = stack.pop()!;
      const entries: Dirent[] = await fsPromises.readdir(dir, { withFileTypes: true });
      const targets = entries
        .map((entry) => path.join(dir, entry.name))
        .filter((full) => !excluded.has(comparablePath(full, platform)));
      for (let i = 0; i < targets.length; i += WALK_STAT_BATCH) {
        if (signal?.aborted) return null;
        const batch = targets.slice(i, i + WALK_STAT_BATCH);
        // Settled, not raced: a failure must not leave sibling reads running
        // past the end of the measurement that started them.
        const settled = await Promise.allSettled(
          batch.map(async (full) => ({
            full,
            stat: await fsPromises.lstat(full, { bigint: true }),
          }))
        );
        const stats = [];
        for (const outcome of settled) {
          if (outcome.status === "rejected") return null;
          stats.push(outcome.value);
        }
        for (const { full, stat } of stats) {
          if (stat.isDirectory()) {
            stack.push(full);
            if (platform !== "win32") total += allocatedBytes(stat, platform);
            continue;
          }
          if (stat.nlink > 1n && stat.ino !== 0n) {
            const key = `${stat.dev}:${stat.ino}`;
            if (seenLinked.has(key)) continue;
            seenLinked.add(key);
          }
          total += allocatedBytes(stat, platform);
        }
      }
    }
  } catch {
    return null;
  }
  if (signal?.aborted) return null;
  if (platform !== "win32") {
    try {
      total += allocatedBytes(await fsPromises.lstat(root), platform);
    } catch {
      return null;
    }
  }
  return total;
}
