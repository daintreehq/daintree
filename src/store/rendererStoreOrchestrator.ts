import { useTerminalStore } from "./terminalStore";
import {
  useWorktreeSelectionStore,
  isMruRecordingSuppressed,
  persistMruList,
} from "./worktreeStore";
import { useTerminalInputStore, unregisterInputController } from "./terminalInputStore";
import { semanticAnalysisService } from "@/services/SemanticAnalysisService";
import { useConsoleCaptureStore } from "./consoleCaptureStore";
import { useVoiceRecordingStore } from "./voiceRecordingStore";
import { useLayoutUndoStore } from "./layoutUndoStore";
import { debounce } from "@/utils/debounce";

const debouncedPersistMruList = debounce(persistMruList, 150);

let cleanupFn: (() => void) | null = null;

export function initStoreOrchestrator(): () => void {
  if (cleanupFn) return cleanupFn;

  const unsubscribers: Array<() => void> = [];

  // 1. Focus-to-worktree reaction: when focusedId changes, track focus,
  //    switch worktree if needed, and record terminal MRU.
  const unsubFocus = useTerminalStore.subscribe((state, prevState) => {
    if (state.focusedId === prevState.focusedId) return;

    const focusedId = state.focusedId;
    if (!focusedId) return;

    const terminal = state.terminals.find((t) => t.id === focusedId);
    if (terminal?.worktreeId) {
      const worktreeState = useWorktreeSelectionStore.getState();
      worktreeState.trackTerminalFocus(terminal.worktreeId, focusedId);

      if (terminal.worktreeId !== worktreeState.activeWorktreeId) {
        worktreeState.selectWorktree(terminal.worktreeId);
      }
    }

    if (!isMruRecordingSuppressed()) {
      state.recordMru(`terminal:${focusedId}`);
      debouncedPersistMruList(useTerminalStore.getState().mruList);
    }
  });
  unsubscribers.push(unsubFocus);

  // 2. Background-restore reaction: when a backgrounded panel becomes
  //    focused, automatically restore it to the grid.
  const unsubBackgroundRestore = useTerminalStore.subscribe((state, prevState) => {
    if (state.focusedId === prevState.focusedId) return;

    const focusedId = state.focusedId;
    if (!focusedId) return;

    const panel = state.terminals.find((t) => t.id === focusedId);
    if (panel?.location !== "background") return;

    state.restoreBackgroundTerminal(focusedId);

    // If the panel was restored to dock, fix activeDockTerminalId since
    // activateTerminal() saw "background" and cleared it.
    const restored = useTerminalStore.getState().terminals.find((t) => t.id === focusedId);
    if (restored?.location === "dock") {
      useTerminalStore.setState({ activeDockTerminalId: focusedId });
    }
  });
  unsubscribers.push(unsubBackgroundRestore);

  // 3. Terminal-removal cleanup: when terminals are removed, clean up
  //    input store, console capture store, and worktree focus tracking.
  let prevTerminals = useTerminalStore.getState().terminals;

  const unsubRemoval = useTerminalStore.subscribe((state) => {
    const currentTerminals = state.terminals;
    if (currentTerminals === prevTerminals) return;

    const currentIds = new Set(currentTerminals.map((t) => t.id));
    const removedTerminals = prevTerminals.filter((t) => !currentIds.has(t.id));
    prevTerminals = currentTerminals;

    for (const removed of removedTerminals) {
      useTerminalInputStore.getState().clearTerminalState(removed.id);
      useConsoleCaptureStore.getState().removePane(removed.id);
      useVoiceRecordingStore.getState().clearPanelBuffer(removed.id);
      unregisterInputController(removed.id);
      semanticAnalysisService.unregisterTerminal(removed.id);

      if (removed.worktreeId) {
        const worktreeState = useWorktreeSelectionStore.getState();
        const lastFocused = worktreeState.lastFocusedTerminalByWorktree.get(removed.worktreeId);
        if (lastFocused === removed.id) {
          worktreeState.clearWorktreeFocusTracking(removed.worktreeId);
        }
      }
    }
  });
  unsubscribers.push(unsubRemoval);

  // 3. Layout undo history invalidation: when terminal set changes (add/remove),
  //    clear the undo stack since snapshots reference a different terminal universe.
  let prevIdSet = new Set(useTerminalStore.getState().terminals.map((t) => t.id));

  const unsubLayoutUndo = useTerminalStore.subscribe((state) => {
    const currentIds = new Set(state.terminals.map((t) => t.id));
    if (currentIds.size !== prevIdSet.size || [...currentIds].some((id) => !prevIdSet.has(id))) {
      useLayoutUndoStore.getState().clearHistory();
    }
    prevIdSet = currentIds;
  });
  unsubscribers.push(unsubLayoutUndo);

  cleanupFn = () => {
    for (const unsub of unsubscribers) unsub();
    cleanupFn = null;
  };

  return cleanupFn;
}

export function destroyStoreOrchestrator(): void {
  debouncedPersistMruList.cancel();
  cleanupFn?.();
}
