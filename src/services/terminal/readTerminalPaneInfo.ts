import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel, type PtyPanelData } from "@shared/types/panel";
import type { TerminalInfoPayload } from "@shared/types/ipc/terminal";
import { restoredField, type RestoredSummary } from "@shared/utils/restoreProvenance";

/** Measurements only a live terminal-host record has. */
type ProcessMeasurement =
  | "spawnedAt"
  | "lastInputTime"
  | "lastOutputTime"
  | "activityTier"
  | "outputBufferSize"
  | "semanticBufferLines"
  | "restartCount";

/**
 * What the terminal info read reports (#14017): the host's record when the pane
 * has one, with how restore brought the pane back. A pane restore held has no
 * process and no host record, so it reports what the pane itself knows and
 * leaves every process measurement out rather than inventing zeros, which read
 * as real values ("Never") wherever they are shown.
 */
export type TerminalPaneInfo = Omit<TerminalInfoPayload, ProcessMeasurement> &
  Partial<Pick<TerminalInfoPayload, ProcessMeasurement>> & { restored?: RestoredSummary };

function heldPaneInfo(panel: PtyPanelData): TerminalPaneInfo {
  return {
    id: panel.id,
    worktreeId: panel.worktreeId,
    kind: panel.kind,
    launchAgentId: panel.launchAgentId,
    title: panel.title,
    titleMode: panel.titleMode,
    cwd: panel.cwd,
    command: panel.command,
    hasPty: false,
    agentLaunchFlags: panel.agentLaunchFlags,
    agentModelId: panel.agentModelId,
    agentPresetId: panel.agentPresetId,
    agentPresetColor: panel.agentPresetColor,
    originalAgentPresetId: panel.originalPresetId,
    ...restoredField(panel),
  };
}

function ptyPanel(terminalId: string): PtyPanelData | undefined {
  const panel = usePanelStore.getState().panelsById[terminalId];
  return panel && isPtyPanel(panel) ? panel : undefined;
}

export async function readTerminalPaneInfo(terminalId: string): Promise<TerminalPaneInfo | null> {
  const held = ptyPanel(terminalId);
  if (held?.restoreRecovery) return heldPaneInfo(held);
  const info = await window.electron.terminal.getInfo(terminalId);
  if (!info) return null;
  // Read after the await: the pane may have been restarted while the host answered.
  const panel = ptyPanel(terminalId);
  return panel ? { ...info, ...restoredField(panel) } : info;
}
