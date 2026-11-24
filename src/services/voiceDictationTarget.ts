import type { VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { usePanelStore } from "@/store/panelStore";
import { useProjectStore } from "@/store/projectStore";
import { selectFleetMemberCount, useFleetArmingStore } from "@/store/fleetArmingStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useHelpPanelStore, selectActiveSlot } from "@/store/helpPanelStore";
import { isAssistantFocused } from "@/store/macroFocusStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { panelHasComposer } from "@/components/Terminal/terminalComposer";

// Where dictation would go, read from the stores alone: answering it needs no
// recording service, so asking never loads one.

/** The pane as a dictation target, or null when it has no composer to show the words. */
export function resolveDictationTarget(panelId: string): VoiceRecordingTarget | null {
  const panel = usePanelStore.getState().panelsById[panelId];
  if (!panel) return null;
  const arming = useFleetArmingStore.getState();
  if (
    !panelHasComposer(panel, {
      hybridInputEnabled: useTerminalInputStore.getState().hybridInputEnabled,
      isFleetArmed: arming.armedIds.has(panelId),
      fleetSize: selectFleetMemberCount(arming),
    })
  ) {
    return null;
  }

  const currentProject = useProjectStore.getState().currentProject;
  const worktree = panel.worktreeId
    ? getCurrentViewStore().getState().worktrees.get(panel.worktreeId)
    : undefined;

  return {
    panelId: panel.id,
    panelTitle: panel.title,
    projectId: currentProject?.id,
    projectName: currentProject?.name,
    worktreeId: panel.worktreeId,
    worktreeLabel: worktree?.isMainWorktree ? worktree?.name : worktree?.branch || worktree?.name,
  };
}

/** The Assistant's active lane as a dictation target, or null while it has no live terminal. */
export function resolveAssistantTarget(): VoiceRecordingTarget | null {
  // The ACTIVE lane (#12108): dictation is aimed at the session on screen,
  // not at whichever one happens to be running in the background.
  const terminalId = selectActiveSlot(useHelpPanelStore.getState()).terminalId;
  if (!terminalId) return null;

  // Guard the brief window where the assistant terminal has been trashed (or
  // not yet committed to panelStore) but helpPanelStore.terminalId is still
  // set — mirrors getFocusedPanelTarget(). A missing/trashed panel means the
  // assistant is starting or tearing down, so dictation must not target it.
  const panelEntry = usePanelStore.getState().panelsById[terminalId];
  if (!panelEntry || panelEntry.location === "trash") return null;

  const currentProject = useProjectStore.getState().currentProject;
  return {
    panelId: terminalId,
    panelTitle: "Daintree Assistant",
    projectId: currentProject?.id,
    projectName: currentProject?.name,
  };
}

/**
 * The composer dictation would start in without a lock: the assistant's
 * while it has focus (or `assistant` says it's the one meant), else the
 * focused agent's. Null when that one has no composer.
 */
export function resolveFocusedComposerTarget(
  assistant = isAssistantFocused()
): VoiceRecordingTarget | null {
  if (assistant) return resolveAssistantTarget();
  const panelId = usePanelStore.getState().focusedId;
  return panelId ? resolveDictationTarget(panelId) : null;
}
