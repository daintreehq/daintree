import { isPtyPanel } from "@shared/types/panel";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { deriveTerminalChrome } from "@/utils/terminalChrome";

/**
 * A paste is only safe into an agent: in a plain shell each line of a
 * multi-line note would run as a command. `isAgent` is the observed identity
 * (detected, or the launch agent until an exit was seen), so a pane whose agent
 * quit back to its shell drops out.
 */
export function isAgentPasteTarget(panel: PanelInstance | undefined): panel is PtyPanelData {
  if (!panel) return false;
  if (
    panel.location === "trash" ||
    panel.location === "background" ||
    panel.location === "overlay"
  ) {
    return false;
  }
  if (!isPtyPanel(panel) || panel.hasPty === false) return false;
  // Mid-restart the pane keeps its agent identity but its instance is gone
  // and the process is on its way out.
  if (panel.isRestarting) return false;
  return deriveTerminalChrome(panel).isAgent;
}
