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

/** A terminal the refusal names. */
export interface WorktreeLiveTerminal {
  terminalId: string;
  /** Recorded as created by the calling session, so its exit is the caller's to wait for. */
  createdByThisSession: boolean;
  /** Closed and in its trash grace, with the process still running until it exits or expires. */
  trashed: boolean;
  trashExpiresAt: number | null;
}

/**
 * Every terminal the pty host holds whose process has not exited and that sits
 * in the worktree: attributed to it, or spawned inside its directory. Both,
 * because a pane moved to another worktree keeps the directory it started in,
 * and a terminal spawned with an explicit cwd may be attributed elsewhere.
 *
 * Anything short of a reported exit counts as running: a kill still waiting
 * on its exit, and a record that never said. Agent state, panel kind and the
 * assistant overlay are deliberately not consulted; a process is a process.
 */
export function liveTerminalsInWorktree(
  records: readonly TerminalProcessRecord[],
  worktreeId: string,
  options: { caseInsensitive: boolean }
): TerminalProcessRecord[] {
  const target = pathComparisonKey(worktreeId, options);
  return records.filter((record) => {
    if (record.isExited === true) return false;
    if (
      typeof record.worktreeId === "string" &&
      pathComparisonKey(record.worktreeId, options) === target
    ) {
      return true;
    }
    return (
      typeof record.cwd === "string" &&
      record.cwd.length > 0 &&
      isPathInside(pathComparisonKey(record.cwd, options), target)
    );
  });
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
 * never an id it probed for.
 */
export async function refuseWorktreeDeleteWhileRunning(
  worktreeId: string,
  readTerminalProcesses: (() => Promise<readonly TerminalProcessRecord[]>) | undefined,
  createdByThisSession: (terminalId: string, launchGeneration: number | undefined) => boolean,
  options: { caseInsensitive: boolean } = { caseInsensitive: process.platform === "win32" }
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
  const live = liveTerminalsInWorktree(records, worktreeId, options);
  if (live.length === 0) return undefined;
  const terminals: WorktreeLiveTerminal[] = live.map((record) => {
    const trashed = record.isTrashed === true;
    return {
      terminalId: record.id,
      createdByThisSession: createdByThisSession(record.id, record.launchGeneration),
      trashed,
      trashExpiresAt:
        trashed && typeof record.trashExpiresAt === "number" ? record.trashExpiresAt : null,
    };
  });
  const described = terminals
    .map(
      (terminal) =>
        `'${terminal.terminalId}' (` +
        (terminal.createdByThisSession ? "created by this session" : "not created by this session") +
        (terminal.trashed ? ", closed and still in its trash grace" : "") +
        ")"
    )
    .join(", ");
  const ownOpen = terminals.some((terminal) => terminal.createdByThisSession && !terminal.trashed);
  const ownClosed = terminals.some((terminal) => terminal.createdByThisSession && terminal.trashed);
  const foreign = terminals.some((terminal) => !terminal.createdByThisSession);
  const advice = [
    ownOpen
      ? "Close this session's terminals with 'terminal.closeOwned', then wait for their processes to exit."
      : ownClosed
        ? "Wait for this session's closed terminals to exit."
        : undefined,
    foreign ? "Terminals this session did not create are not its to stop." : undefined,
  ].filter((part): part is string => part !== undefined);
  const count =
    terminals.length === 1
      ? "a terminal in it still has a running process"
      : `${terminals.length} terminals in it still have running processes`;
  return {
    code: "DISABLED",
    message: [`Worktree '${worktreeId}' was not deleted: ${count}: ${described}.`, ...advice].join(
      " "
    ),
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
