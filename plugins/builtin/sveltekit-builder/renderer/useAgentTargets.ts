import { useMemo } from "react";
import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { isAgentTerminal } from "@/utils/terminalType";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";
import type { AgentTarget } from "./agentTask.js";

/**
 * Agent terminals a task from this inspector may go to: live agents in the
 * inspector's own worktree only. A terminal in another worktree is never
 * offered, even when it has focus — the task's source paths would be wrong
 * there.
 */
export function useAgentTargets(worktreeId: string | null): AgentTarget[] {
  const panelIds = usePanelStore((state) => state.panelIds);
  const panelsById = usePanelStore((state) => state.panelsById);
  return useMemo(() => {
    if (!worktreeId) return [];
    const targets: AgentTarget[] = [];
    for (const id of panelIds) {
      const panel = panelsById[id];
      if (!panel || !isPtyPanel(panel) || panel.hasPty === false) continue;
      if (panel.worktreeId !== worktreeId) continue;
      if (panel.location === "trash" || panel.location === "background") continue;
      if (!isAgentTerminal(panel)) continue;
      targets.push({
        terminalId: panel.id,
        title: getTerminalDisplayTitle(panel, "full"),
        agentState: panel.agentState ?? null,
      });
    }
    return targets;
  }, [panelIds, panelsById, worktreeId]);
}
