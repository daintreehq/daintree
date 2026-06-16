import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";
import { isElectronAvailable } from "../useElectron";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { getOnboardingState } from "@/clients/onboardingClient";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { ChecklistState, ChecklistItemId } from "@shared/types/ipc/maps";
import { ACTIVE_AGENT_STATES } from "@shared/types/agent";
import { isPtyPanel } from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

function countActiveAgentPanels(panelsById: Record<string, CarrierPanel>): number {
  let count = 0;
  for (const raw of Object.values(panelsById)) {
    if (!raw || !isPtyPanel(raw)) continue;
    if (!raw.detectedAgentId && !raw.launchAgentId) continue;
    const state = raw.agentState;
    if (state && ACTIVE_AGENT_STATES.has(state)) count += 1;
    if (count >= 2) return count;
  }
  return count;
}

export interface GettingStartedChecklistState {
  visible: boolean;
  collapsed: boolean;
  checklist: ChecklistState | null;
  showCelebration: boolean;
  dismiss: () => void;
  toggleCollapse: () => void;
  notifyOnboardingComplete: () => void;
  markItem: (item: ChecklistItemId) => void;
}

function reconcileCurrentState(
  markItem: (item: ChecklistItemId) => void,
  getChecklist: () => ChecklistState | null
) {
  const cl = getChecklist();
  if (!cl || cl.dismissed) return;

  if (!cl.items.openedProject && useProjectStore.getState().currentProject !== null) {
    markItem("openedProject");
  }
  if (
    !cl.items.launchedAgent &&
    usePanelStore.getState().panelIds.some((id) => {
      const p = usePanelStore.getState().panelsById[id];
      if (!p || !isPtyPanel(p)) return false;
      return Boolean(p.launchAgentId) || Boolean(p.detectedAgentId) || p.everDetectedAgent === true;
    })
  ) {
    markItem("launchedAgent");
  }
  if (!cl.items.createdWorktree && getCurrentViewStore().getState().worktrees.size > 1) {
    markItem("createdWorktree");
  }
  if (
    !cl.items.ranSecondParallelAgent &&
    countActiveAgentPanels(usePanelStore.getState().panelsById) >= 2
  ) {
    markItem("ranSecondParallelAgent");
  }
}

const CELEBRATION_CLEAR_MS = 1500;

export function useGettingStartedChecklist(isStateLoaded: boolean): GettingStartedChecklistState {
  const [checklist, setChecklist] = useState<ChecklistState | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [forceShow, setForceShow] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const checklistRef = useRef(checklist);
  // Auto-collapse the checklist to its minimized state once, after the user is
  // clearly engaged (launched an agent AND interacted with a panel). Mount-
  // scoped so Help > Getting Started can always reopen it: a forced show sets
  // the latch (below) so it won't be re-collapsed against the user's intent.
  const hasAutoCollapsed = useRef(false);

  const prefersReducedMotion = useReducedMotion();
  const celebrationClearMs = prefersReducedMotion ? 0 : CELEBRATION_CLEAR_MS;

  useEffect(() => {
    checklistRef.current = checklist;
  }, [checklist]);

  const markItem = useCallback((item: ChecklistItemId) => {
    if (!isElectronAvailable()) return;
    safeFireAndForget(window.electron.onboarding.markChecklistItem(item), {
      context: "Marking onboarding checklist item",
    });

    // Decide side effects against the latest committed state via the ref so
    // we never depend on React running the updater synchronously inside the
    // dispatch (it doesn't, in concurrent mode).
    const prev = checklistRef.current;
    if (!prev || prev.dismissed || prev.items[item]) return;

    const updatedItems = { ...prev.items, [item]: true };
    const allDone = Object.values(updatedItems).every(Boolean);
    const next: ChecklistState = allDone
      ? { ...prev, items: updatedItems, celebrationShown: true }
      : { ...prev, items: updatedItems };

    setChecklist(next);
    checklistRef.current = next;

    if (allDone && !prev.celebrationShown) {
      setShowCelebration(true);
      safeFireAndForget(window.electron.onboarding.markChecklistCelebrationShown(), {
        context: "Marking onboarding celebration shown",
      });
    }
  }, []);

  const dismiss = useCallback(() => {
    if (!isElectronAvailable()) return;
    safeFireAndForget(window.electron.onboarding.dismissChecklist(), {
      context: "Dismissing onboarding checklist (user action)",
    });
    const prev = checklistRef.current;
    if (prev) {
      const next = { ...prev, dismissed: true };
      checklistRef.current = next;
      setChecklist(next);
    }
    setForceShow(false);
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  // Collapse once the user has both launched an agent and interacted with a
  // panel (`focusedId` is set by setFocused/openDockTerminal/activateTerminal
  // — the canonical "touched a panel" signal). Reads the latest committed
  // checklist via the ref so a just-marked `launchedAgent` is observed in the
  // same tick. Stable identity so every caller (panel subscriber, mount
  // reconcile, push handler) collapses through one latch.
  const maybeAutoCollapse = useCallback(() => {
    if (hasAutoCollapsed.current) return;
    const cl = checklistRef.current;
    if (!cl || cl.dismissed || !cl.items.launchedAgent) return;
    if (usePanelStore.getState().focusedId === null) return;
    hasAutoCollapsed.current = true;
    setCollapsed(true);
  }, []);

  // Hydrate checklist state and check onboarding completion
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;
    if (!window.electron?.onboarding) return;

    // getOnboardingState shares the same-tick onboarding fetch with
    // useAgentWaitingNudge's effect in the same flush.
    Promise.all([getOnboardingState(), window.electron.onboarding.getChecklist()])
      .then(([onboarding, checklistState]) => {
        setOnboardingCompleted(onboarding.completed);
        setChecklist(checklistState);
      })
      .catch((err) => logError("Failed to load checklist state", err));
  }, [isStateLoaded]);

  // Subscribe to main-process checklist pushes. Every active WebContentsView
  // receives the push via `broadcastToRenderer`, so cached views stay in sync.
  // We merge by taking the union of truthy items rather than overwriting — this
  // prevents a pre-push `getChecklist()` hydration promise from clobbering a
  // newer push.
  useEffect(() => {
    if (!isElectronAvailable() || !window.electron?.onboarding?.onChecklistPush) return;
    return window.electron.onboarding.onChecklistPush((next) => {
      setChecklist((prev) => {
        if (!prev) {
          // Sync the ref synchronously so a markItem firing before React
          // commits doesn't read a stale null value.
          checklistRef.current = next;
          return next;
        }
        const mergedItems = { ...prev.items } as typeof prev.items;
        for (const key of Object.keys(next.items) as Array<keyof typeof next.items>) {
          if (next.items[key] || prev.items[key]) mergedItems[key] = true;
        }
        const merged: ChecklistState = {
          ...next,
          items: mergedItems,
          dismissed: prev.dismissed || next.dismissed,
          celebrationShown: prev.celebrationShown || next.celebrationShown,
        };
        checklistRef.current = merged;
        return merged;
      });
    });
  }, []);

  // Re-check auto-collapse whenever the committed checklist changes (hydration,
  // a markItem, or a cross-window push that flips `launchedAgent`). Runs after
  // commit so `checklistRef` is fresh; reads live `focusedId` from the panel
  // store. The panel-store subscriber below covers the complementary case where
  // focus changes after the agent already launched.
  useEffect(() => {
    maybeAutoCollapse();
  }, [checklist, maybeAutoCollapse]);

  // Set up Zustand subscriptions for auto-completion + reconcile current state
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;

    const getChecklist = () => checklistRef.current;
    const viewStore = getCurrentViewStore();

    const unsubs = [
      useProjectStore.subscribe((state) => {
        const cl = getChecklist();
        if (!cl || cl.dismissed || cl.items.openedProject) return;
        if (state.currentProject !== null) {
          markItem("openedProject");
        }
      }),
      usePanelStore.subscribe((state) => {
        const cl = getChecklist();
        if (!cl || cl.dismissed) return;
        if (
          !cl.items.launchedAgent &&
          state.panelIds.some((id) => {
            const p = state.panelsById[id];
            if (!p || !isPtyPanel(p)) return false;
            return (
              Boolean(p.launchAgentId) || Boolean(p.detectedAgentId) || p.everDetectedAgent === true
            );
          })
        ) {
          markItem("launchedAgent");
        }
        if (!cl.items.ranSecondParallelAgent && countActiveAgentPanels(state.panelsById) >= 2) {
          markItem("ranSecondParallelAgent");
        }
        maybeAutoCollapse();
      }),
      viewStore.subscribe((state) => {
        const cl = getChecklist();
        if (!cl || cl.dismissed || cl.items.createdWorktree) return;
        if (state.worktrees.size > 1) {
          markItem("createdWorktree");
        }
      }),
    ];

    reconcileCurrentState(markItem, getChecklist);

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [isStateLoaded, markItem, maybeAutoCollapse]);

  // Listen for Help > Getting Started menu action
  useEffect(() => {
    const handleShow = () => {
      setForceShow(true);
      setCollapsed(false);
      // The user explicitly opened the checklist — don't auto-collapse it out
      // from under them for the rest of this mount.
      hasAutoCollapsed.current = true;
      if (isElectronAvailable() && window.electron?.onboarding) {
        window.electron.onboarding
          .getChecklist()
          .then((state) => {
            setChecklist({ ...state, dismissed: false });
          })
          .catch((err) => logError("Failed to show getting started checklist", err));
      }
    };
    window.addEventListener("daintree:show-getting-started", handleShow);
    return () => window.removeEventListener("daintree:show-getting-started", handleShow);
  }, []);

  // Notify when onboarding completes — show checklist in the same session
  const notifyOnboardingComplete = useCallback(() => {
    if (!isElectronAvailable() || !window.electron?.onboarding) return;
    setOnboardingCompleted(true);
    window.electron.onboarding
      .getChecklist()
      .then((state) => {
        setChecklist(state);
        // Reconcile after hydration in case stores already have data
        setTimeout(() => reconcileCurrentState(markItem, () => checklistRef.current), 0);
      })
      .catch((err) => logError("Failed to notify onboarding complete", err));
  }, [markItem]);

  // Auto-clear celebration after animation completes
  useEffect(() => {
    if (!showCelebration) return;
    const timer = setTimeout(() => setShowCelebration(false), celebrationClearMs);
    return () => clearTimeout(timer);
  }, [showCelebration, celebrationClearMs]);

  const visible =
    checklist !== null && (forceShow || (onboardingCompleted && !checklist.dismissed));

  return {
    visible,
    collapsed,
    checklist,
    showCelebration,
    dismiss,
    toggleCollapse,
    notifyOnboardingComplete,
    markItem,
  };
}
