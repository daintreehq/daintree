import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type { WorktreeLocalWork } from "../../../shared/types/worktreeLocalWork.js";
import type { LedgerEntrySnapshot } from "../../../shared/utils/agentLifecycleLedger.js";

/**
 * The agent pane a close names, as the pty-host recorded it just before the
 * close went out (#18173). The facts the close returns are about this
 * worktree, even when the id is reused by another run before the answer.
 */
export interface ClosingAgentPane {
  terminalId: string;
  projectId?: string;
  worktreeId?: string;
  /** Its record couldn't be read, so neither can its worktree be. */
  unread?: true;
}

/** The pty-host record fields that say whether a pane runs, or ran, an agent. */
export interface ClosingPaneRecord {
  projectId?: string;
  worktreeId?: string;
  isAssistantTerminal?: boolean;
  launchAgentId?: string;
  everDetectedAgent?: boolean;
  detectedAgentId?: string;
}

/**
 * The pane a record describes when it is an agent pane: launched for an
 * agent, or seen running one now or earlier, so a finished agent whose
 * detection has cleared still counts. Null for anything else, the
 * Assistant's own terminal included.
 */
export function closingAgentPane(
  terminalId: string,
  record: ClosingPaneRecord | null
): ClosingAgentPane | null {
  if (record === null || record.isAssistantTerminal === true) return null;
  if (
    record.launchAgentId === undefined &&
    record.detectedAgentId === undefined &&
    record.everDetectedAgent !== true
  ) {
    return null;
  }
  return {
    terminalId,
    ...(record.projectId !== undefined ? { projectId: record.projectId } : {}),
    ...(record.worktreeId !== undefined ? { worktreeId: record.worktreeId } : {}),
  };
}

/**
 * The same, from the launch facts main keeps of a run after it exits: the
 * host drops the record of an agent that exited on an error, while its view
 * keeps the pane for the person to read, and that pane can still be closed.
 */
export function closingAgentPaneFromLaunch(
  terminalId: string,
  launch: Pick<LedgerEntrySnapshot, "facts" | "detectedAgentIds"> | undefined
): ClosingAgentPane | null {
  if (launch === undefined) return null;
  return closingAgentPane(terminalId, {
    ...(launch.facts.projectId !== undefined ? { projectId: launch.facts.projectId } : {}),
    ...(launch.facts.worktreeId !== undefined ? { worktreeId: launch.facts.worktreeId } : {}),
    ...(launch.facts.launchAgentId !== undefined
      ? { launchAgentId: launch.facts.launchAgentId }
      : {}),
    everDetectedAgent: launch.detectedAgentIds.length > 0,
  });
}

/**
 * A successful close's answer with what was read of the closed agent pane's
 * worktree, so the caller can report it. Anything else passes through
 * untouched.
 */
export function withCloseWorktree(
  result: ActionDispatchResult,
  worktree: WorktreeLocalWork
): ActionDispatchResult {
  if (!result.ok) return result;
  const answer = result.result as { closedIds?: unknown } | null | undefined;
  if (answer === null || typeof answer !== "object" || !Array.isArray(answer.closedIds)) {
    return result;
  }
  return { ...result, result: { ...answer, worktree } };
}

/** One worktree to read: the project it belongs to, when the pane named one. */
export interface ClosedPaneWorktreeRequest {
  projectId: string | undefined;
  worktreeId: string;
}

/**
 * What each closed agent pane's worktree holds that exists only on this
 * machine, one answer per pane in order. Never rejects: a reader that fails
 * or is missing, and a pane whose record couldn't be read, leave the pane
 * unreadable, never clean; a pane in no worktree is not-applicable.
 */
export async function readClosedPaneWorktrees(
  read:
    | ((
        panes: readonly ClosedPaneWorktreeRequest[],
        signal: AbortSignal
      ) => Promise<WorktreeLocalWork[]>)
    | undefined,
  panes: readonly ClosingAgentPane[],
  signal: AbortSignal
): Promise<WorktreeLocalWork[]> {
  const answers = panes.map((pane): WorktreeLocalWork =>
    pane.unread !== true && pane.worktreeId === undefined
      ? { kind: "not-applicable" }
      : { kind: "unreadable" }
  );
  const asked = panes.flatMap((pane, index) =>
    pane.unread !== true && pane.worktreeId !== undefined
      ? [{ index, request: { projectId: pane.projectId, worktreeId: pane.worktreeId } }]
      : []
  );
  if (read === undefined || asked.length === 0) return answers;
  try {
    const read_ = await read(
      asked.map(({ request }) => request),
      signal
    );
    asked.forEach(({ index }, at) => {
      const answer = read_[at];
      if (answer !== undefined) answers[index] = answer;
    });
  } catch {
    // Each pane in a worktree stays unreadable.
  }
  return answers;
}
