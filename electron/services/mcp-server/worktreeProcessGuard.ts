import { realpath } from "node:fs/promises";
import type { ActionError } from "../../../shared/types/actions.js";
import { isPathInside, pathComparisonKey } from "../../../shared/utils/path.js";

/** The owned delete this guard stands in front of (#15729). */
export const WORKTREE_DELETE_OWNED_TOOL = "worktree.deleteOwned";

/** The fields of a pty-host terminal record the guard reads. */
export interface TerminalProcessRecord {
  id: string;
  worktreeId?: string;
  /** Where the process was spawned. The host does not follow a later `cd`. */
  cwd?: string;
  isExited?: boolean;
  isTrashed?: boolean;
  trashExpiresAt?: number;
  /** The incarnation running under the id, as main tracks it. */
  launchGeneration?: number;
}

/** What the calling session is to a running terminal, as far as main has a record of it. */
export interface TerminalAttribution {
  /** On record as launched by this session: the run now under the id, not an earlier one. */
  createdByThisSession: boolean;
  /** `terminal.closeOwned` would close it for this session. */
  closableByThisSession: boolean;
}

/** A terminal the refusal names. */
export interface WorktreeLiveTerminal extends TerminalAttribution {
  terminalId: string;
  /** Closed and in its trash grace, with the process running until it exits or the grace ends. */
  trashed: boolean;
  trashExpiresAt: number | null;
}

export interface WorktreeMatchOptions {
  caseInsensitive: boolean;
  /** A directory's canonical spelling; rejects for one that is gone. */
  realpath: (path: string) => Promise<string>;
  /**
   * How long resolving spawn directories through symlinks may take. A stale
   * network mount can leave a resolution pending indefinitely, and the delete
   * must not wait on it.
   */
  resolveDeadlineMs: number;
}

export const HOST_MATCH_OPTIONS: WorktreeMatchOptions = {
  caseInsensitive: process.platform === "win32",
  realpath: (path) => realpath(path),
  resolveDeadlineMs: 2_000,
};

/** What a census of the worktree found, and whether every terminal could be placed. */
export interface WorktreeCensus {
  terminals: TerminalProcessRecord[];
  /** False when resolving some spawn directory ran out of time, so a terminal may be missing. */
  complete: boolean;
}

function matches(
  record: TerminalProcessRecord,
  cwd: string | undefined,
  roots: readonly string[],
  options: WorktreeMatchOptions
): boolean {
  if (
    typeof record.worktreeId === "string" &&
    roots.includes(pathComparisonKey(record.worktreeId, options))
  ) {
    return true;
  }
  if (typeof cwd !== "string" || cwd.length === 0) return false;
  const key = pathComparisonKey(cwd, options);
  return roots.some((root) => isPathInside(key, root));
}

async function withinDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every terminal the pty host holds whose process has not exited and that sits
 * in the worktree: attributed to it, or spawned inside its directory. Both,
 * because a pane moved to another worktree keeps the directory it started in,
 * and a terminal spawned with an explicit cwd may be attributed elsewhere. One
 * that reaches the worktree only through a symlink, in its own spawn directory
 * or in the worktree's path, is matched on the canonical spellings, resolved
 * only for terminals the plain spelling did not already place.
 *
 * Anything short of a reported exit counts as running: a kill still waiting
 * on its exit, and a record that never said. Agent state, panel kind and the
 * assistant overlay are deliberately not consulted; a process is a process.
 * An id reported more than once, as two shards can during a move, is named
 * once, and any of its records placing it in the worktree is enough.
 */
export async function liveTerminalsInWorktree(
  records: readonly TerminalProcessRecord[],
  worktreeId: string,
  options: WorktreeMatchOptions
): Promise<WorktreeCensus> {
  return terminalsInWorktree(
    records.filter((record) => record.isExited !== true),
    worktreeId,
    options
  );
}

/**
 * Every one of `records` that sits in the worktree, by the rules
 * {@link liveTerminalsInWorktree} describes, exited or not. A retirement
 * (#15737) reads the caller's own exited panes from it too, since those are
 * panes it closes even though no process holds the directory.
 */
export async function terminalsInWorktree(
  records: readonly TerminalProcessRecord[],
  worktreeId: string,
  options: WorktreeMatchOptions
): Promise<WorktreeCensus> {
  const root = pathComparisonKey(worktreeId, options);
  const placed = new Set(records.filter((record) => matches(record, record.cwd, [root], options)));
  const unplaced = records.filter((record) => !placed.has(record));
  let complete = true;
  if (unplaced.length > 0) {
    const resolved = await withinDeadline(
      (async () => {
        const canonicalRoot = pathComparisonKey(
          await options.realpath(worktreeId).catch(() => worktreeId),
          options
        );
        const roots = canonicalRoot === root ? [root] : [root, canonicalRoot];
        return Promise.all(
          unplaced.map(async (record) => {
            const cwd = record.cwd;
            const canonicalCwd =
              typeof cwd === "string" && cwd.length > 0
                ? await options.realpath(cwd).catch(() => cwd)
                : cwd;
            return matches(record, canonicalCwd, roots, options);
          })
        );
      })(),
      options.resolveDeadlineMs
    );
    if (resolved === undefined) complete = false;
    else unplaced.forEach((record, index) => resolved[index] && placed.add(record));
  }
  const named = new Set<string>();
  const terminals = records.filter((record) => {
    if (!placed.has(record) || named.has(record.id)) return false;
    named.add(record.id);
    return true;
  });
  return { terminals, complete };
}

export function describeTerminal(terminal: WorktreeLiveTerminal): string {
  const parts = [
    terminal.createdByThisSession
      ? "created by this session"
      : "not recorded as created by this session",
  ];
  if (terminal.trashed) parts.push("closed and still in its trash grace");
  else if (terminal.createdByThisSession && !terminal.closableByThisSession) {
    parts.push("no longer closable by it");
  }
  return `'${terminal.terminalId}' (${parts.join(", ")})`;
}

/**
 * Why an owned worktree delete must not run yet, or `undefined` when no
 * terminal process is left in it (#15729).
 *
 * Read from the pty host rather than any window's panel list, so the answer is
 * the same on a host with no window open. A read that fails, or that reaches
 * only some of the host's shards, refuses: an empty list from a host that did
 * not answer is not evidence that nothing runs.
 *
 * The refusal names every running terminal, including ones the caller does not
 * own. It is only reached after the caller's ownership of the worktree was
 * confirmed, so it lists the contents of something the caller already holds,
 * never an id it probed for. Its advice follows what the caller can do about
 * each one: close it, wait for it, or leave it to whoever runs it.
 */
export async function refuseWorktreeDeleteWhileRunning(
  worktreeId: string,
  readTerminalProcesses: (() => Promise<readonly TerminalProcessRecord[]>) | undefined,
  attribute: (terminalId: string, launchGeneration: number | undefined) => TerminalAttribution,
  options: WorktreeMatchOptions = HOST_MATCH_OPTIONS
): Promise<ActionError | undefined> {
  const unconfirmed: ActionError = {
    code: "EXECUTION_ERROR",
    message:
      `Worktree '${worktreeId}' was not deleted: which terminal processes are running in it ` +
      `could not be confirmed, so nothing was removed. Try again shortly.`,
    details: { reason: "terminal-processes-unreadable", worktreeId },
  };
  let records: readonly TerminalProcessRecord[];
  try {
    if (readTerminalProcesses === undefined) throw new Error("No terminal host reader.");
    records = await readTerminalProcesses();
  } catch {
    return unconfirmed;
  }
  const { terminals: live, complete } = await liveTerminalsInWorktree(records, worktreeId, options);
  // A partial census that already found something running still refuses on
  // what it found; one that found nothing proves nothing.
  if (live.length === 0) return complete ? undefined : unconfirmed;
  const terminals: WorktreeLiveTerminal[] = live.map((record) => {
    const trashed = record.isTrashed === true;
    const { createdByThisSession, closableByThisSession } = attribute(
      record.id,
      record.launchGeneration
    );
    return {
      terminalId: record.id,
      createdByThisSession,
      closableByThisSession,
      trashed,
      trashExpiresAt:
        trashed && typeof record.trashExpiresAt === "number" ? record.trashExpiresAt : null,
    };
  });
  const closable = (terminal: WorktreeLiveTerminal) =>
    terminal.closableByThisSession && !terminal.trashed;
  const awaited = (terminal: WorktreeLiveTerminal) =>
    terminal.createdByThisSession && terminal.trashed;
  const advice = [
    terminals.some(closable)
      ? "Close this session's open terminals with 'terminal.closeOwned', then wait for their processes to exit."
      : terminals.some(awaited)
        ? "Wait for this session's closed terminals to exit."
        : undefined,
    terminals.some((terminal) => !closable(terminal) && !awaited(terminal))
      ? "Terminals this session has no record of controlling are not its to stop."
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const count =
    terminals.length === 1
      ? "a terminal in it still has a running process"
      : `${terminals.length} terminals in it still have running processes`;
  return {
    code: "DISABLED",
    message: [
      `Worktree '${worktreeId}' was not deleted: ${count}: ${terminals.map(describeTerminal).join(", ")}.`,
      ...advice,
    ].join(" "),
    details: { reason: "worktree-has-running-terminals", worktreeId, terminals },
  };
}

/** The pty-host reads {@link readPtyTerminalProcesses} needs. */
export interface PtyTerminalProcessSource {
  getAllTerminalsWithCompletenessAsync(): Promise<{
    terminals: ReadonlyArray<TerminalProcessRecord>;
    degraded: boolean;
  }>;
  getLiveGeneration(terminalId: string): number | null;
}

/**
 * Every terminal record the pty host holds, trashed ones included, for
 * {@link refuseWorktreeDeleteWhileRunning}. Rejects when the host is missing
 * or any shard failed to answer, so a partial census never reads as a
 * complete one.
 *
 * The generation is main's own for the running incarnation, the one
 * `workerCreations` was noted against, so a respawn under a reused id is never
 * attributed to the session that created the earlier run. Main stops tracking
 * a run once it exits, so an exited record keeps the generation the host
 * adopted from main's ledger for that run (#15737): without it, a pane the
 * person restarted and that then exited would be credited by the ledger alone.
 */
export async function readPtyTerminalProcesses(
  client: PtyTerminalProcessSource | null
): Promise<TerminalProcessRecord[]> {
  if (client === null) throw new Error("The pty host is not available.");
  const { terminals, degraded } = await client.getAllTerminalsWithCompletenessAsync();
  if (degraded) throw new Error("A pty host shard did not answer.");
  return terminals.map((terminal) => {
    const launchGeneration =
      client.getLiveGeneration(terminal.id) ??
      (terminal.isExited === true ? (terminal.launchGeneration ?? null) : null);
    return {
      id: terminal.id,
      ...(terminal.worktreeId !== undefined ? { worktreeId: terminal.worktreeId } : {}),
      ...(terminal.cwd !== undefined ? { cwd: terminal.cwd } : {}),
      ...(terminal.isExited !== undefined ? { isExited: terminal.isExited } : {}),
      ...(terminal.isTrashed !== undefined ? { isTrashed: terminal.isTrashed } : {}),
      ...(terminal.trashExpiresAt !== undefined ? { trashExpiresAt: terminal.trashExpiresAt } : {}),
      ...(launchGeneration !== null ? { launchGeneration } : {}),
    };
  });
}
