import { useCallback } from "react";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeStore } from "@/hooks/useWorktreeStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { buildResumePanelOptions } from "@/services/agentResume";
import { resolveResumeLaunchTarget } from "@/utils/resumeLaunch";
import { notify } from "@/lib/notify";
import { isPtyPanel } from "@shared/types/panel";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

// Guards overlapping resume dispatches for the same session across the async
// `addPanel` boundary — records are non-destructive, so two rapid clicks could
// otherwise both pass the existing-panel scan and spawn duplicate terminals
// resuming the same transcript. Module-scoped (one instance per project view),
// mirroring `reopenJournalInFlight` in terminal.reopenLast.
const inFlightResumes = new Set<string>();

/**
 * Returns a `resume(session)` callback that launches (or focuses) a closed
 * agent session. Every resume surface — the resume launcher palette, the
 * empty-grid card, and the panel palette — funnels through here so the tricky
 * parts live in exactly one place:
 *
 *  1. **Directory-coupled resume** — the CLI locates a conversation from the
 *     launch cwd (#4781), so the target is resolved from the session's OWN
 *     recorded cwd/worktree via {@link resolveResumeLaunchTarget}, not whatever
 *     worktree happens to be active.
 *  2. **Cross-worktree focus** — `addPanel` backgrounds a grid panel whose
 *     worktree differs from the active one, so resuming another worktree's
 *     session from a project-wide list would silently spawn it off-screen. We
 *     switch to the session's live worktree first so the resumed terminal is
 *     actually visible.
 *  3. **No double-resume** — records are non-destructive, so a second click
 *     would relaunch the same transcript. If a live panel already carries this
 *     session in the target worktree, we focus it instead.
 *
 * The live worktree map is read reactively (per-view store); everything else is
 * read via `getState()` at call time so the callback stays stable across
 * unrelated re-renders.
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

      const target = resolveResumeLaunchTarget(session, { defaultTerminalCwd, activeWorktreeId });

      // A record whose recorded worktree no longer resolves can't be resumed —
      // it would spawn into a dead worktree. Callers already filter stale rows,
      // but this is the shared entry point, so guard here too.
      if (target.worktreeId && !worktrees.has(target.worktreeId)) return;

      const panelStore = usePanelStore.getState();

      // Focus an already-open resume rather than spawning a duplicate. Scope by
      // worktree too so a panel moved to another worktree can't steal focus.
      const existingId = panelStore.panelIds.find((id) => {
        const panel = panelStore.panelsById[id];
        return (
          panel &&
          isPtyPanel(panel) &&
          panel.location !== "trash" &&
          panel.agentSessionId === session.sessionId &&
          (panel.worktreeId ?? null) === (target.worktreeId ?? null)
        );
      });
      if (existingId) {
        panelStore.activateTerminal(existingId);
        return;
      }

      const inFlightKey = `${session.sessionId}::${target.worktreeId ?? ""}`;
      if (inFlightResumes.has(inFlightKey)) return;
      inFlightResumes.add(inFlightKey);
      try {
        // Switch to the session's own worktree before spawning so the resumed
        // grid panel isn't backgrounded (addPanel backgrounds a grid panel whose
        // worktree differs from the active one).
        if (target.worktreeId && target.worktreeId !== (activeWorktreeId ?? null)) {
          selection.selectWorktree(target.worktreeId, { source: "user" });
        }

        const options = buildResumePanelOptions(session, target);
        if (!options) {
          // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
          notify({
            type: "error",
            title: "Resume failed",
            message: "Couldn't resume this session — its agent may no longer support resuming.",
            priority: "high",
            context: { eventKind: "agent" },
          });
          return;
        }

        await panelStore.addPanel(options);
      } finally {
        inFlightResumes.delete(inFlightKey);
      }
    },
    [worktrees]
  );
}
