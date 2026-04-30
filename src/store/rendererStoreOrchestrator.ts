import { shallow } from "zustand/shallow";
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
import { useCliAvailabilityStore } from "./cliAvailabilityStore";
import { useAgentSettingsStore } from "./agentSettingsStore";
import { debounce } from "@/utils/debounce";
import { DisposableStore, toDisposable } from "@/utils/disposable";

const debouncedPersistMruList = debounce(persistMruList, 150);

let cleanupFn: (() => void) | null = null;

export function initStoreOrchestrator(): () => void {
  if (cleanupFn) return cleanupFn;

  const disposables = new DisposableStore();

  // 1a. Worktree focus tracking: remember which terminal was last focused
  //     inside each worktree, so switching back restores that selection.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => state.focusedId,
        (focusedId) => {
          if (!focusedId) return;
          const terminal = usePanelStore.getState().panelsById[focusedId];
          if (!terminal?.worktreeId) return;
          useWorktreeSelectionStore.getState().trackTerminalFocus(terminal.worktreeId, focusedId);
        }
      )
    )
  );

  // 1b. Active worktree switch: focusing a terminal that lives in a
  //     different worktree promotes that worktree to active.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => state.focusedId,
        (focusedId) => {
          if (!focusedId) return;
          const terminal = usePanelStore.getState().panelsById[focusedId];
          if (!terminal?.worktreeId) return;
          const worktreeState = useWorktreeSelectionStore.getState();
          if (terminal.worktreeId !== worktreeState.activeWorktreeId) {
            worktreeState.selectWorktree(terminal.worktreeId);
          }
        }
      )
    )
  );

  // 1c. Terminal MRU recording: append the newly focused terminal to the
  //     global MRU list and persist it (debounced) unless suppressed.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => state.focusedId,
        (focusedId) => {
          if (!focusedId) return;
          if (isMruRecordingSuppressed()) return;
          usePanelStore.getState().recordMru(`terminal:${focusedId}`);
          debouncedPersistMruList(usePanelStore.getState().mruList);
        }
      )
    )
  );

  // 2. Background-restore reaction: when a backgrounded panel becomes
  //    focused, automatically restore it to the grid.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => state.focusedId,
        (focusedId) => {
          if (!focusedId) return;
          const panel = usePanelStore.getState().panelsById[focusedId];
          if (panel?.location !== "background") return;

          usePanelStore.getState().restoreBackgroundTerminal(focusedId);

          // If the panel was restored to dock, fix activeDockTerminalId since
          // activateTerminal() saw "background" and cleared it.
          const restored = usePanelStore.getState().panelsById[focusedId];
          if (restored?.location === "dock") {
            usePanelStore.setState({ activeDockTerminalId: focusedId });
          }
        }
      )
    )
  );

  // 3. Terminal-removal cleanup: when terminals are removed, clean up
  //    input store, console capture store, and worktree focus tracking.
  //    Selector pulls both `panelIds` (for diff) and `panelsById` (to read
  //    the removed panel's worktreeId). Shallow equality fires on either
  //    ref change; inner guard bails when only `panelsById` changed so
  //    metadata updates do not trigger phantom cleanup runs.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => ({ panelIds: state.panelIds, panelsById: state.panelsById }),
        (selected, prevSelected) => {
          if (selected.panelIds === prevSelected.panelIds) return;

          const currentIdSet = new Set(selected.panelIds);
          const removedIds = prevSelected.panelIds.filter((id) => !currentIdSet.has(id));
          if (removedIds.length === 0) return;

          const prevById = prevSelected.panelsById;

          for (const removedId of removedIds) {
            useTerminalInputStore.getState().clearTerminalState(removedId);
            useConsoleCaptureStore.getState().removePane(removedId);
            useVoiceRecordingStore.getState().clearPanelBuffer(removedId);
            unregisterInputController(removedId);
            semanticAnalysisService.unregisterTerminal(removedId);

            const removed = prevById[removedId];
            if (removed?.worktreeId) {
              const worktreeState = useWorktreeSelectionStore.getState();
              const lastFocused = worktreeState.lastFocusedTerminalByWorktree.get(
                removed.worktreeId
              );
              if (lastFocused === removedId) {
                worktreeState.clearWorktreeFocusTracking(removed.worktreeId);
              }
            }
          }
        },
        { equalityFn: shallow }
      )
    )
  );

  // 4. Layout undo history invalidation: when terminal set changes
  //    (add/remove), clear the undo stack since snapshots reference a
  //    different terminal universe.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => state.panelIds,
        (panelIds, prevPanelIds) => {
          const prevIdSet = new Set(prevPanelIds);
          if (panelIds.length !== prevIdSet.size || panelIds.some((id) => !prevIdSet.has(id))) {
            useLayoutUndoStore.getState().clearHistory();
          }
        }
      )
    )
  );

  // 5. Availability → agent-settings re-normalization: installed/missing state
  //    is the input to `normalizeAgentSelection`, so re-run normalization any
  //    time a fresh availability snapshot lands (see issue #5158). Fires on
  //    the `hasRealData: false → true` transition AND on subsequent
  //    `availability` reference changes — the latter covers the focus-refresh
  //    path in `useAgentLauncher`, where a user who installs a CLI outside
  //    Daintree needs their tray/toolbar state to reconcile without an app
  //    restart. `cliAvailabilityStore` only swaps the `availability` object
  //    on real IPC completion, so ref equality is a reliable trigger.
  disposables.add(
    toDisposable(
      useCliAvailabilityStore.subscribe(
        (state) => ({ hasRealData: state.hasRealData, availability: state.availability }),
        (selected, prevSelected) => {
          const realDataLanded = selected.hasRealData && !prevSelected.hasRealData;
          const availabilityChanged = selected.availability !== prevSelected.availability;
          if (!realDataLanded && !availabilityChanged) return;
          const { isInitialized, isLoading } = useAgentSettingsStore.getState();
          if (!isInitialized || isLoading) return;
          void useAgentSettingsStore.getState().refresh();
        },
        { equalityFn: shallow }
      )
    )
  );

  cleanupFn = () => {
    disposables.dispose();
    cleanupFn = null;
  };

  return cleanupFn;
}

export function destroyStoreOrchestrator(): void {
  // Kept out of the DisposableStore on purpose: only `destroyStoreOrchestrator`
  // cancels the pending debounce. HMR teardown (`import.meta.hot.dispose` in
  // `main.tsx`) calls the cleanup fn directly and intentionally does NOT cancel,
  // matching pre-refactor behavior.
  debouncedPersistMruList.cancel();
  cleanupFn?.();
}
