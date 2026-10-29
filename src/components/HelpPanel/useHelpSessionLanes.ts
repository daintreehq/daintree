import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { useShallow } from "zustand/react/shallow";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { logWarn } from "@/utils/logger";
import { getTerminalTaskTitle } from "@/utils/terminalTitleDisplay";
import {
  acquireHelpSessionController,
  releaseHelpSessionController,
} from "@/controllers/helpSessionControllerRegistry";
import {
  useHelpPanelStore,
  selectSlot,
  selectOpenSlots,
  selectHasRoomForSession,
} from "@/store/helpPanelStore";
import { usePanelStore } from "@/store";
import { usePreferencesStore } from "@/store/preferencesStore";
import { actionService } from "@/services/ActionService";
import { MAX_ASSISTANT_SLOTS, assistantSlotKey } from "@shared/config/assistantSlots";
import { CLOSE_CONFIRM_AGENT_STATES } from "@shared/types/agent";
import { isPtyPanel } from "@shared/types/panel";
import type { HelpSessionTab } from "./HelpSessionTabs";
import { trimSessionTabTitle } from "./sessionTabTitle";

interface UseHelpSessionLanesOptions {
  panelRef: RefObject<HTMLElement | null>;
  activeSlot: number;
  activeWorkspaceId: string | null;
  terminalId: string | null;
}

// The session-lane tab strip: its tab model, the select/close/restart handlers,
// and the discard confirms they share. Lane lifecycle stays with the controller
// registry and each lane's HelpSessionLaneRuntime.
export function useHelpSessionLanes({
  panelRef,
  activeSlot,
  activeWorkspaceId,
  terminalId,
}: UseHelpSessionLanesOptions) {
  // The lane a restart is waiting on confirmation for. The header's overflow item
  // and every tab's own menu share it, so the lane that restarts is the one the
  // request named rather than whichever is in front when the user confirms.
  const [pendingRestartSlot, setPendingRestartSlot] = useState<number | null>(null);
  // Where the restart confirm hands focus back: a tab menu's item is gone by the
  // time the dialog closes, but the lane's tab survives a restart. A ref because
  // the dialog resolves it after its exit animation, once the pending slot is
  // already cleared.
  const restartFocusSlotRef = useRef<number | null>(null);
  // The lane a tab's close button is waiting on confirmation for (#12108).
  // Null means no close is pending — closing is destructive (the run ends and
  // the lane forgets its conversation, not pauses it), so it takes the same gate
  // the Stop control uses.
  const [pendingCloseSlot, setPendingCloseSlot] = useState<number | null>(null);
  // The lane focus should land on once a confirmed close removes a background
  // lane: its neighbour, the following one first. Null when the lane being
  // closed is the selected one — focus then follows the store's new selection.
  const [pendingCloseSuccessor, setPendingCloseSuccessor] = useState<number | null>(null);

  // --- Parallel lanes (#12108) -------------------------------------------
  // One base for the whole tablist/tabpanel relationship. Both ends have to name
  // the same ids and neither can hold a ref to the other, so the panel owns the
  // base and both sides derive from it.
  const tabIdBase = useId();
  const sessionBodyId = `${tabIdBase}-body`;
  const openSlots = useHelpPanelStore(useShallow(selectOpenSlots));
  const canOpenParallelSession = openSlots.length < MAX_ASSISTANT_SLOTS;
  const canStartSessionWithAgent = useHelpPanelStore((s) =>
    selectHasRoomForSession(s, activeWorkspaceId)
  );

  // Subscribed rather than read through `getState()` inside the panel-store selectors
  // below: a background lane that binds a terminal changes only this, and without the
  // subscription its tab kept the old terminal's state and name until something else
  // happened to re-render the panel.
  const laneTerminalIds = useHelpPanelStore(
    useShallow((s) => openSlots.map((slot) => s.sessions[slot]?.terminalId ?? null))
  );

  // Each lane's agent, so a strip holding more than one can tell them apart. A
  // tab restored for a captured conversation has no terminal yet; its capture
  // names the agent it will resume with.
  const laneAgentIds = useHelpPanelStore(
    useShallow((s) =>
      openSlots.map(
        (slot) =>
          s.sessions[slot]?.agentId ??
          (activeWorkspaceId
            ? s.hibernateSessions[assistantSlotKey(activeWorkspaceId, slot)]?.agentId
            : undefined) ??
          null
      )
    )
  );

  // The header's "Restart conversation" gate, per lane, so each tab's menu offers
  // the same item exactly where the overflow menu would for that lane.
  const laneCanRestart = useHelpPanelStore(
    useShallow((s) =>
      openSlots.map((slot) => {
        const lane = selectSlot(s, slot);
        return Boolean(lane.terminalId && lane.agentId);
      })
    )
  );

  const laneAgentStates = usePanelStore(
    useShallow((s: ReturnType<typeof usePanelStore.getState>) =>
      laneTerminalIds.map((laneTerminalId) => {
        if (!laneTerminalId) return undefined;
        const panel = s.panelsById[laneTerminalId];
        return panel && isPtyPanel(panel) ? panel.agentState : undefined;
      })
    )
  );

  // The agent's own name for each lane, through the same composition every other
  // title surface uses — identity echoes ("Claude Code"), user-locked titles and exited
  // agents all come back null and fall through to `Session N`. Selected as strings so
  // `useShallow` skips the render when an OSC update left every lane's task unchanged,
  // which is most of them: the spinner glyphs that churn the raw title are already gone.
  const showAgentTaskTitles = usePreferencesStore((s) => s.showAgentTaskTitles);
  const laneTaskTitles = usePanelStore(
    useShallow((s: ReturnType<typeof usePanelStore.getState>) =>
      laneTerminalIds.map((laneTerminalId) => {
        if (showAgentTaskTitles === false || !laneTerminalId) return null;
        const panel = s.panelsById[laneTerminalId];
        return panel && isPtyPanel(panel) ? getTerminalTaskTitle(panel) : null;
      })
    )
  );

  const sessionTabs = useMemo<HelpSessionTab[]>(
    () =>
      openSlots.map((slot, index) => {
        const task = trimSessionTabTitle(laneTaskTitles[index]);
        return {
          slot,
          // Numbered by SLOT, which is the lane's durable identity, rather than by
          // position in the strip. Position renumbers: closing the first of three
          // lanes used to rename the two behind it, so a conversation the user had
          // been calling "Session 3" silently became "Session 2" and the name they
          // navigated back to belonged to a different session. A gap at 2 is a much
          // smaller cost than a label that lies, and the gap closes on its own —
          // `openSlot` always takes the lowest free slot.
          //
          // A task title replaces the number rather than joining it: the strip is
          // narrow, and the number was only ever standing in for a name.
          label: task?.label ?? `Session ${slot + 1}`,
          fullTitle: task?.fullTitle,
          agentState: laneAgentStates[index],
          agentId: laneAgentIds[index] ?? null,
          canRestart: laneCanRestart[index],
        };
      }),
    [openSlots, laneAgentStates, laneTaskTitles, laneAgentIds, laneCanRestart]
  );

  // Bring back the tabs for lanes whose conversations an eviction or crash
  // captured (#12108). A cold view starts at slot 0 alone, so lanes 1+ — whose
  // resume entries survived on disk — would have no tab to reach them from and
  // their conversations would be stranded despite still being there. The
  // listing is non-consuming, like the peeks: a recreated lane simply lands on
  // its own "Resume assistant" empty state, and nothing launches (or bills)
  // until the user asks. Background lanes report `isOpen: false` to their
  // controller, so auto-launch can't fire behind the tab strip either.
  //
  // One-shot per workspace, and only while the view is genuinely cold — a
  // single, unbound lane — so it can never fight the user's own tab edits.
  const restoredLaneWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeWorkspaceId || restoredLaneWorkspaceRef.current === activeWorkspaceId) return;
    if (openSlots.length > 1 || terminalId) return;
    // Optional-chained like the hibernation peeks: a missing binding degrades
    // to the pre-lane behaviour rather than throwing.
    const listing = window.electron.help.listPendingHibernationSlots?.(activeWorkspaceId);
    if (!listing) return;
    let cancelled = false;
    void listing
      .then((slots) => {
        if (cancelled || restoredLaneWorkspaceRef.current === activeWorkspaceId) return;
        restoredLaneWorkspaceRef.current = activeWorkspaceId;
        const store = useHelpPanelStore.getState();
        for (const slot of slots) store.ensureSlot(slot);
      })
      .catch((err) => {
        logWarn("HelpPanel: failed to list pending hibernation lanes", err);
      });
    return () => {
      cancelled = true;
    };
  }, [activeWorkspaceId, openSlots.length, terminalId]);

  const handleOpenParallelSession = useCallback((): number | null => {
    const slot = useHelpPanelStore.getState().openSlot();
    if (slot === null) return null;
    useHelpPanelStore.getState().setOpen(true);
    useHelpPanelStore.getState().requestFocus();
    return slot;
  }, []);

  // One session on a named agent (#13442); the default stays where it is.
  const handleOpenSessionWithAgent = useCallback((pickedAgentId: string) => {
    void actionService.dispatch(
      "help.newSessionWithAgent",
      { agentId: pickedAgentId },
      { source: "user" }
    );
  }, []);

  const handleSelectSlot = useCallback((slot: number) => {
    useHelpPanelStore.getState().setActiveSlot(slot);
    // A lane's xterm was hidden while it was in the background, so it has no
    // trustworthy geometry until it is measured on screen. `requestFocus`
    // drives HelpPanel's existing reveal path, which fits and repaints before
    // handing it the caret — the same treatment a panel reveal gets.
    useHelpPanelStore.getState().requestFocus();
  }, []);

  const closeSlotNow = useCallback(
    (slot: number) => {
      const state = useHelpPanelStore.getState();
      const lane = state.sessions[slot];
      // Revoke and kill BEFORE dropping the lane. `stop()` only disarms
      // listeners — it deliberately does not end the session — so releasing the
      // controller first would strand a live agent with nothing to shut it down.
      if (lane?.terminalId || lane?.sessionId) {
        // Whether the panel slides out is the controller's call, made in one
        // place for every stop path: it stays on screen while any other lane is
        // open, and closes only for the last one — where the close is
        // load-bearing, because `closeSlot` recreates an empty slot 0 whose fresh
        // controller would auto-launch straight back into a session the user just
        // ended if the panel stayed open.
        acquireHelpSessionController(slot).endSession();
      } else if (activeWorkspaceId) {
        // A dormant tab — one restored for a conversation nothing has resumed
        // yet — has no session to end, but closing it is still the user
        // discarding that conversation, so both of its pointers must go too:
        // main's, and the renderer's own hibernate mirror, which a later launch
        // into the reused slot would otherwise resume (#13205).
        state.clearHibernateSession(activeWorkspaceId, slot);
        const discarded = window.electron.help.discardConversation?.(activeWorkspaceId, slot);
        if (discarded) safeFireAndForget(discarded, { context: "HelpPanel.closeSlot discard" });
      }
      // An unbound last lane — dormant, or closed mid-launch before anything
      // bound — never reaches `endSession`'s slide-out, but the recreated slot 0
      // still gets a fresh controller that would auto-launch into the open panel.
      if (!selectOpenSlots(state).some((open) => open !== slot)) state.setOpen(false);
      releaseHelpSessionController(slot);
      state.closeSlot(slot);
    },
    [activeWorkspaceId]
  );

  // Same "something to lose" gate the Stop control uses, but evaluated against
  // the lane BEING CLOSED OR RESTARTED rather than the one on screen — a
  // background lane is exactly where a working agent goes unnoticed. Both
  // discard the lane's conversation, so both take this one gate.
  const laneNeedsDiscardConfirm = useCallback((slot: number) => {
    const lane = selectSlot(useHelpPanelStore.getState(), slot);
    if (lane.conversationTouched) return true;
    if (!lane.terminalId) return false;
    const panel = usePanelStore.getState().panelsById[lane.terminalId];
    const agentState = panel && isPtyPanel(panel) ? panel.agentState : undefined;
    return agentState !== undefined && CLOSE_CONFIRM_AGENT_STATES.has(agentState);
  }, []);

  const handleCloseSlot = useCallback(
    (slot: number) => {
      if (laneNeedsDiscardConfirm(slot)) {
        const index = sessionTabs.findIndex((tab) => tab.slot === slot);
        const successor =
          slot === activeSlot
            ? null
            : (sessionTabs[index + 1]?.slot ?? sessionTabs[index - 1]?.slot ?? null);
        setPendingCloseSuccessor(successor);
        setPendingCloseSlot(slot);
        return;
      }
      closeSlotNow(slot);
    },
    [laneNeedsDiscardConfirm, closeSlotNow, sessionTabs, activeSlot]
  );

  const handleConfirmCloseSlot = useCallback(() => {
    const slot = pendingCloseSlot;
    setPendingCloseSlot(null);
    if (slot !== null) closeSlotNow(slot);
  }, [pendingCloseSlot, closeSlotNow]);

  const handleCancelCloseSlot = useCallback(() => {
    setPendingCloseSlot(null);
  }, []);

  // A task title is free text, so it is quoted the way every confirm quotes the entity
  // it names, and given whole: two tasks that share an opening would otherwise ask
  // the same question. `Session N` is already a name and reads wrong in quotes.
  const pendingCloseTab =
    pendingCloseSlot === null
      ? undefined
      : sessionTabs.find((tab) => tab.slot === pendingCloseSlot);
  const pendingCloseLabel = !pendingCloseTab
    ? "this session"
    : pendingCloseTab.fullTitle !== undefined
      ? `'${pendingCloseTab.fullTitle}'`
      : pendingCloseTab.label;

  // Read at call time rather than from the render that offered the item: a
  // confirm can outlive its lane, and acquiring a controller for a closed slot
  // would mint one with nothing to run.
  const restartSlotNow = useCallback((slot: number) => {
    const lane = selectSlot(useHelpPanelStore.getState(), slot);
    if (!lane.terminalId || !lane.agentId) return;
    acquireHelpSessionController(slot).newSession();
  }, []);

  const handleRestartSlot = useCallback(
    (slot: number) => {
      const lane = selectSlot(useHelpPanelStore.getState(), slot);
      if (!lane.terminalId || !lane.agentId) return;
      if (laneNeedsDiscardConfirm(slot)) {
        restartFocusSlotRef.current = slot;
        setPendingRestartSlot(slot);
        return;
      }
      restartSlotNow(slot);
    },
    [laneNeedsDiscardConfirm, restartSlotNow]
  );

  // The header's overflow item and the revoked-session banner act on the lane on screen.
  const handleRestartActiveSlot = useCallback(
    () => handleRestartSlot(activeSlot),
    [handleRestartSlot, activeSlot]
  );

  const handleConfirmRestartSlot = useCallback(() => {
    const slot = pendingRestartSlot;
    setPendingRestartSlot(null);
    if (slot !== null) restartSlotNow(slot);
  }, [pendingRestartSlot, restartSlotNow]);

  const handleCancelRestartSlot = useCallback(() => {
    setPendingRestartSlot(null);
  }, []);

  const resolveRestartFocusTarget = useCallback(
    () =>
      restartFocusSlotRef.current === null
        ? null
        : (panelRef.current?.querySelector<HTMLElement>(
            `[role="tab"][data-slot="${restartFocusSlotRef.current}"]`
          ) ?? null),
    [panelRef]
  );

  const resolveCloseFocusTarget = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return null;
    const successor =
      pendingCloseSuccessor === null
        ? null
        : panel.querySelector<HTMLElement>(`[role="tab"][data-slot="${pendingCloseSuccessor}"]`);
    return successor ?? panel.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  }, [panelRef, pendingCloseSuccessor]);

  return {
    tabIdBase,
    sessionBodyId,
    openSlots,
    canOpenParallelSession,
    canStartSessionWithAgent,
    sessionTabs,
    handleOpenParallelSession,
    handleOpenSessionWithAgent,
    handleSelectSlot,
    handleCloseSlot,
    handleRestartSlot,
    handleRestartActiveSlot,
    pendingRestartSlot,
    handleConfirmRestartSlot,
    handleCancelRestartSlot,
    resolveRestartFocusTarget,
    pendingCloseSlot,
    pendingCloseLabel,
    handleConfirmCloseSlot,
    handleCancelCloseSlot,
    resolveCloseFocusTarget,
  };
}
