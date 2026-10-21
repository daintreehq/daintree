import { isPtyPanel } from "@shared/types/panel";
import { usePanelStore } from "@/store/panelStore";
import { useHelpPanelStore, selectSlotForTerminal } from "@/store/helpPanelStore";
import { logError, logWarn } from "@/utils/logger";

const CLAUDE_AGENT_ID = "claude";

// Source terminals with a spawn in flight. A double click activates a link
// twice; one click, one terminal.
const spawning = new Set<string>();

/**
 * Whether a terminal's `! command` suggestions are live links: a pane running
 * Claude Code right now, outside the assistant, whose panel still has a cwd to
 * run the command in. Read on every hover and again on click.
 */
export function isSuggestedCommandSource(id: string, runtimeAgentId: string | undefined): boolean {
  if (runtimeAgentId !== CLAUDE_AGENT_ID) return false;
  if (selectSlotForTerminal(useHelpPanelStore.getState(), id) !== null) return false;
  const panel = usePanelStore.getState().panelsById[id];
  return !!panel && isPtyPanel(panel) && !!panel.cwd;
}

/**
 * Opens a new terminal beside the agent, in its worktree, running a command the
 * user clicked in its output. The source panel is read at click time so a pane
 * moved to another worktree runs the command there.
 */
export function runSuggestedCommand(id: string, command: string): void {
  if (spawning.has(id)) return;
  const store = usePanelStore.getState();
  const panel = store.panelsById[id];
  if (!panel || !isPtyPanel(panel) || !panel.cwd) return;
  spawning.add(id);
  store
    .addPanel({
      kind: "terminal",
      cwd: panel.cwd,
      worktreeId: panel.worktreeId,
      location: "grid",
      command,
      spawnedBy: "quickrun",
    })
    .then(
      (terminalId) => {
        if (terminalId === null) logWarn("Suggested command terminal was rejected", { id });
      },
      (error: unknown) => logError("Failed to open suggested command terminal", error, { id })
    )
    .finally(() => spawning.delete(id));
}

export const __testing = {
  reset(): void {
    spawning.clear();
  },
};
