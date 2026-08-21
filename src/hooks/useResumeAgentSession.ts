import { useCallback } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { resumeSessionIntoPanel } from "@/services/agentResume";
import { resolveResumeLaunchTarget } from "@/utils/resumeLaunch";
import { notify } from "@/lib/notify";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

/**
 * Returns a `resume(session)` callback that launches (or focuses) a closed
 * agent session. Every human resume surface — the resume launcher palette, the
 * empty-grid card, and the panel palette — funnels through here.
 *
 * The tricky parts live in `resumeSessionIntoPanel`, shared with the
 * deterministic `agentSessionHistory.resume` action so the two entry points
 * cannot drift:
 *
 *  1. **No double-resume** — records are non-destructive, so a second click
 *     would relaunch the same transcript. A live pane already carrying this
 *     session in the target worktree is focused instead, and overlapping
 *     dispatches share one in-flight resume.
 *  2. **Cross-worktree focus** — `addPanel` backgrounds a grid panel whose
 *     worktree differs from the active one, so resuming another worktree's
 *     session from a project-wide list would silently spawn it off-screen. The
 *     `onBeforeSpawn` hook below switches to the session's live worktree first
 *     so the resumed terminal is actually visible. This is the human surface's
 *     policy: an agent-dispatched resume deliberately does not move the view.
 *
 * What stays here is what only a human surface needs: the reactive worktree map
 * (per-view store) and turning a failure into a toast.
 *
 *  3. **Directory-coupled resume** — the CLI locates a conversation from the
 *     launch cwd (#4781), so the target is resolved from the session's OWN
 *     recorded cwd/worktree via {@link resolveResumeLaunchTarget}, not whatever
 *     worktree happens to be active.
 *
 * The live worktree map is read reactively; everything else is read via
 * `getState()` at call time so the callback stays stable across unrelated
 * re-renders.
 */
export function useResumeAgentSession() {
  const worktrees = useWorktreeStore((state) => state.worktrees);

  return useCallback(
    async (session: AgentSessionRecord): Promise<void> => {
      const selection = useWorktreeSelectionStore.getState();
      const activeWorktreeId = selection.activeWorktreeId;
      const currentProject = useProjectStore.getState().currentProject;

      const activeWorktree = activeWorktreeId ? worktrees.get(activeWorktreeId) : undefined;
      const defaultTerminalCwd = activeWorktree?.path ?? currentProject?.path ?? "";

      // Live worktree paths let a null-worktree record re-home by cwd, keeping
      // the launch target consistent with the group the row was shown under.
      const target = resolveResumeLaunchTarget(
        session,
        { defaultTerminalCwd, activeWorktreeId },
        [...worktrees.values()].map((wt) => ({ id: wt.id, path: wt.path }))
      );

      // A record whose recorded worktree no longer resolves can't be resumed —
      // it would spawn into a dead worktree. Callers already filter stale rows,
      // but this is the shared entry point, so guard here too.
      if (target.worktreeId && !worktrees.has(target.worktreeId)) return;

      const revealTargetWorktree = () => {
        const current = useWorktreeSelectionStore.getState();
        if (target.worktreeId && target.worktreeId !== current.activeWorktreeId) {
          current.selectWorktree(target.worktreeId, { source: "user" });
        }
      };

      try {
        // Switch BEFORE spawning so the resumed grid panel isn't backgrounded —
        // `addPanel` backgrounds a panel whose worktree differs from the active
        // one, and this callback only runs on the spawning path.
        const resumed = await resumeSessionIntoPanel(session, target, {
          onBeforeSpawn: revealTargetWorktree,
        });
        // Run it again after the fact, because `onBeforeSpawn` is the STARTER's
        // callback: a person clicking a session an agent is already resuming
        // joins that in-flight resume and never reaches it, so without this
        // their click would silently leave the pane in another worktree.
        // Selecting the worktree we are already on is a no-op.
        revealTargetWorktree();
        usePanelStore.getState().activateTerminal(resumed.terminalId);
      } catch (error) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Resume failed",
          message: error instanceof Error ? error.message : String(error),
          priority: "high",
          context: { eventKind: "agent" },
        });
      }
    },
    [worktrees]
  );
}
