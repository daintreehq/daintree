import { useTerminalStore } from "./terminalStore";
import { useWorktreeSelectionStore } from "./worktreeStore";
import { useLogsStore } from "./logsStore";
import { useEventStore } from "./eventStore";
import { useFocusStore } from "./focusStore";
import { useDiagnosticsStore } from "./diagnosticsStore";
import { useErrorStore } from "./errorStore";
import { useNotificationStore } from "./notificationStore";
import { cleanupNotesStore } from "./notesStore";

export async function resetAllStoresForProjectSwitch(): Promise<void> {
  // Use resetWithoutKilling instead of reset
  // This preserves backend processes while clearing UI state
  await useTerminalStore.getState().resetWithoutKilling();

  useWorktreeSelectionStore.getState().reset();
  useLogsStore.getState().reset();
  useEventStore.getState().reset();
  useFocusStore.getState().reset();
  useDiagnosticsStore.getState().reset();
  useErrorStore.getState().reset();
  useNotificationStore.getState().reset();
  cleanupNotesStore();
}
