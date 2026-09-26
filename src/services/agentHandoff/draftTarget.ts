import { isGridPanelLocation, isPtyPanel, type PanelInstance } from "@shared/types/panel";
import type { PluginAgentPane, PluginSendToAgentRefusalReason } from "@shared/types/plugin";
import type { WorktreeSnapshot } from "@shared/types";
import type { BackendStatus } from "@/store/panelStore";
import { getBuiltInRuntimeAgentId, getRuntimeAgentId, isAgentTerminal } from "@/utils/terminalType";
import { getTerminalDisplayTitle } from "@/utils/terminalTitleDisplay";

/**
 * Everything the draft gate reads, as plain values so the whole matrix is
 * testable without a store. The live reader is in `agentDraft.ts`.
 */
export interface DraftTargetInputs {
  panelsById: Record<string, PanelInstance>;
  backendStatus: BackendStatus;
  hybridInputEnabled: boolean;
  voiceSubmittingIds: ReadonlySet<string>;
  armedIds: ReadonlySet<string>;
}

/**
 * Why this pane cannot take a drafted handoff, or `null` when it can.
 *
 * The same availability `isRescueTargetRoutable` applies to the type-anywhere
 * rescue and the file-reference insert — a draft is only worth writing if the
 * user can see and edit it, so it needs the input bar TerminalPane actually
 * renders (a built-in agent identity, the setting on, a grid location) and an
 * editor that is not read-only. Walked here gate by gate rather than reused as
 * a boolean because a refusal has to say which gate it hit.
 *
 * Checked in order of how permanent the reason is, so the answer names the
 * thing the user would have to change first: a pane that is gone, then one
 * that is not an agent, then one that has exited, before anything transient.
 */
export function resolveDraftRefusal(
  inputs: DraftTargetInputs,
  terminalId: string
): PluginSendToAgentRefusalReason | null {
  const panel = inputs.panelsById[terminalId];
  if (panel === undefined || panel.location === "trash") return "unknown-terminal";
  if (!isPtyPanel(panel)) return "not-agent";
  // Before identity: an exit clears the runtime agent identity, so a finished
  // agent would otherwise read as a shell.
  const hasExited =
    panel.hasPty === false || panel.runtimeStatus === "exited" || panel.runtimeStatus === "error";
  if (hasExited && (panel.launchAgentId || panel.detectedAgentId)) return "exited";
  // A built-in identity is what makes TerminalPane render the input bar at all;
  // a shell, a demoted ex-agent and a plugin-contributed agent have none.
  if (hasExited || getBuiltInRuntimeAgentId(panel) === undefined) return "not-agent";
  if (!isGridPanelLocation(panel.location)) return "not-in-grid";
  if (!inputs.hybridInputEnabled) return "input-bar-off";
  if (inputs.backendStatus !== "connected") return "backend-unavailable";
  if (panel.isInputLocked === true) return "input-locked";
  // Held behind its recovery gate, the pane shows no input bar until the user
  // resolves the restore — to them it is still coming back.
  if (panel.isRestarting === true || panel.restoreRecovery !== undefined) return "restarting";
  // A dictation about to auto-submit would send the handoff with it.
  if (inputs.voiceSubmittingIds.has(terminalId)) return "input-busy";
  // In a live broadcast, Enter in an armed agent's draft goes to every armed
  // agent — the same two-armed threshold `tryFleetBroadcastFromEditor` uses.
  if (inputs.armedIds.size >= 2 && inputs.armedIds.has(terminalId)) return "fleet-armed";
  return null;
}

export interface AgentPaneListInputs extends DraftTargetInputs {
  panelIds: readonly string[];
  focusedId: string | null;
  worktrees: ReadonlyMap<string, WorktreeSnapshot>;
  showAgentTaskTitles: boolean;
}

/**
 * The project's agent panes as `host.agents.list()` reports them, in grid
 * order.
 *
 * Agents only, by the same runtime identity rule the rest of the renderer uses
 * (`isAgentTerminal`), so a demoted ex-agent is left out. So is an agent whose
 * process has ended, and anything in the trash: a plugin choosing where to hand
 * work has no use for either. Everything else is listed, drafts or not, with
 * the reason it would refuse — a docked agent is still an agent the user can
 * bring back.
 */
export function buildAgentPanes(inputs: AgentPaneListInputs): PluginAgentPane[] {
  const panes: PluginAgentPane[] = [];
  for (const id of inputs.panelIds) {
    const panel = inputs.panelsById[id];
    if (!panel || panel.location === "trash" || !isPtyPanel(panel)) continue;
    if (!isAgentTerminal(panel)) continue;
    if (
      panel.hasPty === false ||
      panel.runtimeStatus === "exited" ||
      panel.runtimeStatus === "error"
    )
      continue;
    const agentId = getRuntimeAgentId(panel);
    if (agentId === undefined) continue;

    const worktreeId = panel.worktreeId;
    const snapshot = worktreeId ? inputs.worktrees.get(worktreeId) : undefined;
    const refusal = resolveDraftRefusal(inputs, id);
    panes.push({
      terminalId: id,
      title: getTerminalDisplayTitle(panel, "full", { showTask: inputs.showAgentTaskTitles }),
      agentId,
      worktree: worktreeId
        ? {
            id: worktreeId,
            name: snapshot?.name ?? worktreeId,
            ...(snapshot?.branch ? { branch: snapshot.branch } : {}),
          }
        : null,
      ...(panel.agentState !== undefined ? { observedState: panel.agentState } : {}),
      isFocused: inputs.focusedId === id,
      canDraft: refusal === null,
      ...(refusal !== null ? { draftRefusal: refusal } : {}),
    });
  }
  return panes;
}

/**
 * Which pane the picker should open on: a draftable agent in the worktree the
 * call named, else the focused agent when it can take a draft, else none.
 * Within the worktree the focused agent wins, then grid order.
 */
export function pickPreselectedPane(
  panes: readonly PluginAgentPane[],
  worktreeId: string | undefined
): PluginAgentPane | null {
  const draftable = panes.filter((pane) => pane.canDraft);
  if (worktreeId !== undefined) {
    const inWorktree = draftable.filter((pane) => pane.worktree?.id === worktreeId);
    const match = inWorktree.find((pane) => pane.isFocused) ?? inWorktree[0];
    if (match) return match;
  }
  return draftable.find((pane) => pane.isFocused) ?? null;
}
