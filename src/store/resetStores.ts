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
  // Note: Browser state (useBrowserStateStore) is NOT reset here.
  // Browser state is keyed by panelId (and optionally worktreeId), so different projects
  // have different panel IDs and won't conflict. This preserves zoom factors across
  // project switches, which is the expected user experience.
  // Reset assistant chat conversations on project switch
  useAssistantChatStore.getState().reset();
}
