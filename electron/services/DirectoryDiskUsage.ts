import { execFile } from "node:child_process";
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
 * returned: an unreadable directory, a cancelled run or a failed `du` all
 * answer null, so the caller can say "unknown" rather than an undercount.
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
  if (signal?.aborted) return null;
  const resolvedRoot = path.resolve(root);
  try {
    const stat = await fsPromises.lstat(resolvedRoot);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  const exclude = nearestNestedRoots(resolvedRoot, options.exclude ?? [], platform);

  if (platform === "win32") {
    return walkDirectorySize(resolvedRoot, exclude, platform, signal);
  }

  let frontier: Frontier | null;
  try {
    frontier = await buildFrontier(resolvedRoot, exclude, platform, signal);
  } catch {
    return null;
  }
  if (signal?.aborted) return null;
  if (frontier === null) {
    return walkDirectorySize(resolvedRoot, exclude, platform, signal);
  }
  if (frontier.operands.length === 0) return frontier.directoryBytes;
  const duBytes = await runDu(frontier.operands, signal);
  if (duBytes === null) return null;
  return duBytes + frontier.directoryBytes;
}

function comparablePath(p: string, platform: Platform): string {
  return platform === "win32" ? p.toLowerCase() : p;
}

/** True when `child` is strictly inside `parent`, by path component. */
export function isStrictlyInside(parent: string, child: string, platform: Platform): boolean {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const rel = pathApi.relative(comparablePath(parent, platform), comparablePath(child, platform));
  return rel !== "" && !rel.startsWith("..") && !pathApi.isAbsolute(rel);
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

/** stderr lines `du` writes when an entry vanished mid-scan (`LC_ALL=C`). */
const VANISHED_ENTRY_LINE = /No such file or directory$/;

/**
 * One `du -skc` over every operand, so hard links shared between operands are
 * counted once, read from the grand-total line. BSD and GNU `du` agree on
 * `-s`, `-k` and `-c`; their exclusion flags don't, which is why exclusion is
 * done by choosing operands instead.
 *
 * A non-zero exit is accepted only when every complaint is an entry that
 * vanished mid-scan — a worktree with a build running churns files, and a file
 * that's gone takes no space. Anything else (permission denied, an I/O error)
 * means part of the tree went uncounted, and the answer is null.
 */
function runDu(
  operands: readonly string[],
  signal: AbortSignal | undefined
): Promise<number | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    execFile(
      "du",
      ["-skc", "--", ...operands],
      {
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
        signal,
        killSignal: "SIGKILL",
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (signal?.aborted) {
          resolve(null);
          return;
        }
        const totalKb = parseDuGrandTotal(String(stdout));
        if (totalKb === null) {
          resolve(null);
          return;
        }
        if (error) {
          const exitedNonZero = typeof (error as { code?: unknown }).code === "number";
          const complaints = String(stderr)
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const onlyVanished =
            complaints.length > 0 && complaints.every((line) => VANISHED_ENTRY_LINE.test(line));
          if (!exitedNonZero || !onlyVanished) {
            resolve(null);
            return;
          }
        }
        resolve(totalKb * 1024);
      }
    );
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

function isVanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The tree walked with `lstat`: Windows, where there is no `du`, and POSIX
 * trees whose frontier is too wide for one `du` call. Hard links are counted
 * once by device and inode; symlinks and junctions are counted as themselves
 * and never followed. An entry that vanished mid-walk is skipped; any other
 * failure abandons the figure.
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
      let entries: Dirent[];
      try {
        entries = await fsPromises.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (dir !== root && isVanished(error)) continue;
        return null;
      }
      const targets = entries
        .map((entry) => ({ entry, full: path.join(dir, entry.name) }))
        .filter(({ full }) => !excluded.has(comparablePath(full, platform)));
      for (let i = 0; i < targets.length; i += WALK_STAT_BATCH) {
        if (signal?.aborted) return null;
        const batch = targets.slice(i, i + WALK_STAT_BATCH);
        const stats = await Promise.all(
          batch.map(({ full }) =>
            fsPromises.lstat(full, { bigint: true }).catch((error: unknown) => {
              if (isVanished(error)) return null;
              throw error;
            })
          )
        );
        stats.forEach((stat, index) => {
          if (!stat) return;
          if (stat.isDirectory()) {
            stack.push(batch[index].full);
            if (platform !== "win32") total += allocatedBytes(stat, platform);
            return;
          }
          if (stat.nlink > 1n && stat.ino !== 0n) {
            const key = `${stat.dev}:${stat.ino}`;
            if (seenLinked.has(key)) return;
            seenLinked.add(key);
          }
          total += allocatedBytes(stat, platform);
        });
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
