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
import { notify } from "@/lib/notify";
import { UNDO_TOAST_DURATION_MS } from "@/lib/undoToast";
import { MAX_ASSISTANT_SLOTS, assistantSlotKey } from "@shared/config/assistantSlots";
import { CLOSE_CONFIRM_AGENT_STATES } from "@shared/types/agent";
import { isPtyPanel } from "@shared/types/panel";
import type { HelpPastSession } from "@shared/types/ipc/help";
import type { HelpPastSessionPickOutcome } from "@/services/actions/definitions/helpActions";
import type { HelpSessionTab } from "./HelpSessionTabs";
import { trimSessionTabTitle } from "./sessionTabTitle";
import { isListedAssistantAgent, type PendingCloseCost } from "./pastSessionsNote";

/** How a closed lane's conversation comes back (#15385). */
export type ClosedSessionRecovery =
  | { kind: "reopen"; agentId: HelpPastSession["agentId"]; sessionId: string }
  // A listed agent whose conversation id this lane never learned (a fresh Codex
  // lane): the conversation is in past sessions, but not addressable from here.
  | { kind: "past-sessions" };

export interface ClosedSessionNotice {
  /** New per close, so a second close restarts the notice instead of editing it. */
  id: number;
  workspaceId: string;
  label: string;
  recovery: ClosedSessionRecovery;
}

export const CLOSED_SESSION_REOPEN_LABEL = "Reopen";
export const CLOSED_SESSION_FIND_LABEL = "Past sessions…";

/**
 * A lane named the way a confirm or notice names it. A task title is free text, so
 * it is quoted the way every confirm quotes the entity it names, and given whole:
 * two tasks that share an opening would otherwise read the same. `Session N` is
 * already a name and reads wrong in quotes.
 */
function spokenLaneLabel(tab: HelpSessionTab | undefined): string {
  if (!tab) return "this session";
  return tab.fullTitle !== undefined ? `'${tab.fullTitle}'` : tab.label;
}

/**
 * The lane on screen, paused on a conversation main captured for it (#14981): no
 * terminal, and the agent a fresh start runs on, the one the conversation had.
 */
export interface PausedLane {
  workspaceId: string;
  agentId: string;
  /** Its assistant is still running on the host, so a restart stops it. */
  live: boolean;
}

interface PendingRestart {
  slot: number;
  /** Set when the request was for a paused lane rather than a running one. */
  paused: PausedLane | null;
}

interface UseHelpSessionLanesOptions {
  panelRef: RefObject<HTMLElement | null>;
  activeSlot: number;
  activeWorkspaceId: string | null;
  terminalId: string | null;
  pausedLane: PausedLane | null;
}

// The session-lane tab strip: its tab model, the select/close/restart handlers,
// and the discard confirms they share. Lane lifecycle stays with the controller
// registry and each lane's HelpSessionLaneRuntime.
export function useHelpSessionLanes({
  panelRef,
  activeSlot,
  activeWorkspaceId,
  terminalId,
  pausedLane,
}: UseHelpSessionLanesOptions) {
  // The lane a restart is waiting on confirmation for. The header's overflow item,
  // every tab's own menu and the paused lane's own button share it, so the lane
  // that restarts is the one the request named rather than whichever is in front
  // when the user confirms.
  const [pendingRestart, setPendingRestart] = useState<PendingRestart | null>(null);
  // Where the restart confirm hands focus back: a tab menu's item is gone by the
  // time the dialog closes, but the lane's tab survives a restart. A ref because
  // the dialog resolves it after its exit animation, once the pending slot is
  // already cleared.
  const restartFocusSlotRef = useRef<number | null>(null);
  // The lane a tab's close is waiting on confirmation for (#12108). Only a working
  // agent or a conversation the app can't bring back asks (#15385); every other
  // close acts at once and offers the way back instead.
  const [pendingCloseSlot, setPendingCloseSlot] = useState<number | null>(null);
  const [pendingCloseCost, setPendingCloseCost] = useState<PendingCloseCost | null>(null);
  const [closedNotice, setClosedNotice] = useState<ClosedSessionNotice | null>(null);
  const closedNoticeSeqRef = useRef(0);
  // The lane focus should land on once a confirmed close removes a background
  // lane: its neighbour, the following one first. Null when the lane being
  // closed is the selected one — focus then follows the store's new selection.
  const [pendingCloseSuccessor, setPendingCloseSuccessor] = useState<number | null>(null);
  // The lane the confirm was asked about, kept past its answer: the dialog
  // resolves its focus target after the exit animation, by when the pending slot
  // is cleared, and a cancelled close has to land back on this lane's tab.
  const closeFocusSlotRef = useRef<number | null>(null);

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
  // the same item exactly where the overflow menu would for that lane. A paused
  // lane joins it below: only the lane on screen is peeked, so a background tab
  // offers it once it is selected.
  const laneIsLive = useHelpPanelStore(
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
          canRestart: laneIsLive[index] || (slot === activeSlot && pausedLane !== null),
        };
      }),
    [openSlots, laneAgentStates, laneTaskTitles, laneAgentIds, laneIsLive, activeSlot, pausedLane]
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

  /**
   * What closing this lane would end, read at the moment of the close. The
   * conversation id is the AGENT'S (what `help.resumePastSession` takes), not the
   * lane's provisioning `sessionId`: a live lane carries it on its terminal from
   * spawn (minted for Claude, carried over for a resumed lane), a dormant tab in
   * its captured resume entry. A fresh Codex lane has none until a capture.
   */
  const readLaneForClose = useCallback(
    (slot: number) => {
      const state = useHelpPanelStore.getState();
      const lane = selectSlot(state, slot);
      const panel = lane.terminalId
        ? usePanelStore.getState().panelsById[lane.terminalId]
        : undefined;
      const pty = panel && isPtyPanel(panel) ? panel : undefined;
      const captured =
        !lane.terminalId && activeWorkspaceId
          ? state.hibernateSessions[assistantSlotKey(activeWorkspaceId, slot)]
          : undefined;
      const agentId = lane.agentId ?? captured?.agentId ?? null;
      const hasConversation = lane.conversationTouched || Boolean(captured);
      const working =
        pty?.agentState !== undefined && CLOSE_CONFIRM_AGENT_STATES.has(pty.agentState);
      const conversationId = pty?.agentSessionId || captured?.sessionId || null;
      const recovery: ClosedSessionRecovery | null =
        hasConversation && isListedAssistantAgent(agentId)
          ? conversationId
            ? { kind: "reopen", agentId, sessionId: conversationId }
            : { kind: "past-sessions" }
          : null;
      return {
        agentId,
        working,
        dormant: Boolean(captured),
        // Ending it costs something the app can't give back.
        needsConfirm: working || (hasConversation && recovery === null),
        recovery,
      };
    },
    [activeWorkspaceId]
  );

  const reopenClosedSession = useCallback((recovery: ClosedSessionRecovery) => {
    setClosedNotice(null);
    void (async () => {
      if (recovery.kind === "reopen") {
        const result = await actionService.dispatch<{ outcome: HelpPastSessionPickOutcome }>(
          "help.resumePastSession",
          { agentId: recovery.agentId, sessionId: recovery.sessionId },
          { source: "user" }
        );
        // Every tab filled again since the close: the picker asks which one to
        // give up rather than this replacing one unasked.
        if (!result.ok || result.result?.outcome !== "lanes-full") return;
      }
      await actionService.dispatch("help.resumePastSession", undefined, { source: "user" });
    })();
  }, []);

  const dismissClosedNotice = useCallback(() => setClosedNotice(null), []);

  const closeSlotNow = useCallback(
    (slot: number) => {
      const state = useHelpPanelStore.getState();
      const lane = state.sessions[slot];
      // Read before the teardown below discards the lane's resume pointer.
      const { recovery } = readLaneForClose(slot);
      const label = spokenLaneLabel(sessionTabs.find((tab) => tab.slot === slot));
      const isLastLane = !selectOpenSlots(state).some((open) => open !== slot);
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
      if (isLastLane) state.setOpen(false);
      releaseHelpSessionController(slot);
      state.closeSlot(slot);

      if (!recovery || !activeWorkspaceId) return;
      const title = `${label} closed`;
      if (isLastLane) {
        // The panel just slid away, so a notice inside it would never be seen.
        // The toaster stands in, with the same window and the same way back.
        notify({
          type: "info",
          title,
          message: "Its conversation stays in past sessions",
          transient: true,
          duration: UNDO_TOAST_DURATION_MS,
          // A way back held behind quiet hours would expire unseen, the same
          // reason an Undo toast is urgent by default.
          urgent: true,
          action: {
            label:
              recovery.kind === "reopen" ? CLOSED_SESSION_REOPEN_LABEL : CLOSED_SESSION_FIND_LABEL,
            onClick: () => reopenClosedSession(recovery),
          },
        });
        return;
      }
      closedNoticeSeqRef.current += 1;
      setClosedNotice({
        id: closedNoticeSeqRef.current,
        workspaceId: activeWorkspaceId,
        label,
        recovery,
      });
    },
    [activeWorkspaceId, readLaneForClose, sessionTabs, reopenClosedSession]
  );

  // Same "something to lose" gate the Stop control uses, but evaluated against
  // the lane BEING RESTARTED rather than the one on screen — a background lane
  // is exactly where a working agent goes unnoticed.
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
      const lane = readLaneForClose(slot);
      if (lane.needsConfirm) {
        const index = sessionTabs.findIndex((tab) => tab.slot === slot);
        const successor =
          slot === activeSlot
            ? null
            : (sessionTabs[index + 1]?.slot ?? sessionTabs[index - 1]?.slot ?? null);
        setPendingCloseSuccessor(successor);
        setPendingCloseCost({
          working: lane.working,
          agentId: lane.agentId,
          dormant: lane.dormant,
          sole: sessionTabs.length === 1,
        });
        closeFocusSlotRef.current = slot;
        setPendingCloseSlot(slot);
        return;
      }
      closeSlotNow(slot);
    },
    [readLaneForClose, closeSlotNow, sessionTabs, activeSlot]
  );

  const handleConfirmCloseSlot = useCallback(() => {
    const slot = pendingCloseSlot;
    setPendingCloseSlot(null);
    if (slot !== null) closeSlotNow(slot);
  }, [pendingCloseSlot, closeSlotNow]);

  const handleCancelCloseSlot = useCallback(() => {
    setPendingCloseSlot(null);
  }, []);

  const pendingCloseLabel = spokenLaneLabel(
    pendingCloseSlot === null ? undefined : sessionTabs.find((tab) => tab.slot === pendingCloseSlot)
  );

  // Read at call time rather than from the render that offered the item: a
  // confirm can outlive its lane, and acquiring a controller for a closed slot
  // would mint one with nothing to run. A paused request also has to find the
  // same pause it was asked about: a lane resumed, or a capture discarded,
  // meanwhile is not the conversation the user agreed to throw away.
  const restartSlotNow = useCallback(
    (slot: number, paused: PausedLane | null) => {
      const lane = selectSlot(useHelpPanelStore.getState(), slot);
      if (paused) {
        if (
          lane.terminalId ||
          slot !== activeSlot ||
          pausedLane?.workspaceId !== paused.workspaceId ||
          pausedLane.agentId !== paused.agentId
        ) {
          return;
        }
        acquireHelpSessionController(slot).newSession(paused.agentId);
        return;
      }
      if (!lane.terminalId || !lane.agentId) return;
      acquireHelpSessionController(slot).newSession();
    },
    [activeSlot, pausedLane]
  );

  const handleRestartSlot = useCallback(
    (slot: number) => {
      const lane = selectSlot(useHelpPanelStore.getState(), slot);
      if (!lane.terminalId && slot === activeSlot && pausedLane) {
        // Always asks: the captured conversation is exactly what a restart discards.
        restartFocusSlotRef.current = slot;
        setPendingRestart({ slot, paused: pausedLane });
        return;
      }
      if (!lane.terminalId || !lane.agentId) return;
      if (laneNeedsDiscardConfirm(slot)) {
        restartFocusSlotRef.current = slot;
        setPendingRestart({ slot, paused: null });
        return;
      }
      restartSlotNow(slot, null);
    },
    [activeSlot, pausedLane, laneNeedsDiscardConfirm, restartSlotNow]
  );

  // The header's overflow item and the revoked-session banner act on the lane on screen.
  const handleRestartActiveSlot = useCallback(
    () => handleRestartSlot(activeSlot),
    [handleRestartSlot, activeSlot]
  );

  const handleConfirmRestartSlot = useCallback(() => {
    const pending = pendingRestart;
    setPendingRestart(null);
    if (pending) restartSlotNow(pending.slot, pending.paused);
  }, [pendingRestart, restartSlotNow]);

  const handleCancelRestartSlot = useCallback(() => {
    setPendingRestart(null);
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
    // Cancelled: the lane is still there. A tab menu's item can't take focus back,
    // and its neighbour is not where the user was.
    const kept =
      closeFocusSlotRef.current === null
        ? null
        : panel.querySelector<HTMLElement>(
            `[role="tab"][data-slot="${closeFocusSlotRef.current}"]`
          );
    if (kept) return kept;
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
    pendingRestartSlot: pendingRestart?.slot ?? null,
    pendingRestartPaused: pendingRestart?.paused ?? null,
    handleConfirmRestartSlot,
    handleCancelRestartSlot,
    resolveRestartFocusTarget,
    pendingCloseSlot,
    pendingCloseLabel,
    pendingCloseCost,
    handleConfirmCloseSlot,
    handleCancelCloseSlot,
    resolveCloseFocusTarget,
    // The notice belongs to the project it was raised in; a view switch drops it.
    closedNotice: closedNotice?.workspaceId === activeWorkspaceId ? closedNotice : null,
    reopenClosedSession,
    dismissClosedNotice,
  };
}
