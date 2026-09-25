import { lstat, readFile, readdir, rm, stat } from "fs/promises";
import { dirname, resolve as pathResolve } from "path";
import { withTimeout } from "../utils/withTimeout.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

/**
 * Whether git's own `worktree prune` would remove an administrative entry.
 *
 * `eligible` carries the checkout path the entry's `gitdir` pointer names, when
 * it names one. `unknown` is a probe that failed — a permission error, a
 * timeout, a dead mount — and must never be read as either answer.
 */
export type WorktreeAdminEligibility =
  | { kind: "eligible"; worktreePath?: string }
  | { kind: "ineligible" }
  | { kind: "unknown"; reason: string };

/** An eligible entry the sweep kept because removing it would lose commits. */
export interface RetainedWorktreeAdminEntry {
  adminDir: string;
  worktreePath?: string;
  /** What is at stake, phrased by the caller's inventory. */
  loss: string;
}

export interface WorktreeAdminSweepResult {
  /** False when the registry itself could not be read, so nothing was assessed. */
  complete: boolean;
  removed: string[];
  retained: RetainedWorktreeAdminEntry[];
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function describeProbeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code ?? formatErrorMessage(error, "probe failed");
}

/**
 * Mirrors git's `should_prune_worktree`: an entry is prunable when it is not
 * locked and its `gitdir` file is absent, empty, or points at a location that
 * no longer exists. Stricter than git wherever a probe fails — git prunes an
 * unreadable `gitdir`, this answers `unknown` and the entry is left alone.
 */
export async function classifyWorktreeAdminEntry(
  adminDir: string,
  timeoutMs: number
): Promise<WorktreeAdminEligibility> {
  try {
    const info = await withTimeout(lstat(adminDir), timeoutMs, `worktree entry probe: ${adminDir}`);
    // A symlinked entry is not one git created, and following it would put the
    // removal below somewhere outside the registry.
    if (!info.isDirectory()) return { kind: "ineligible" };
  } catch (error) {
    return isMissing(error)
      ? { kind: "ineligible" }
      : { kind: "unknown", reason: describeProbeError(error) };
  }

  try {
    await withTimeout(
      lstat(pathResolve(adminDir, "locked")),
      timeoutMs,
      `worktree lock probe: ${adminDir}`
    );
    return { kind: "ineligible" };
  } catch (error) {
    if (!isMissing(error)) return { kind: "unknown", reason: describeProbeError(error) };
  }

  let pointer: string;
  try {
    pointer = (
      await withTimeout(
        readFile(pathResolve(adminDir, "gitdir"), "utf-8"),
        timeoutMs,
        `worktree pointer read: ${adminDir}`
      )
    ).trim();
  } catch (error) {
    return isMissing(error)
      ? { kind: "eligible" }
      : { kind: "unknown", reason: describeProbeError(error) };
  }
  if (!pointer) return { kind: "eligible" };

  // Relative to the entry directory, which is what `worktree.useRelativePaths`
  // writes these against (git 2.48+); an absolute pointer discards the base.
  const target = pathResolve(adminDir, pointer);
  try {
    await withTimeout(stat(target), timeoutMs, `worktree checkout probe: ${target}`);
    return { kind: "ineligible" };
  } catch (error) {
    return isMissing(error)
      ? { kind: "eligible", worktreePath: dirname(target) }
      : { kind: "unknown", reason: describeProbeError(error) };
  }
}

/**
 * The per-entry replacement for an unqualified `git worktree prune`.
 *
 * Prune has no way to be scoped: it removes every eligible `<common>/worktrees/<id>`
 * recursively, `modules/` and all, and a module store there can hold the only
 * copy of a commit. So each eligible entry is inventoried on its own, and only
 * the ones whose inventory comes back clean are removed. The registry is read
 * directly rather than through `worktree list --porcelain`, which omits entries
 * whose `gitdir` file is missing or garbage — exactly the entries prune removes
 * without showing them to anyone.
 *
 * `assessLoss` answers `null` when nothing would be lost and a description of
 * the loss otherwise, including "could not be inspected". Eligibility is asked
 * again immediately before each removal because an inventory can take long
 * enough for the checkout to come back or for `git worktree add` to reuse the id.
 */
export async function sweepWorktreeAdminEntries(options: {
  commonDir: string;
  timeoutMs: number;
  assessLoss: (adminDir: string) => Promise<string | null>;
  onUnknown?: (adminDir: string, reason: string) => void;
  onRemoveFailed?: (adminDir: string, error: unknown) => void;
}): Promise<WorktreeAdminSweepResult> {
  const { commonDir, timeoutMs, assessLoss, onUnknown, onRemoveFailed } = options;
  const registry = pathResolve(commonDir, "worktrees");
  const result: WorktreeAdminSweepResult = { complete: true, removed: [], retained: [] };

  let names: string[];
  try {
    const dirents = await withTimeout(
      readdir(registry, { withFileTypes: true }),
      timeoutMs,
      `worktree registry scan: ${registry}`
    );
    names = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (error) {
    if (isMissing(error)) return result;
    onUnknown?.(registry, describeProbeError(error));
    return { ...result, complete: false };
  }

  for (const name of names) {
    const adminDir = pathResolve(registry, name);
    const before = await classifyWorktreeAdminEntry(adminDir, timeoutMs);
    if (before.kind === "unknown") onUnknown?.(adminDir, before.reason);
    if (before.kind !== "eligible") continue;

    const loss = await assessLoss(adminDir);
    if (loss) {
      result.retained.push({ adminDir, worktreePath: before.worktreePath, loss });
      continue;
    }

    const after = await classifyWorktreeAdminEntry(adminDir, timeoutMs);
    if (after.kind === "unknown") onUnknown?.(adminDir, after.reason);
    if (after.kind !== "eligible") continue;

    try {
      await rm(adminDir, { recursive: true, force: true });
      result.removed.push(adminDir);
    } catch (error) {
      onRemoveFailed?.(adminDir, error);
    }
  }
  return result;
}
