import { useCallback, useEffect, useRef, useState } from "react";
import { isElectronAvailable } from "../useElectron";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { notify } from "@/lib/notify";
import { logError } from "@/utils/logger";
import type { ChecklistState, ChecklistItemId } from "@shared/types/ipc/maps";
import { ACTIVE_AGENT_STATES } from "@shared/types/agent";
import type { TerminalInstance } from "@shared/types/panel";

function countActiveAgentPanels(panelsById: Record<string, TerminalInstance>): number {
  let count = 0;
  for (const panel of Object.values(panelsById)) {
    if (!panel?.detectedAgentId && !panel?.launchAgentId) continue;
    const state = panel.agentState;
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
      return (
        Boolean(p?.launchAgentId) || Boolean(p?.detectedAgentId) || p?.everDetectedAgent === true
      );
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

export function useGettingStartedChecklist(isStateLoaded: boolean): GettingStartedChecklistState {
  const [checklist, setChecklist] = useState<ChecklistState | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [forceShow, setForceShow] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const checklistRef = useRef(checklist);
  useEffect(() => {
    checklistRef.current = checklist;
  }, [checklist]);

  const markItem = useCallback((item: ChecklistItemId) => {
    if (!isElectronAvailable()) return;
    void window.electron.onboarding.markChecklistItem(item);
    let shouldCelebrate = false;
    let shouldDismiss = false;
    setChecklist((prev) => {
      if (!prev) return prev;
      if (prev.items[item]) return prev;
      const updated: ChecklistState = {
        ...prev,
        items: { ...prev.items, [item]: true },
      };
      const allDone = Object.values(updated.items).every(Boolean);
      if (allDone) {
        shouldCelebrate = !prev.celebrationShown;
        shouldDismiss = true;
        return { ...updated, dismissed: true, celebrationShown: true };
      }
      return updated;
    });
    if (shouldDismiss) {
      void window.electron.onboarding.dismissChecklist();
    }
    if (shouldCelebrate) {
      notify({
        type: "success",
        title: "Checklist complete!",
        message: "You're all set! Open the Action Palette (Cmd+K) to explore shortcuts.",
        duration: 5000,
      });
      setShowCelebration(true);
      void window.electron.onboarding.markChecklistCelebrationShown();
    }
  }, []);

  const dismiss = useCallback(() => {
    if (!isElectronAvailable()) return;
    void window.electron.onboarding.dismissChecklist();
    setChecklist((prev) => (prev ? { ...prev, dismissed: true } : prev));
    setForceShow(false);
  }, []);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  // Hydrate checklist state and check onboarding completion
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;
    if (!window.electron?.onboarding) return;

    Promise.all([window.electron.onboarding.get(), window.electron.onboarding.getChecklist()])
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
        if (!prev) return next;
        const mergedItems = { ...prev.items } as typeof prev.items;
        for (const key of Object.keys(next.items) as Array<keyof typeof next.items>) {
          if (next.items[key] || prev.items[key]) mergedItems[key] = true;
        }
        return {
          ...next,
          items: mergedItems,
          dismissed: prev.dismissed || next.dismissed,
          celebrationShown: prev.celebrationShown || next.celebrationShown,
        };
      });
    });
  }, []);

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
            return (
              Boolean(p?.launchAgentId) ||
              Boolean(p?.detectedAgentId) ||
              p?.everDetectedAgent === true
            );
          })
        ) {
          markItem("launchedAgent");
        }
        if (!cl.items.ranSecondParallelAgent && countActiveAgentPanels(state.panelsById) >= 2) {
          markItem("ranSecondParallelAgent");
        }
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
  }, [isStateLoaded, markItem]);

  // Listen for Help > Getting Started menu action
  useEffect(() => {
    const handleShow = () => {
      setForceShow(true);
      setCollapsed(false);
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
    const timer = setTimeout(() => setShowCelebration(false), 1500);
    return () => clearTimeout(timer);
  }, [showCelebration]);

  const allDone = checklist ? Object.values(checklist.items).every(Boolean) : false;
  const visible =
    checklist !== null && (forceShow || (onboardingCompleted && !checklist.dismissed && !allDone));

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
