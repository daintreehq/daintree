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
import { useBrowserStateStore } from "./browserStateStore";
import { useAssistantChatStore } from "./assistantChatStore";

export async function resetAllStoresForProjectSwitch(): Promise<void> {
  // Use resetWithoutKilling instead of reset
  // This preserves backend processes while clearing UI state
  await useTerminalStore.getState().resetWithoutKilling();

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
  // Reset browser state to ensure per-project URLs are restored from project persistence
  // rather than using stale localStorage state from a different project
  useBrowserStateStore.getState().reset();
  // Reset assistant chat conversations on project switch
  useAssistantChatStore.getState().reset();
}
