import { shallow } from "zustand/shallow";
import { usePanelStore } from "./panelStore";
import {
  useWorktreeSelectionStore,
  isMruRecordingSuppressed,
  persistMruList,
} from "./worktreeStore";
import { useFleetArmingStore, subscribeFleetArmingPanelPruning } from "./fleetArmingStore";
import { subscribeFleetTargetOverridesPruning } from "./fleetTargetOverridesStore";
import { subscribeFleetFailureAutoClear } from "./fleetFailureStore";
import { subscribeFleetRunWatcher } from "./fleetRunStore";
import { useTerminalInputStore, unregisterInputController } from "./terminalInputStore";
import { subscribeFleetBroadcastResult } from "@/components/Fleet/fleetRawInputBroadcast";
import { semanticAnalysisService } from "@/services/SemanticAnalysisService";
import { useConsoleCaptureStore } from "./consoleCaptureStore";
import { useResourceMonitoringStore } from "./resourceMonitoringStore";
import { useVoiceRecordingStore } from "./voiceRecordingStore";
import { usePluginPanelBadgeStore } from "./pluginPanelBadgeStore";
import { useLayoutUndoStore } from "./layoutUndoStore";
import { useCliAvailabilityStore } from "./cliAvailabilityStore";
import { useAgentSettingsStore } from "./agentSettingsStore";
import { removeArtifactsForTerminal } from "@/hooks/useArtifacts";
import {
  setPanelStoreAccessor,
  setPanelStoreClearForSwitchAccessor,
  setWorktreeSelectionAccessor,
  setWorktreeIdSetAccessor,
  setFleetArmingClearAccessor,
  setFleetArmedIdsAccessor,
  setFleetLastArmedIdAccessor,
  resetStoreAccessorsForTesting,
} from "./storeAccessors";
import { getCurrentViewStoreOrNull } from "./createWorktreeStore";
import { setActiveContextAccessors } from "@/lib/notify";
import { debounce } from "@/utils/debounce";
import { DisposableStore, toDisposable } from "@/utils/disposable";
import { isPtyPanel } from "@shared/types/panel";
import { terminalClient } from "@/clients";

// Thunk form: read the live mruList at fire time, not at schedule time. A
// snapshot captured at schedule time could be stale by the time the debounce
// fires and would clobber a fresher immediate persistMruList() from a
// deliberate worktree selection (#9922). persistMruList already version-
// sequences and dedupes, so the last writer with the live list wins.
const debouncedPersistMruList = debounce(
  () => persistMruList(usePanelStore.getState().mruList),
  1000
);

let cleanupFn: (() => void) | null = null;

function refreshAgentSettingsFromAvailability(): void {
  const { isInitialized, isLoading } = useAgentSettingsStore.getState();
  if (!isInitialized || isLoading) return;
  void useAgentSettingsStore.getState().refresh();
}

export function initStoreOrchestrator(): () => void {
  // Cross-store accessors are registered up-front, BEFORE the idempotency
  // guard, so tests that `destroyStoreOrchestrator()` + re-init reconnect
  // their accessor closures to the current store singletons. The closures
  // resolve `getState()` lazily on each call (no stale-snapshot capture).
  setPanelStoreAccessor(() => {
    const s = usePanelStore.getState();
    return { panelsById: s.panelsById, panelIds: s.panelIds, tabGroups: s.tabGroups };
  });
  setPanelStoreClearForSwitchAccessor(() => {
    usePanelStore.getState().clearTerminalStoreForSwitch();
  });
  setWorktreeSelectionAccessor(() => ({
    activeWorktreeId: useWorktreeSelectionStore.getState().activeWorktreeId,
    restoreWorktreeId: useWorktreeSelectionStore.getState().restoreWorktreeId,
  }));
  setWorktreeIdSetAccessor(() => {
    const viewStore = getCurrentViewStoreOrNull();
    if (!viewStore) return null;
    return new Set(viewStore.getState().worktrees.keys());
  });
  setFleetArmingClearAccessor(() => {
    useFleetArmingStore.getState().clear();
  });
  setFleetArmedIdsAccessor(() => useFleetArmingStore.getState().armedIds);
  setFleetLastArmedIdAccessor(() => useFleetArmingStore.getState().lastArmedId);

  if (cleanupFn) return cleanupFn;

  // Register accessors so notify() can suppress toasts whose origin surface
  // (worktree or panel) is already visible, and promote them if the user
  // navigates away within the grace window.
  setActiveContextAccessors({
    getActiveWorktreeId: () => useWorktreeSelectionStore.getState().activeWorktreeId,
    getFocusedPanelId: () => usePanelStore.getState().focusedId,
    subscribeActiveContext: (cb) => {
      const unsubWorktree = useWorktreeSelectionStore.subscribe((state, prev) => {
        if (state.activeWorktreeId !== prev.activeWorktreeId) cb();
      });
      const unsubPanel = usePanelStore.subscribe(
        (state) => state.focusedId,
        () => cb()
      );
      return () => {
        unsubWorktree();
        unsubPanel();
      };
    },
  });

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
            // Focus promotion is incidental, not a deliberate selection: mark it
            // so it doesn't become the persisted restore target (#9512).
            worktreeState.selectWorktree(terminal.worktreeId, { source: "focus" });
          }
        }
      )
    )
  );

  // 1c. Terminal MRU recording: append the newly focused terminal to the
  //     MRU list and persist it (debounced) unless suppressed. Only PTY
  //     panels (kind "terminal") become quick-switcher items, so non-PTY
  //     panels (browser, dev-preview, review) must not pollute the capped
  //     MRU list with entries the switcher will never show (#9922).
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => state.focusedId,
        (focusedId) => {
          if (!focusedId) return;
          if (isMruRecordingSuppressed()) return;
          const panel = usePanelStore.getState().panelsById[focusedId];
          // Only record panels the quick switcher can actually show — mirror
          // its item filter (PTY kind, persisted, has a live PTY). Help/overlay
          // terminals carry excludeFromPersistence and must not eat the cap.
          if (!panel || !isPtyPanel(panel)) return;
          if (panel.excludeFromPersistence === true) return;
          if (panel.hasPty === false) return;
          usePanelStore.getState().recordMru(`terminal:${focusedId}`);
          debouncedPersistMruList();
        }
      )
    )
  );

  // 1d. Focused-terminal signal to pty-host: report which terminal is focused
  //     so the backend can prioritize it in per-window backpressure and output
  //     batching (#10878). Only a PTY panel with a live PTY qualifies; focusing
  //     a browser/dev-preview/review panel, or clearing focus, sends null so the
  //     host stops prioritizing. Fire-and-forget; Zustand dedupes no-op fires.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => state.focusedId,
        (focusedId) => {
          let terminalId: string | null = null;
          if (focusedId) {
            const panel = usePanelStore.getState().panelsById[focusedId];
            if (panel && isPtyPanel(panel) && panel.hasPty !== false) {
              terminalId = focusedId;
            }
          }
          terminalClient.setFocusedTerminal(terminalId);
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
            // Prune the panel's resource-metrics entry. The PTY `onExit` path
            // (lifecycle.ts) already calls this for terminals that exit cleanly,
            // but force-removal (browser/dev-preview panels, or worktree teardown
            // shrinking `panelIds` without a PTY exit) bypasses that path and
            // would otherwise leak the `metrics` Map entry. `removePanel` is a
            // no-op when the id is absent, so the double-call is safe (#9536).
            useResourceMonitoringStore.getState().removePanel(removedId);
            // Prune the panel's plugin badge entries (#10908). Like the
            // resource-metrics store above this leaks otherwise: badges are
            // keyed by panelId and nothing else drops them when a panel closes.
            usePluginPanelBadgeStore.getState().removePanel(removedId);
            useVoiceRecordingStore.getState().clearPanelBuffer(removedId);
            // Drop the dictation lock if it was pinned to this panel — panelIds
            // are ephemeral and a stale lock would silently break routing.
            useVoiceRecordingStore.getState().clearLockedTarget(removedId);
            unregisterInputController(removedId);
            semanticAnalysisService.unregisterTerminal(removedId);
            // Drop the renderer-side artifact store entry so content strings
            // don't pin the dead panel's heap for the rest of the renderer
            // lifetime (#10023). The hook listener Set is owned by each
            // mounted `useArtifacts` consumer's own `useEffect` cleanup.
            removeArtifactsForTerminal(removedId);

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

  // 3b. Voice-dictation lock auto-clear: a trashed panel isn't a valid
  //     dictation target, but trashPanel doesn't remove the id from
  //     `panelIds` (it only flips `location` to "trash") — so section-3
  //     above never fires. Watch the locked panel's `location` directly and
  //     drop the lock when it transitions to trash. Selector returns a
  //     primitive (panelId or null) so unrelated `panelsById` mutations don't
  //     wake this subscription.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => {
          const lockedId = useVoiceRecordingStore.getState().lockedTarget?.panelId;
          if (!lockedId) return null;
          return state.panelsById[lockedId]?.location ?? null;
        },
        (location) => {
          if (location !== "trash") return;
          const lockedId = useVoiceRecordingStore.getState().lockedTarget?.panelId;
          if (lockedId) {
            useVoiceRecordingStore.getState().clearLockedTarget(lockedId);
          }
        }
      )
    )
  );

  // 3c. Artifact-store trash cleanup: same `trashPanel`-doesn't-shrink-
  //     `panelIds` constraint as 3b above, but for the renderer-side artifact
  //     Map. The user-close path (`trashPanel`) flips `panelsById[id].location`
  //     to "trash" and adds the id to `trashedTerminals` — `panelIds` is
  //     unchanged, so the section-3 subscriber bails. Watch the
  //     `trashedTerminals` map's key set; for each newly-trashed id, drop
  //     the artifact store entry. Selector returns a primitive (the key
  //     count plus a sorted key fingerprint) so unrelated `panelsById`
  //     mutations don't wake this subscription. The Map reference itself
  //     swaps on every change in `registrySlice.trashPanel`, so ref
  //     equality is a reliable trigger.
  disposables.add(
    toDisposable(
      usePanelStore.subscribe(
        (state) => state.trashedTerminals,
        (trashed, prevTrashed) => {
          if (trashed === prevTrashed) return;
          for (const id of trashed.keys()) {
            if (!prevTrashed.has(id)) {
              removeArtifactsForTerminal(id);
            }
          }
        }
      )
    )
  );

  // 5a. Fleet-arming panel pruning: drop armed ids when their panels are
  //     removed, trashed, backgrounded, or otherwise become fleet-ineligible.
  //     Lives in the orchestrator so HMR/test teardown cleans the subscription
  //     deterministically (previously this was a module-scope subscription in
  //     `fleetArmingStore.ts`).
  disposables.add(toDisposable(subscribeFleetArmingPanelPruning()));

  // 5b. Fleet per-target overrides pruning: drop a pane's payload override /
  //     skip flag when it leaves the armed set, so a disarmed-then-rearmed pane
  //     isn't silently excluded from the next broadcast by a stale skip (#9973).
  //     Same orchestrator-scoped lifecycle as the arming pruning above.
  disposables.add(toDisposable(subscribeFleetTargetOverridesPruning()));

  // 5c. Fleet broadcast-result subscription: per-target write results for
  //     keystroke broadcasts (dead-PTY auto-disarm + transient failure chip).
  //     Lives here for the same HMR/`vi.resetModules()` reason as 5a — the
  //     IIFE that previously owned this discarded its IPC unsubscribe and
  //     gated re-registration on a `globalThis` flag, which left stale
  //     callbacks firing against orphaned store instances after a module
  //     reset (issue #9967).
  disposables.add(toDisposable(subscribeFleetBroadcastResult()));

  // 5d. Fleet-failure auto-clear: drop failure pills when the armed set drains
  //     or a single pane is disarmed. Lives in the orchestrator for the same
  //     HMR/test-teardown reason as 5a — the module-scope subscription in
  //     `fleetFailureStore.ts` was never torn down and the `globalThis`
  //     registration guard mishandled re-registration under HMR (#9923).
  disposables.add(toDisposable(subscribeFleetFailureAutoClear()));

  // 5e. Fleet-run watcher: drives the supervised run's `watching` phase —
  //     refreshes per-target agent-state snapshots on panel changes and
  //     finalizes the run (with its durable run-history append) once every
  //     target settles. Same orchestrator-scoped lifecycle as 5a–5d (#10930).
  disposables.add(toDisposable(subscribeFleetRunWatcher()));

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
          refreshAgentSettingsFromAvailability();
        },
        { equalityFn: shallow }
      )
    )
  );

  // 6. Loading-race backstop for the same availability → settings sync.
  // If the first real CLI snapshot lands while agent settings are still
  // hydrating, the subscription above intentionally does not refresh a store
  // that is mid-initialize. Re-check when the settings store becomes ready so
  // first-run default pins are not missed on fast availability probes.
  disposables.add(
    toDisposable(
      useAgentSettingsStore.subscribe((state, prevState) => {
        const becameReady =
          state.isInitialized &&
          !state.isLoading &&
          (!prevState.isInitialized || prevState.isLoading);
        if (!becameReady) return;
        if (!useCliAvailabilityStore.getState().hasRealData) return;
        refreshAgentSettingsFromAvailability();
      })
    )
  );

  // 7. Flush the MRU debounce before the view is torn down. The 150ms debounce
  //    above strands the latest MRU write if the user switches projects, closes
  //    the window, or quits within the debounce window. `visibilitychange`
  //    fires on WebContentsView detach while the renderer is still alive and
  //    IPC channels are open, so the async persist completes (#9914). Mirrors
  //    the `pagehide` flush in `optimisticPanelClose.ts`, but uses
  //    `visibilitychange` because `persistMruList` is async IPC, which would
  //    not complete in the late `pagehide` teardown window.
  if (typeof document !== "undefined") {
    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      void debouncedPersistMruList.flush();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    disposables.add(
      toDisposable(() => document.removeEventListener("visibilitychange", handleVisibilityChange))
    );
    // Cover the race where the document is already hidden at init time.
    if (document.hidden) void debouncedPersistMruList.flush();
  }

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
  // Clear cross-store accessor slots so any code path that consumes them
  // between destroy and a subsequent init sees null (the documented
  // unset-fallback behavior) rather than stale closures bound to a torn-down
  // subscription set.
  resetStoreAccessorsForTesting();
}
