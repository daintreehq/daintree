import { useCallback } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { queueWorktreeMoveInstruction } from "@/services/terminal/worktreeMoveInstruction";

export interface WorktreeMoveBanner {
  /** True while this pane has an unanswered cross-worktree move prompt. */
  visible: boolean;
  /**
   * Destination path as it resolves right now, or `undefined` when the
   * worktree has since gone. `undefined` disables the tell — there is no
   * fallback path, because guessing one is how a destructive default gets
   * shipped (#7880).
   */
  destinationPath: string | undefined;
  /** Send the instruction (now, or once the agent is free) and hide the bar. */
  tell: () => void;
  /** Hide the bar. Nothing is sent and nothing is recorded. */
  dismiss: () => void;
}

/**
 * Owns the "agent may still be in the original worktree" banner for one pane
 * (#11853).
 *
 * Reads and writes the panel store rather than component state for the same
 * reason `useSessionLostBanner` does: the grid renders only the active
 * worktree's panels, so switching worktrees unmounts this pane outright and a
 * local answer would be lost on the way back — and this bar exists precisely to
 * be found later, on a pane the user was not looking at when they dropped it.
 *
 * Both outcomes clear the same field. There is deliberately no "was it told"
 * flag: compliance is undetectable, `panel.cwd` still names the source worktree
 * even after the agent moves over completely, and any marker that outlives the
 * click would sit lit forever on total success.
 */
export function useWorktreeMoveBanner(panelId: string): WorktreeMoveBanner {
  const destinationWorktreeId = usePanelStore((state) => {
    const panel = state.panelsById[panelId];
    const pty = panel && isPtyPanel(panel) ? panel : undefined;
    return pty?.worktreeMoveNotice?.destinationWorktreeId;
  });

  const destinationPath = useWorktreeStore((state) =>
    destinationWorktreeId ? state.worktrees.get(destinationWorktreeId)?.path : undefined
  );

  const setWorktreeMoveNotice = usePanelStore((state) => state.setWorktreeMoveNotice);

  const dismiss = useCallback(
    () => setWorktreeMoveNotice(panelId, undefined),
    [setWorktreeMoveNotice, panelId]
  );

  const tell = useCallback(() => {
    if (!destinationWorktreeId) return;
    // Only clear once the instruction is actually owned by the scheduler.
    // A destination that vanished between render and click leaves the bar up
    // rather than silently swallowing the user's one click.
    if (!queueWorktreeMoveInstruction(panelId, destinationWorktreeId)) return;
    setWorktreeMoveNotice(panelId, undefined);
  }, [panelId, destinationWorktreeId, setWorktreeMoveNotice]);

  return {
    visible: destinationWorktreeId !== undefined,
    destinationPath: destinationPath?.trim() ? destinationPath : undefined,
    tell,
    dismiss,
  };
}
