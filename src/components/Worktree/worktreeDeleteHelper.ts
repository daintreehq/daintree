import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import { buildResumeCommand } from "@shared/types";
import { logWarn } from "@/utils/logger";

const WORKTREE_DELETE_TERMINAL_CLOSE_TIMEOUT_MS = 10_000;
const WORKTREE_DELETE_TERMINAL_CLOSE_POLL_MS = 100;

/**
 * Everything needed to relaunch a terminal that was closed as part of a
 * worktree delete, so it can be brought back if the delete never actually
 * happens. Captured BEFORE the hard kill (the live PTY is gone once we've
 * killed it), and replayed through {@link restoreClosedTerminals} on failure.
 *
 * We deliberately do NOT route the teardown through the trash/undo path
 * (`trashPanel`): trash keeps the PTY alive under a 20s TTL, but the worktree
 * delete must kill terminals BEFORE `git worktree remove` — on Windows a live
 * process rooted in the worktree directory holds a lock that makes the removal
 * fail outright. So the recoverability the trash path would give is provided
 * here instead: kill now (Windows-safe, still journaled for launch agents),
 * relaunch from this snapshot only if the delete is abandoned.
 */
export interface WorktreeTerminalRestoreSnapshot {
  id: string;
  title?: string;
  titleMode?: PtyPanelData["titleMode"];
  worktreeId?: string;
  cwd?: string;
  location: "grid" | "dock";
  command?: string;
  launchAgentId?: PtyPanelData["launchAgentId"];
  agentModelId?: string;
  agentLaunchFlags?: string[];
  agentPresetId?: string;
  agentPresetColor?: string;
  originalPresetId?: string;
  agentSessionId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getLiveTerminalIdsForWorktree(worktreeId: string): string[] {
  const state = usePanelStore.getState();
  return state.panelIds.filter((id) => {
    const panel = state.panelsById[id];
    return (
      panel?.worktreeId === worktreeId &&
      panel.location !== "trash" &&
      (!isPtyPanel(panel) || panel.excludeFromPersistence !== true)
    );
  });
}

/** Capture a relaunch snapshot for a single live PTY panel. Only "grid"/"dock"
 *  panels are recoverable — a trashed/dialog panel has no stable restore home. */
function snapshotTerminal(panel: PtyPanelData): WorktreeTerminalRestoreSnapshot {
  return {
    id: panel.id,
    title: panel.title,
    titleMode: panel.titleMode,
    worktreeId: panel.worktreeId,
    cwd: panel.cwd,
    location: panel.location === "dock" ? "dock" : "grid",
    command: panel.command,
    launchAgentId: panel.launchAgentId,
    agentModelId: panel.agentModelId,
    agentLaunchFlags: panel.agentLaunchFlags,
    agentPresetId: panel.agentPresetId,
    agentPresetColor: panel.agentPresetColor,
    originalPresetId: panel.originalPresetId,
    agentSessionId: panel.agentSessionId,
  };
}

export async function waitForTerminalsToClose(terminalIds: string[]): Promise<void> {
  if (terminalIds.length === 0) return;
  if (typeof window === "undefined" || !window.electron?.terminal?.getInfo) return;

  const remaining = new Set(terminalIds);
  const deadline = Date.now() + WORKTREE_DELETE_TERMINAL_CLOSE_TIMEOUT_MS;

  while (remaining.size > 0 && Date.now() < deadline) {
    await Promise.all(
      Array.from(remaining, async (terminalId) => {
        try {
          const info = await window.electron.terminal.getInfo(terminalId);
          // hasPty flips before the backend forgets the terminal, which can leave cwd locked on Windows.
          if (info.hasPty === false) return;
        } catch {
          remaining.delete(terminalId);
        }
      })
    );

    if (remaining.size > 0) {
      await sleep(WORKTREE_DELETE_TERMINAL_CLOSE_POLL_MS);
    }
  }

  if (remaining.size > 0) {
    throw new Error(
      `Timed out waiting for ${remaining.size} terminal(s) to close before deleting worktree`
    );
  }
}

/**
 * Hard-close every live terminal in a worktree ahead of `git worktree remove`,
 * returning a snapshot that {@link restoreClosedTerminals} can replay if the
 * delete never lands. The kill is immediate (not the trash TTL) so the worktree
 * directory is unlocked before the removal — see
 * {@link WorktreeTerminalRestoreSnapshot} for why trash-routing isn't used.
 */
export async function closeTerminalsForWorktree(
  worktreeId: string
): Promise<WorktreeTerminalRestoreSnapshot[]> {
  const terminalIds = getLiveTerminalIdsForWorktree(worktreeId);
  if (terminalIds.length === 0) return [];

  const store = usePanelStore.getState();
  const snapshots: WorktreeTerminalRestoreSnapshot[] = [];
  for (const id of terminalIds) {
    const panel = store.panelsById[id];
    if (panel && isPtyPanel(panel)) {
      snapshots.push(snapshotTerminal(panel));
    }
  }

  terminalIds.forEach((id) => store.removePanel(id));
  await waitForTerminalsToClose(terminalIds);
  return snapshots;
}

/**
 * Bring back terminals closed by {@link closeTerminalsForWorktree} when the
 * worktree delete was abandoned (a lock, a branch error, an exhausted retry).
 * The original PTYs are already dead, so this relaunches fresh panels with the
 * same ids into the still-present worktree, resuming the journaled agent
 * session where the agent supports it. Best-effort: a single failed relaunch
 * never blocks the rest.
 */
export async function restoreClosedTerminals(
  snapshots: readonly WorktreeTerminalRestoreSnapshot[]
): Promise<void> {
  if (snapshots.length === 0) return;
  const store = usePanelStore.getState();

  for (const snap of snapshots) {
    // Resume the journaled session for resume-capable agents; otherwise fall
    // back to the stored launch command (fresh session). The dead PTY can't be
    // resurrected, so a relaunch is the most recovery possible.
    const resumeCommand =
      snap.launchAgentId && snap.agentSessionId
        ? buildResumeCommand(snap.launchAgentId, snap.agentSessionId, snap.agentLaunchFlags)
        : undefined;

    try {
      await store.addPanel({
        requestedId: snap.id,
        kind: "terminal",
        title: snap.title,
        titleMode: snap.titleMode,
        worktreeId: snap.worktreeId,
        worktreeIdSource: "explicit",
        cwd: snap.cwd,
        location: snap.location,
        command: resumeCommand ?? snap.command,
        launchAgentId: snap.launchAgentId,
        agentModelId: snap.agentModelId,
        agentLaunchFlags: snap.agentLaunchFlags,
        agentPresetId: snap.agentPresetId,
        agentPresetColor: snap.agentPresetColor,
        originalPresetId: snap.originalPresetId,
        agentSessionId: snap.agentSessionId,
        bypassLimits: true,
        focusPolicy: "preserve",
      });
    } catch (error) {
      logWarn("[WorktreeDelete] Failed to restore terminal after aborted delete", {
        id: snap.id,
        error,
      });
    }
  }
}
