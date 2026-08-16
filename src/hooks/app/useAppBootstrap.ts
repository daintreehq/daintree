import { useEffect, useState } from "react";
import { useAppBoot } from "./useAppBoot";
import { useCrashRecoveryGate } from "./useCrashRecoveryGate";
import { useAppHydration } from "./useAppHydration";
import { useShortcutHints } from "./useShortcutHints";
import { useGettingStartedChecklist } from "./useGettingStartedChecklist";
import { useOrchestrationMilestones } from "./useOrchestrationMilestones";
import { useAgentWaitingNudge } from "./useAgentWaitingNudge";
import { useForgeEnableRecommendation } from "./useForgeEnableRecommendation";
import { useFocusOnActivateIntent } from "./useFocusOnActivateIntent";
import { useSleptProjectTransition } from "./useSleptProjectTransition";
import { useBackgroundWindowResize } from "./useBackgroundWindowResize";
import { useClearSwitchBusyStateOnReveal } from "./useClearSwitchBusyStateOnReveal";
import { usePluginDeepLink } from "./usePluginDeepLink";
import { usePluginArchiveInstallIntent } from "./usePluginArchiveInstallIntent";
import { useNotificationHistoryPruning } from "./useNotificationHistoryPruning";
import { useMissingPrerequisiteWarning } from "./useMissingPrerequisiteWarning";
import { useUpdateListener } from "@/hooks/useUpdateListener";
import { removeStartupSkeleton } from "@/utils/removeStartupSkeleton";
import { useNotificationSettingsStore, usePluginManagerStore } from "@/store";
import { preloadNewWorktreeDialog } from "@/components/Sidebar";
import { primeRadix } from "@/components/ui/radix-loader";
import {
  preloadSettingsDialog,
  preloadActionPalette,
  preloadQuickSwitcher,
  preloadProjectSwitcherPalette,
  preloadWorktreePalette,
  preloadNewTerminalPalette,
  preloadPanelPalette,
  preloadThemePalette,
  preloadSendToAgentPalette,
  preloadQuickCreatePalette,
  preloadLogLevelPalette,
  preloadPluginManagerView,
  preloadWorktreeOverviewModal,
  preloadShortcutReferenceDialog,
  preloadCrossWorktreeDiff,
  loadJetbrainsMono500,
  loadJetbrainsMono600,
} from "@/lazyPanels";

/**
 * Composes the app's cold-start orchestration: batched boot payload, crash
 * recovery gate, hydration, the deferred post-hydration housekeeping hooks,
 * and the idle-time prefetch of palette/dialog chunks. Call once from
 * `AppInner` — the internal hook order here must stay unconditional and
 * stable across renders, same as any other custom hook.
 */
export function useAppBootstrap() {
  // Batched cold-start payload — replaces the legacy fan-out of
  // crash-recovery:get-pending + crash-recovery:get-config + app:hydrate +
  // terminal-config:get into a single IPC round-trip (#8620). The IPC is fired
  // at module-eval time and read here via `use()` (#8820); a boot failure
  // resolves to `{ ok: false }` so the app still renders its cold-start chrome.
  const safeBoot = useAppBoot();
  const bootResult = safeBoot.ok ? safeBoot.result : null;

  // Crash recovery gate — must resolve before hydration runs
  const {
    state: crashState,
    resolve: resolveCrash,
    updateConfig: updateCrashConfig,
  } = useCrashRecoveryGate(bootResult);

  const crashResolved = crashState.status !== "loading" && crashState.status !== "pending";

  // When crash recovery was pending at boot, the resolve path (`restoreBackup`
  // or `resetToFresh` in CrashRecoveryService) mutates `store.appState` after
  // `bootResult` was captured. Passing the stale prefetched payload would
  // hydrate from the pre-resolution terminal list and skip the one-shot
  // `consumePanelFilter` the restore path queued. Force the live IPC path in
  // that case so hydration reads the post-resolution store.
  const hadPendingCrash = bootResult?.crashPending != null;
  // App lifecycle hooks
  const { isStateLoaded } = useAppHydration(crashResolved, hadPendingCrash ? null : bootResult);
  useEffect(() => {
    if (isStateLoaded) removeStartupSkeleton();
  }, [isStateLoaded]);

  // Cross-project focus intent receiver. Subscribes unconditionally so the
  // listener is registered before `notifyViewPainted` fires, then defers the
  // local `agent.focusNextWaiting` dispatch until hydration completes (the
  // paint signal arrives before panel state is loaded — a direct dispatch
  // would silently no-op against an empty panelStore).
  useFocusOnActivateIntent(isStateLoaded);
  useSleptProjectTransition();
  // Background window-resize receiver — keeps PTY geometry tracking the
  // window while this project view is detached (#10415).
  useBackgroundWindowResize();
  // Clears the stale switch busy flags when this cached view is reactivated, so
  // a view that switched away never resurfaces a stuck ProjectSwitcher spinner
  // on return (#10736).
  useClearSwitchBusyStateOnReveal();
  // `daintree://` deep-link receiver (#9559). Surfaces the intent once hydration
  // settles; the effect below opens the Plugin Manager, which consumes it.
  const pluginDeepLink = usePluginDeepLink(isStateLoaded);
  // Double-clicked `.dntr` archives (#11280). Queued on arrival — the
  // confirmation dialog mounts behind hydration and reads the queue.
  usePluginArchiveInstallIntent();
  useEffect(() => {
    if (!pluginDeepLink.intent) return;
    // Opening the manager also closes Settings via the open-transition effect
    // above, so the two surfaces don't stack when the deep link arrives.
    usePluginManagerStore.getState().open();
  }, [pluginDeepLink.intent]);
  // The skeleton is z-index 9999 and intercepts pointer events. The crash
  // recovery dialog is rendered before hydration completes, so without this
  // the dialog would be visible but unclickable until hydration finishes
  // (which it can't, since the user must resolve the crash first).
  useEffect(() => {
    if (crashState.status === "pending" || crashState.status === "failed") {
      removeStartupSkeleton();
    }
  }, [crashState.status]);
  useEffect(() => {
    void useNotificationSettingsStore.getState().hydrate();
    // Subscribe to OS DND transitions before hydrate resolves so a transition
    // mid-hydration cannot be missed. Push events from main are tolerant of
    // an `undefined` namespace at preload (renderer harness in tests).
    const unsubscribe = window.electron?.osDnd?.onStateChanged?.((payload) => {
      useNotificationSettingsStore.getState().setOsDndActive(payload.osDndActive);
    });
    return () => unsubscribe?.();
  }, []);
  // Defers the post-hydration housekeeping IPC reads (shortcut-hint counts,
  // milestones, forge-recommendation plugin/remotes probes) out of the
  // synchronous isStateLoaded effect flush: their sends would otherwise land
  // on main ahead of the loaded-frame paint and compete with the
  // deferred-services drain. The flag flips from the background-priority task
  // below, so the gated hooks hydrate at idle; each reconciles current store
  // state on attach, so nothing observable is lost in the gap.
  const [idleHousekeepingReady, setIdleHousekeepingReady] = useState(false);
  useShortcutHints(isStateLoaded && idleHousekeepingReady);
  const gettingStarted = useGettingStartedChecklist(isStateLoaded);
  const onboardingOverlayActive = gettingStarted.visible || gettingStarted.showCelebration;
  useUpdateListener(onboardingOverlayActive);
  useOrchestrationMilestones(isStateLoaded && idleHousekeepingReady);
  useAgentWaitingNudge(isStateLoaded);
  useForgeEnableRecommendation(isStateLoaded && idleHousekeepingReady);
  useNotificationHistoryPruning();
  // Gated on the idle flag so the prerequisite probe — which spawns
  // subprocesses and awaits refreshPath()'s 10s budget — lands after first
  // paint rather than on the boot path (#11763).
  useMissingPrerequisiteWarning(isStateLoaded && idleHousekeepingReady);

  useEffect(() => {
    if (!isStateLoaded) return;

    const controller = new AbortController();

    const execute = () => {
      if (controller.signal.aborted) return;
      setIdleHousekeepingReady(true);
      void preloadSettingsDialog();
      void preloadNewWorktreeDialog();
      void preloadActionPalette();
      void preloadQuickSwitcher();
      preloadProjectSwitcherPalette().catch(() => {});
      void preloadWorktreePalette();
      void preloadNewTerminalPalette();
      void preloadPanelPalette();
      void preloadThemePalette();
      void preloadSendToAgentPalette();
      void preloadQuickCreatePalette();
      void preloadLogLevelPalette();
      void preloadPluginManagerView();
      void preloadWorktreeOverviewModal();
      void preloadShortcutReferenceDialog();
      void preloadCrossWorktreeDiff();
      loadJetbrainsMono500().catch(() => {});
      loadJetbrainsMono600().catch(() => {});
      // Warm the shared Radix overlay primitives chunk (`radix-deferred`) so the
      // ProjectSwitcherPalette popover and context menus are ready on first
      // interaction in a freshly loaded project view. Otherwise this chunk is
      // only demand-loaded on the first pointer/focus gesture (#10752). Each
      // WebContentsView has its own module cache, so this fires per view.
      primeRadix().catch(() => {});
    };

    if (typeof scheduler !== "undefined" && typeof scheduler.postTask === "function") {
      void scheduler
        .postTask(execute, { priority: "background", signal: controller.signal })
        .catch(() => {});
    } else {
      const id = requestIdleCallback(execute, { timeout: 5000 });
      const cancel = () => cancelIdleCallback(id);
      controller.signal.addEventListener("abort", cancel, { once: true });
    }

    return () => controller.abort();
  }, [isStateLoaded]);

  return {
    bootResult,
    crashState,
    resolveCrash,
    updateCrashConfig,
    crashResolved,
    isStateLoaded,
    pluginDeepLink,
    gettingStarted,
  };
}
