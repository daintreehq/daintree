import { isBuiltInAgentId } from "@shared/config/agentIds";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";
import { deriveTerminalChrome } from "@/utils/terminalChrome";
import { shouldShowHybridInputBar } from "./terminalFocus";

/**
 * Whether a pane renders its hybrid input right now, read off the panel record
 * the way `TerminalPane` reads it off its props. Dictation lands in that
 * composer, so a pane without one would take the words into a draft nobody can
 * see (#14608, #14955).
 */
export function panelHasComposer(
  panel: PanelInstance | undefined,
  options: { hybridInputEnabled: boolean; isFleetArmed: boolean; fleetSize: number }
): boolean {
  if (!panel || panel.location === "trash" || !isPtyPanel(panel)) return false;
  // A pane held for recovery (#12434) shows its recovery gate instead.
  if (panel.restoreRecovery) return false;
  // `agentState` matters: an agent that exited back to its shell keeps its
  // launch identity, and only the exit drops it.
  const chrome = deriveTerminalChrome({
    kind: panel.kind,
    launchAgentId: panel.launchAgentId,
    runtimeIdentity: panel.runtimeIdentity,
    detectedAgentId: panel.detectedAgentId,
    detectedProcessId: panel.detectedProcessId,
    agentState: panel.agentState,
  });
  return shouldShowHybridInputBar({ hasAgentIdentity: isBuiltInAgentId(chrome.agentId), ...options });
}
