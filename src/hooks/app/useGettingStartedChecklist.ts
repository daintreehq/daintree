import { useCallback, useEffect, useRef, useState } from "react";
import { isElectronAvailable } from "../useElectron";
import { useProjectStore } from "@/store/projectStore";
import { useTerminalStore } from "@/store/terminalStore";
import { useWorktreeDataStore } from "@/store/worktreeDataStore";
import type { ChecklistState, ChecklistItemId } from "@shared/types/ipc/maps";

export interface GettingStartedChecklistState {
  visible: boolean;
  collapsed: boolean;
  checklist: ChecklistState | null;
  dismiss: () => void;
  toggleCollapse: () => void;
  notifyOnboardingComplete: () => void;
}

let observerInitialized = false;

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
    useTerminalStore.getState().terminals.some((t) => t.kind === "agent")
  ) {
    markItem("launchedAgent");
  }
  if (!cl.items.createdWorktree && useWorktreeDataStore.getState().worktrees.size > 1) {
    markItem("createdWorktree");
  }
}

function initChecklistObserver(
  markItem: (item: ChecklistItemId) => void,
  getChecklist: () => ChecklistState | null
) {
  if (observerInitialized) return;
  observerInitialized = true;

  useProjectStore.subscribe((state) => {
    const cl = getChecklist();
    if (!cl || cl.dismissed || cl.items.openedProject) return;
    if (state.currentProject !== null) {
      markItem("openedProject");
    }
  });

  useTerminalStore.subscribe((state) => {
    const cl = getChecklist();
    if (!cl || cl.dismissed || cl.items.launchedAgent) return;
    const hasAgent = state.terminals.some((t) => t.kind === "agent");
    if (hasAgent) {
      markItem("launchedAgent");
    }
  });

  useWorktreeDataStore.subscribe((state) => {
    const cl = getChecklist();
    if (!cl || cl.dismissed || cl.items.createdWorktree) return;
    if (state.worktrees.size > 1) {
      markItem("createdWorktree");
    }
  });
}

export function useGettingStartedChecklist(isStateLoaded: boolean): GettingStartedChecklistState {
  const [checklist, setChecklist] = useState<ChecklistState | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [forceShow, setForceShow] = useState(false);
  const checklistRef = useRef(checklist);
  checklistRef.current = checklist;

  const markItem = useCallback((item: ChecklistItemId) => {
    if (!isElectronAvailable()) return;
    void window.electron.onboarding.markChecklistItem(item);
    setChecklist((prev) => {
      if (!prev) return prev;
      if (prev.items[item]) return prev;
      const updated: ChecklistState = {
        ...prev,
        items: { ...prev.items, [item]: true },
      };
      const allDone = Object.values(updated.items).every(Boolean);
      if (allDone) {
        void window.electron.onboarding.dismissChecklist();
        return { ...updated, dismissed: true };
      }
      return updated;
    });
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
      .catch(console.error);
  }, [isStateLoaded]);

  // Set up Zustand subscriptions for auto-completion + reconcile current state
  useEffect(() => {
    if (!isElectronAvailable() || !isStateLoaded) return;
    initChecklistObserver(markItem, () => checklistRef.current);
    // Reconcile after hydration settles (checklist may still be null here,
    // but the subscriptions will catch changes going forward)
    reconcileCurrentState(markItem, () => checklistRef.current);
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
          .catch(console.error);
      }
    };
    window.addEventListener("canopy:show-getting-started", handleShow);
    return () => window.removeEventListener("canopy:show-getting-started", handleShow);
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
      .catch(console.error);
  }, [markItem]);

  const allDone = checklist ? Object.values(checklist.items).every(Boolean) : false;
  const visible =
    checklist !== null && (forceShow || (onboardingCompleted && !checklist.dismissed && !allDone));

  return {
    visible,
    collapsed,
    checklist,
    dismiss,
    toggleCollapse,
    notifyOnboardingComplete,
  };
}
