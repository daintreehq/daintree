import { useTerminalStore } from "./terminalStore";
import { useWorktreeSelectionStore } from "./worktreeStore";
import { cleanupWorktreeDataStore } from "./worktreeDataStore";
import { useLogsStore } from "./logsStore";
import { useEventStore } from "./eventStore";
import { useFocusStore } from "./focusStore";
import { useDiagnosticsStore } from "./diagnosticsStore";
import { useErrorStore } from "./errorStore";
import { useNotificationStore } from "./notificationStore";
import { cleanupNotesStore } from "./notesStore";
import { useRecipeStore } from "./recipeStore";
import { resetGitHubFilterStore } from "./githubFilterStore";
import { useWorkflowStore } from "./workflowStore";
import { useTerminalInputStore } from "./terminalInputStore";
import { useLayoutUndoStore } from "./layoutUndoStore";
interface ProjectSwitchResetOptions {
  preserveTerminalIds?: Set<string>;
  outgoingProjectId?: string | null;
}

export async function resetAllStoresForProjectSwitch(
  options: ProjectSwitchResetOptions = {}
): Promise<void> {
  // Use resetWithoutKilling instead of reset
  // This preserves backend processes while clearing UI state
  await useTerminalStore.getState().resetWithoutKilling({
    preserveTerminalIds: options.preserveTerminalIds,
  });

  useWorktreeSelectionStore.getState().reset();
  cleanupWorktreeDataStore();
  // Note: projectSettingsStore is NOT cleaned up here to avoid triggering
  // a reload of old project settings. It will be reset and reloaded by
  // projectStore after the switch completes.
  useRecipeStore.getState().reset();
  useLogsStore.getState().reset();
  useEventStore.getState().reset();
  useFocusStore.getState().reset();
  useDiagnosticsStore.getState().reset();
  useErrorStore.getState().reset();
  useNotificationStore.getState().reset();
  cleanupNotesStore();
  resetGitHubFilterStore();
  useWorkflowStore.getState().reset();
  useLayoutUndoStore.getState().clearHistory();
  if (options.outgoingProjectId) {
    useTerminalInputStore
      .getState()
      .resetForProjectSwitch(options.outgoingProjectId, options.preserveTerminalIds);
  }
}
