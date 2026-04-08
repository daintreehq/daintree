import { usePanelStore } from "./panelStore";
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
  const unsubFocus = usePanelStore.subscribe((state, prevState) => {
    if (state.focusedId === prevState.focusedId) return;

    const focusedId = state.focusedId;
    if (!focusedId) return;

    const terminal = state.panelsById[focusedId];
    if (terminal?.worktreeId) {
      const worktreeState = useWorktreeSelectionStore.getState();
      worktreeState.trackTerminalFocus(terminal.worktreeId, focusedId);

      if (terminal.worktreeId !== worktreeState.activeWorktreeId) {
        worktreeState.selectWorktree(terminal.worktreeId);
      }
    }

    if (!isMruRecordingSuppressed()) {
      state.recordMru(`terminal:${focusedId}`);
      debouncedPersistMruList(usePanelStore.getState().mruList);
    }
  });
  unsubscribers.push(unsubFocus);

  // 2. Background-restore reaction: when a backgrounded panel becomes
  //    focused, automatically restore it to the grid.
  const unsubBackgroundRestore = usePanelStore.subscribe((state, prevState) => {
    if (state.focusedId === prevState.focusedId) return;

    const focusedId = state.focusedId;
    if (!focusedId) return;

    const panel = state.panelsById[focusedId];
    if (panel?.location !== "background") return;

    state.restoreBackgroundTerminal(focusedId);

    // If the panel was restored to dock, fix activeDockTerminalId since
    // activateTerminal() saw "background" and cleared it.
    const restored = usePanelStore.getState().panelsById[focusedId];
    if (restored?.location === "dock") {
      usePanelStore.setState({ activeDockTerminalId: focusedId });
    }
  });
  unsubscribers.push(unsubBackgroundRestore);

  // 3. Terminal-removal cleanup: when terminals are removed, clean up
  //    input store, console capture store, and worktree focus tracking.
  let prevTerminalIds = usePanelStore.getState().panelIds;
  let prevTerminalsById = usePanelStore.getState().panelsById;

  const unsubRemoval = usePanelStore.subscribe((state) => {
    const currentIds = state.panelIds;
    if (currentIds === prevTerminalIds) {
      prevTerminalsById = state.panelsById;
      return;
    }

    const currentIdSet = new Set(currentIds);
    const removedIds = prevTerminalIds.filter((id) => !currentIdSet.has(id));
    const prevById = prevTerminalsById;
    prevTerminalIds = currentIds;
    prevTerminalsById = state.panelsById;

    for (const removedId of removedIds) {
      useTerminalInputStore.getState().clearTerminalState(removedId);
      useConsoleCaptureStore.getState().removePane(removedId);
      useVoiceRecordingStore.getState().clearPanelBuffer(removedId);
      unregisterInputController(removedId);
      semanticAnalysisService.unregisterTerminal(removedId);

      const removed = prevById[removedId];
      if (removed?.worktreeId) {
        const worktreeState = useWorktreeSelectionStore.getState();
        const lastFocused = worktreeState.lastFocusedTerminalByWorktree.get(removed.worktreeId);
        if (lastFocused === removedId) {
          worktreeState.clearWorktreeFocusTracking(removed.worktreeId);
        }
      }
    }
  });
  unsubscribers.push(unsubRemoval);

  // 4. Layout undo history invalidation: when terminal set changes (add/remove),
  //    clear the undo stack since snapshots reference a different terminal universe.
  let prevIdSet = new Set(usePanelStore.getState().panelIds);

  const unsubLayoutUndo = usePanelStore.subscribe((state) => {
    const currentIds = state.panelIds;
    const currentIdSet = new Set(currentIds);
    if (currentIdSet.size !== prevIdSet.size || currentIds.some((id) => !prevIdSet.has(id))) {
      useLayoutUndoStore.getState().clearHistory();
    }
    prevIdSet = currentIdSet;
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
