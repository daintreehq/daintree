import { panelKindHasPty } from "@shared/config/panelKindRegistry";
import { isPtyPanel, type PanelInstance } from "@shared/types/panel";

/**
 * The pane's process exited, or restore held the pane before it started: it
 * shows a screen nothing writes to any more. An agent that exited back to its
 * shell is not this; its shell is still live.
 */
export function terminalScreenEnded(panel: PanelInstance | undefined): boolean {
  // Only the built-in terminal's panel type carries the exit record, so a
  // plugin's PTY kind never reads as ended here; the host still refuses one
  // whose process has gone.
  if (!panel || !isPtyPanel(panel)) return false;
  return (
    typeof panel.exitCode === "number" ||
    panel.runtimeStatus === "exited" ||
    panel.restoreRecovery !== undefined
  );
}

/**
 * Whether a panel shows a live terminal screen a mode reset can reach
 * (#17328): a PTY kind whose screen hasn't ended.
 */
export function hasLiveTerminalScreen(panel: PanelInstance | undefined): panel is PanelInstance {
  return !!panel && panelKindHasPty(panel.kind ?? "terminal") && !terminalScreenEnded(panel);
}
