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

/** What the calling session is to a running terminal. */
export interface TerminalAttribution {
  /** This session launched the run now under the id. */
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
}

const HOST_MATCH_OPTIONS: WorktreeMatchOptions = {
  caseInsensitive: process.platform === "win32",
  realpath: (path) => realpath(path),
};

function cwdInside(cwd: string, roots: readonly string[], options: WorktreeMatchOptions): boolean {
  const key = pathComparisonKey(cwd, options);
  return roots.some((root) => isPathInside(key, root));
}

/**
 * Every terminal the pty host holds whose process has not exited and that sits
 * in the worktree: attributed to it, or spawned inside its directory. Both,
 * because a pane moved to another worktree keeps the directory it started in,
 * and a terminal spawned with an explicit cwd may be attributed elsewhere. A
 * spawn directory that only reaches the worktree through a symlink is matched
 * on its canonical spelling.
 *
 * Anything short of a reported exit counts as running: a kill still waiting
 * on its exit, and a record that never said. Agent state, panel kind and the
 * assistant overlay are deliberately not consulted; a process is a process.
 * One id reported twice, as two shards can during a move, is named once.
 */
export async function liveTerminalsInWorktree(
  records: readonly TerminalProcessRecord[],
  worktreeId: string,
  options: WorktreeMatchOptions
): Promise<TerminalProcessRecord[]> {
  const canonicalRoot = await options.realpath(worktreeId).catch(() => worktreeId);
  const roots = [
    ...new Set([worktreeId, canonicalRoot].map((path) => pathComparisonKey(path, options))),
  ];
  const seen = new Set<string>();
  const live = records.filter((record) => {
    if (record.isExited === true || seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
  const matched = await Promise.all(
    live.map(async (record) => {
      if (
        typeof record.worktreeId === "string" &&
        roots.includes(pathComparisonKey(record.worktreeId, options))
      ) {
        return true;
      }
      const cwd = record.cwd;
      if (typeof cwd !== "string" || cwd.length === 0) return false;
      if (cwdInside(cwd, roots, options)) return true;
      const canonicalCwd = await options.realpath(cwd).catch(() => cwd);
      return canonicalCwd !== cwd && cwdInside(canonicalCwd, roots, options);
    })
  );
  return live.filter((_, index) => matched[index]);
}

function describeTerminal(terminal: WorktreeLiveTerminal): string {
  const parts = [
    terminal.createdByThisSession ? "created by this session" : "not created by this session",
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
  let records: readonly TerminalProcessRecord[];
  try {
    if (readTerminalProcesses === undefined) throw new Error("No terminal host reader.");
    records = await readTerminalProcesses();
  } catch {
    return {
      code: "EXECUTION_ERROR",
      message:
        `Worktree '${worktreeId}' was not deleted: the terminal host could not report which ` +
        `processes are running in it, so nothing was removed. Try again shortly.`,
      details: { reason: "terminal-processes-unreadable", worktreeId },
    };
  }
  const live = await liveTerminalsInWorktree(records, worktreeId, options);
  if (live.length === 0) return undefined;
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
      ? "Terminals this session did not create, or no longer controls, are not its to stop."
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
 * attributed to the session that created the earlier run.
 */
export async function readPtyTerminalProcesses(
  client: PtyTerminalProcessSource | null
): Promise<TerminalProcessRecord[]> {
  if (client === null) throw new Error("The pty host is not available.");
  const { terminals, degraded } = await client.getAllTerminalsWithCompletenessAsync();
  if (degraded) throw new Error("A pty host shard did not answer.");
  return terminals.map((terminal) => {
    const launchGeneration = client.getLiveGeneration(terminal.id);
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
