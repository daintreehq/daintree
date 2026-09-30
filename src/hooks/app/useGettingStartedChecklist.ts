import { useCallback, useEffect, useRef, useState } from "react";
import { isElectronAvailable } from "../useElectron";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { getCurrentViewStore } from "@/store/createWorktreeStore";
import { getOnboardingState } from "@/clients/onboardingClient";
import { useAgentDiscoveryOnboarding } from "./useAgentDiscoveryOnboarding";
import { logError } from "@/utils/logger";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import type { ChecklistState, ChecklistItemId } from "@shared/types/ipc/maps";
import { ACTIVE_AGENT_STATES } from "@shared/types/agent";
import { isPtyPanel } from "@shared/types/panel";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";

function isChecklistComplete(checklist: ChecklistState): boolean {
  return Object.values(checklist.items).every(Boolean);
}

type CarrierPanel = Parameters<typeof getNarrowPanel>[0][string];

function isLaunchedAgentPanel(p: CarrierPanel | undefined): boolean {
  if (!p || !isPtyPanel(p)) return false;
  return Boolean(p.launchAgentId) || Boolean(p.detectedAgentId) || p.everDetectedAgent === true;
}

function isActiveAgentPanel(p: CarrierPanel | undefined): boolean {
  if (!p || !isPtyPanel(p)) return false;
  if (!p.detectedAgentId && !p.launchAgentId) return false;
  const state = p.agentState;
  return Boolean(state && ACTIVE_AGENT_STATES.has(state));
}

function countActiveAgentPanels(panelsById: Record<string, CarrierPanel>): number {
  let count = 0;
  for (const raw of Object.values(panelsById)) {
    if (isActiveAgentPanel(raw)) count += 1;
    if (count >= 2) return count;
  }
  return count;
}

type PanelState = ReturnType<typeof usePanelStore.getState>;

// What the last full or incremental pass over the panel store established.
// `launchMiss` records that no panel in `panelIds` qualified for
// `launchedAgent`; `activeCount` is the exact active-agent count across
// `panelsById` (null once it reached 2, where the scan stops counting).
interface AgentScan {
  panelsById: PanelState["panelsById"];
  panelIds: PanelState["panelIds"];
  keyCount: number;
  launchMiss: boolean;
  activeCount: number | null;
}

function fullAgentScan(state: PanelState, checkLaunch: boolean): AgentScan {
  const launchMiss =
    checkLaunch && !state.panelIds.some((id) => isLaunchedAgentPanel(state.panelsById[id]));
  let keyCount = 0;
  let activeCount = 0;
  for (const id in state.panelsById) {
    keyCount += 1;
    if (isActiveAgentPanel(state.panelsById[id])) activeCount += 1;
  }
  return {
    panelsById: state.panelsById,
    panelIds: state.panelIds,
    keyCount,
    launchMiss,
    activeCount: activeCount >= 2 ? null : activeCount,
  };
}

// Re-examines only the panel records replaced since `prev`: a record that is
// still the same object cannot have changed either answer. Falls back to a
// full scan when membership moved or the previous pass left no usable answer.
function nextAgentScan(prev: AgentScan | null, state: PanelState, checkLaunch: boolean): AgentScan {
  if (
    !prev ||
    prev.panelIds !== state.panelIds ||
    prev.activeCount === null ||
    (checkLaunch && !prev.launchMiss)
  ) {
    return fullAgentScan(state, checkLaunch);
  }
  if (prev.panelsById === state.panelsById) return prev;

  let launchHit = false;
  if (checkLaunch) {
    for (const id of state.panelIds) {
      const panel = state.panelsById[id];
      if (panel !== prev.panelsById[id] && isLaunchedAgentPanel(panel)) {
        launchHit = true;
        break;
      }
    }
  }

  let keyCount = 0;
  let retained = 0;
  let activeCount = prev.activeCount;
  for (const id in state.panelsById) {
    keyCount += 1;
    const panel = state.panelsById[id];
    const prevPanel = prev.panelsById[id];
    if (prevPanel !== undefined) retained += 1;
    if (panel === prevPanel) continue;
    activeCount += Number(isActiveAgentPanel(panel)) - Number(isActiveAgentPanel(prevPanel));
  }
  // A key that disappeared took its contribution with it; recount.
  if (retained !== prev.keyCount) return fullAgentScan(state, checkLaunch);

  return {
    panelsById: state.panelsById,
    panelIds: state.panelIds,
    keyCount,
    launchMiss: checkLaunch && !launchHit,
    activeCount: activeCount >= 2 ? null : activeCount,
  };
}

export interface GettingStartedChecklistState {
  visible: boolean;
  collapsed: boolean;
  checklist: ChecklistState | null;
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
    usePanelStore
      .getState()
      .panelIds.some((id) => isLaunchedAgentPanel(usePanelStore.getState().panelsById[id]))
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
  const checklistRef = useRef(checklist);
  // Auto-collapse the checklist to its minimized state once, after the user is
  // clearly engaged (launched an agent AND interacted with a panel). Mount-
  // scoped so Help > Getting Started can always reopen it: a forced show sets
  // the latch (below) so it won't be re-collapsed against the user's intent.
  const hasAutoCollapsed = useRef(false);

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

    const next: ChecklistState = { ...prev, items: { ...prev.items, [item]: true } };
    setChecklist(next);
    checklistRef.current = next;
    // Finishing the last item lets the checklist go away, even when Help >
    // Getting Started had forced it open. Pushes below do the same.
    if (isChecklistComplete(next)) setForceShow(false);
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
        // The subscriptions below only see transitions, and their mount-time
        // reconcile ran before this resolved, against a null checklist. A
        // project that was already open by now would never be credited.
        checklistRef.current = checklistState;
        reconcileCurrentState(markItem, () => checklistRef.current);
      })
      .catch((err) => logError("Failed to load checklist state", err));
  }, [isStateLoaded, markItem]);

  // Subscribe to main-process checklist pushes. Every active WebContentsView
  // receives the push via `broadcastToRenderer`, so cached views stay in sync.
  // We merge by taking the union of truthy items rather than overwriting — this
  // prevents a pre-push `getChecklist()` hydration promise from clobbering a
  // newer push.
  useEffect(() => {
    if (!isElectronAvailable() || !window.electron?.onboarding?.onChecklistPush) return;
    return window.electron.onboarding.onChecklistPush((next) => {
      const before = checklistRef.current;
      if (before && !isChecklistComplete(before) && isChecklistComplete(next)) {
        setForceShow(false);
      }
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
    let agentScan: AgentScan | null = null;

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
        const checkLaunch = !cl.items.launchedAgent;
        if (checkLaunch || !cl.items.ranSecondParallelAgent) {
          const scan = nextAgentScan(agentScan, state, checkLaunch);
          agentScan = scan;
          if (checkLaunch && !scan.launchMiss) {
            markItem("launchedAgent");
          }
          if (!cl.items.ranSecondParallelAgent && scan.activeCount === null) {
            markItem("ranSecondParallelAgent");
          }
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

  // Setup is settled once the user finishes the wizard OR declines it from the
  // welcome banner. Gating on completion alone meant "Not now" on the banner
  // hid the checklist for good — the one path that most needs a next step.
  // An open project settles it too: the most direct first move — Open project,
  // banner untouched — is exactly the user the checklist exists to guide. It
  // completes nothing and consents to nothing; it only lets progress show.
  const { setupBannerDismissed } = useAgentDiscoveryOnboarding();
  const hasProject = useProjectStore((s) => s.currentProject !== null);
  const setupSettled = onboardingCompleted || setupBannerDismissed || hasProject;

  // Hidden once complete without persisting a dismissal, so Help > Getting
  // Started can still reopen it.
  const visible =
    checklist !== null &&
    (forceShow || (setupSettled && !checklist.dismissed && !isChecklistComplete(checklist)));

  return {
    visible,
    collapsed,
    checklist,
    dismiss,
    toggleCollapse,
    notifyOnboardingComplete,
    markItem,
  };
}
