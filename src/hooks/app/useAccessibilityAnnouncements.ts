import { useEffect, useRef } from "react";
import { usePanelStore } from "@/store";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import type { AgentState, WaitingReason } from "@shared/types/agent";
import { describeWaiting } from "@shared/utils/waitingReasonDisplay";
import { isPtyPanel } from "@shared/types/panel";
import type { PanelLocation, TerminalFlowStatus } from "@shared/types/panel";

// FUTURE_SAB: `flowStatus` in the snapshot is typed as `TerminalFlowStatus`
// (not `PersistableFlowStatus`) so the formatter below can handle the
// `suspended` and `paused-user` future-sab statuses. In production only
// `PersistableFlowStatus` values arrive (the buffer is the persistence
// boundary and excludes future-sab); the wider type here is purely so the
// formatter's switch remains exhaustive against the full union (#9900).
interface TerminalStateSnapshot {
  agentState?: AgentState;
  stateChangeConfidence?: number;
  flowStatus?: TerminalFlowStatus;
  exitCode?: number;
  hasExited?: boolean;
  queueCount?: number;
  location?: PanelLocation;
}

const BADGE_DEBOUNCE_MS = 300;

function getAgentStateMessage(
  title: string,
  newState: AgentState,
  waitingReason?: WaitingReason
): { msg: string; priority: "polite" | "assertive" } | null {
  switch (newState) {
    case "working":
      return { msg: `${title} is working`, priority: "polite" };
    case "waiting":
      // Reason-specific phrasing when the classifier had evidence; the
      // `prompt` fallback keeps the generic "waiting for input".
      return { msg: describeWaiting(title, waitingReason), priority: "polite" };
    case "completed":
      return { msg: `${title} finished`, priority: "polite" };
    case "exited":
      return { msg: `${title} exited`, priority: "polite" };
    default:
      return null;
  }
}

// FUTURE_SAB: the `status` parameter is `TerminalFlowStatus | undefined` so
// this pure check can recognize the `suspended` / `paused-user` future-sab
// statuses. In practice the `flowStatus` field on a panel is
// `PersistableFlowStatus`, so this branch is unreachable in production. Kept
// for symmetry with the formatter below — when the SAB transport is revived
// and a panel's `flowStatus` field is widened, this check will return true
// for the new values automatically (#9900).
function isPausedFlow(status: TerminalFlowStatus | undefined): boolean {
  return (
    status === "paused-backpressure" ||
    status === "paused-resource-governor" ||
    // FUTURE_SAB: no production producer.
    status === "paused-user" ||
    // FUTURE_SAB: only emitted by the disabled SAB path.
    status === "suspended"
  );
}

// FUTURE_SAB: parameter types are `TerminalFlowStatus | undefined` (not
// `PersistableFlowStatus | undefined`) so the switch below remains
// exhaustive against the full union. The `suspended` case is the only
// future-sab branch that produces a message; `paused-user` falls through
// to `default` (silent). The wider type here is purely so the switch is
// type-safe with the full union — when the SAB transport is revived and
// the persistence boundary widens, no formatter change is required (#9900).
function getFlowStatusMessage(
  title: string,
  prev: TerminalFlowStatus | undefined,
  next: TerminalFlowStatus | undefined
): string | null {
  if (prev === next) return null;
  switch (next) {
    case "paused-backpressure":
      return `${title}: output paused`;
    case "paused-resource-governor":
      return `${title}: output paused, memory pressure`;
    // FUTURE_SAB: `suspended` is only emitted by the SAB transport path
    // (`BackpressureManager.suspendVisualStream`); no production producer.
    // Kept so the formatter stays type-safe forward-looking code.
    case "suspended":
      return `${title}: output suspended`;
    case "running":
    case undefined:
      // Resume signal — the IPC fallback resumes to "running", and some
      // store paths transiently clear `flowStatus` to undefined. Both mean
      // "no longer paused", but only announce if we were actually paused.
      return isPausedFlow(prev) ? `${title}: output resumed` : null;
    // FUTURE_SAB: `paused-user` has no producer; falls through silently.
    case "paused-user":
    default:
      return null;
  }
}

function getQueueCountMessage(title: string, prev: number, next: number): string | null {
  if (prev === next) return null;
  // Only announce threshold transitions — every numeric increment would flood
  // the AT queue. Mid-range adjustments (3 → 5 queued) are visible in the UI
  // and don't warrant interruption.
  if (prev === 0 && next > 0) {
    return `${title}: ${next} command${next > 1 ? "s" : ""} queued`;
  }
  if (prev > 0 && next === 0) {
    return `${title}: queue cleared`;
  }
  return null;
}

function getExitMessage(title: string, exitCode: number | undefined): string {
  return exitCode != null ? `${title}: exited with code ${exitCode}` : `${title}: exited`;
}

function basePanelId(debounceKey: string): string {
  const colon = debounceKey.indexOf(":");
  return colon === -1 ? debounceKey : debounceKey.slice(0, colon);
}

export function useAccessibilityAnnouncements() {
  const previousStatesRef = useRef<Map<string, TerminalStateSnapshot>>(new Map());
  const debounceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Per-terminal hibernation subscriptions. Hibernation lives on
  // `terminalInstanceService`, not in panelStore — so we observe transitions
  // through the same subscribe-and-snapshot path as `useIsHibernated`.
  const hibernationUnsubsRef = useRef<Map<string, () => void>>(new Map());
  const hibernationStateRef = useRef<Map<string, boolean>>(new Map());

  // This hook renders nothing — every consumer below is an effect. It
  // observes the store with a transient subscription instead of reactive
  // selectors: a live `panelsById` selector re-rendered the hosting component
  // (App) on every panel-map identity change, i.e. on every agent-state flip
  // and every rAF status flush.
  useEffect(() => {
    const prevFocusedIdRef = { current: usePanelStore.getState().focusedId };
    // `null` means "nothing maximized"; seeding from live state mirrors the
    // old undefined-sentinel first-render skip.
    const prevMaximizedIdRef = { current: usePanelStore.getState().maximizedId };
    const lastDiffInputsRef = {
      current: null as null | {
        panelsById: unknown;
        panelIds: unknown;
        commandQueueCountById: unknown;
      },
    };

    // Per-pane badge state announcements (#9204).
    //
    // Each previously had its own `aria-live="polite"` region; in a multi-pane
    // fleet that produced competing live regions that NVDA/VoiceOver coalesce
    // or drop. Routing through the single global announcer with a pane-title
    // prefix gives screen-reader users a serialized stream with spatial
    // context.
    //
    // Debounce keys are namespaced per badge (`${id}:flow`, `${id}:queue`,
    // `${id}:exit`) so a rapid queue-then-flow transition in the same pane
    // does not cancel its sibling. The unsuffixed `${id}` slot is reserved for
    // the agent-state announcer — leaving it untouched preserves the #8937
    // cancellation-on-removal guarantee.
    const diffPanels = (state: ReturnType<typeof usePanelStore.getState>) => {
      const { panelsById, panelIds, commandQueueCountById } = state;
      const last = lastDiffInputsRef.current;
      if (
        last &&
        last.panelsById === panelsById &&
        last.panelIds === panelIds &&
        last.commandQueueCountById === commandQueueCountById
      ) {
        return;
      }
      lastDiffInputsRef.current = { panelsById, panelIds, commandQueueCountById };

      const prevStates = previousStatesRef.current;
      const newStates = new Map<string, TerminalStateSnapshot>();

      for (const id of panelIds) {
        const terminal = panelsById[id];
        if (!terminal) continue;

        const prev = prevStates.get(terminal.id);
        // `location` lives on every panel kind (it's on BasePanelData), so it is
        // captured outside the PTY guard below — browser/dev-preview/review panes
        // can be minimized and restored too.
        const nextSnapshot: TerminalStateSnapshot = {
          location: terminal.location,
        };

        // PTY-only badge state (agent state, flow, queue, exit, hibernation).
        // Non-PTY panels have none of these fields, so the whole block is gated.
        if (isPtyPanel(terminal)) {
          nextSnapshot.agentState = terminal.agentState;
          nextSnapshot.stateChangeConfidence = terminal.stateChangeConfidence;
          nextSnapshot.flowStatus = terminal.flowStatus;
          nextSnapshot.exitCode = terminal.exitCode;
          nextSnapshot.hasExited = terminal.exitCode != null;
          nextSnapshot.queueCount = commandQueueCountById[terminal.id] ?? 0;

          // Agent-state transitions — original behavior preserved.
          if (terminal.agentState && prev?.agentState !== terminal.agentState) {
            const lowConfidence =
              terminal.stateChangeConfidence !== undefined && terminal.stateChangeConfidence < 0.7;

            // Skip low-confidence heuristic transitions — keep the previous state
            // so a later high-confidence confirmation of this state will still trigger.
            if (prev && lowConfidence) {
              nextSnapshot.agentState = prev.agentState;
              nextSnapshot.stateChangeConfidence = prev.stateChangeConfidence;
            } else if (prev) {
              // State changed with sufficient confidence — announce.
              const announcement = getAgentStateMessage(
                terminal.title,
                terminal.agentState,
                terminal.waitingReason
              );
              if (announcement) {
                const { msg, priority } = announcement;
                const key = terminal.id;
                const existing = debounceTimersRef.current.get(key);
                if (existing) clearTimeout(existing);
                const timer = setTimeout(() => {
                  useAnnouncerStore.getState().announce(msg, priority);
                  debounceTimersRef.current.delete(key);
                }, BADGE_DEBOUNCE_MS);
                debounceTimersRef.current.set(key, timer);
              }
            }
          }

          if (prev) {
            // Flow status transitions (paused/suspended/resumed).
            const flowMsg = getFlowStatusMessage(
              terminal.title,
              prev.flowStatus,
              terminal.flowStatus
            );
            if (flowMsg) {
              const key = `${terminal.id}:flow`;
              const existing = debounceTimersRef.current.get(key);
              if (existing) clearTimeout(existing);
              const timer = setTimeout(() => {
                useAnnouncerStore.getState().announce(flowMsg, "polite");
                debounceTimersRef.current.delete(key);
              }, BADGE_DEBOUNCE_MS);
              debounceTimersRef.current.set(key, timer);
            }

            // Queue-count threshold transitions (0→N, N→0).
            const queueMsg = getQueueCountMessage(
              terminal.title,
              prev.queueCount ?? 0,
              nextSnapshot.queueCount ?? 0
            );
            if (queueMsg) {
              const key = `${terminal.id}:queue`;
              const existing = debounceTimersRef.current.get(key);
              if (existing) clearTimeout(existing);
              const timer = setTimeout(() => {
                useAnnouncerStore.getState().announce(queueMsg, "polite");
                debounceTimersRef.current.delete(key);
              }, BADGE_DEBOUNCE_MS);
              debounceTimersRef.current.set(key, timer);
            }

            // Exit code badge — fires when exitCode flips from undefined to a number.
            if (!prev.hasExited && nextSnapshot.hasExited) {
              const exitMsg = getExitMessage(terminal.title, terminal.exitCode);
              const key = `${terminal.id}:exit`;
              const existing = debounceTimersRef.current.get(key);
              if (existing) clearTimeout(existing);
              const timer = setTimeout(() => {
                useAnnouncerStore.getState().announce(exitMsg, "polite");
                debounceTimersRef.current.delete(key);
              }, BADGE_DEBOUNCE_MS);
              debounceTimersRef.current.set(key, timer);
            }
          }

          // Hibernation: subscribe once per panel; the listener fires on
          // hibernate/unhibernate. Snapshot is read inline so the cb sees the
          // current value without closure staleness.
          if (!hibernationUnsubsRef.current.has(terminal.id)) {
            const panelId = terminal.id;
            // Seed initial state so the first event reflects a true transition.
            hibernationStateRef.current.set(panelId, terminalInstanceService.isHibernated(panelId));
            const unsubscribe = terminalInstanceService.subscribeHibernation(panelId, () => {
              const prevHib = hibernationStateRef.current.get(panelId) ?? false;
              const nextHib = terminalInstanceService.isHibernated(panelId);
              if (prevHib === nextHib) return;
              hibernationStateRef.current.set(panelId, nextHib);
              const current = usePanelStore.getState().panelsById[panelId];
              const title = current?.title ?? "Terminal";
              const msg = nextHib ? `${title}: hibernated` : `${title}: woke up`;
              useAnnouncerStore.getState().announce(msg, "polite");
            });
            hibernationUnsubsRef.current.set(panelId, unsubscribe);
          }
        }

        // Location transitions (grid ↔ dock) for all panel kinds. These are
        // discrete user actions (minimize/restore), so they announce immediately
        // — no debounce (WCAG 4.1.3). overlay/background/trash are internal moves
        // that never warrant an announcement, so only grid↔dock is reported.
        if (prev && prev.location !== terminal.location) {
          if (prev.location === "grid" && terminal.location === "dock") {
            useAnnouncerStore.getState().announce(`${terminal.title} minimized to dock`, "polite");
          } else if (prev.location === "dock" && terminal.location === "grid") {
            useAnnouncerStore.getState().announce(`${terminal.title} restored to grid`, "polite");
          }
        }

        newStates.set(terminal.id, nextSnapshot);
      }

      // Cancel pending debounce timers for panels that have left panelIds.
      // Without this, a state-change timer scheduled just before removal would
      // fire and announce for a panel that is no longer in the store. Keys are
      // namespaced (`${id}`, `${id}:flow`, …), so we split off the base id.
      for (const [key, timer] of debounceTimersRef.current) {
        if (!newStates.has(basePanelId(key))) {
          clearTimeout(timer);
          debounceTimersRef.current.delete(key);
        }
      }

      // Tear down hibernation subscriptions for removed panels.
      for (const [id, unsubscribe] of hibernationUnsubsRef.current) {
        if (!newStates.has(id)) {
          unsubscribe();
          hibernationUnsubsRef.current.delete(id);
          hibernationStateRef.current.delete(id);
        }
      }

      previousStatesRef.current = newStates;
    };

    // Panel focus announcements
    const diffFocus = (state: ReturnType<typeof usePanelStore.getState>) => {
      const prev = prevFocusedIdRef.current;
      if (state.focusedId === prev) return;
      prevFocusedIdRef.current = state.focusedId;
      if (!state.focusedId) return;
      const terminal = state.panelsById[state.focusedId];
      if (!terminal) return;
      useAnnouncerStore.getState().announce(`${terminal.title} panel focused`);
    };

    // Maximize / unmaximize announcements (#9932). `maximizedId` lives in the
    // focus slice (not on the panel record). It announces immediately
    // (discrete user action, no debounce). The baseline seeded above keeps a
    // panel that was already maximized at mount silent.
    const diffMaximize = (state: ReturnType<typeof usePanelStore.getState>) => {
      const prev = prevMaximizedIdRef.current;
      if (prev === state.maximizedId) return;
      prevMaximizedIdRef.current = state.maximizedId;

      const currentPanels = state.panelsById;
      if (state.maximizedId !== null) {
        const title = currentPanels[state.maximizedId]?.title ?? "Panel";
        useAnnouncerStore.getState().announce(`${title} maximized`, "polite");
      } else if (prev !== null) {
        const title = currentPanels[prev]?.title ?? "Panel";
        useAnnouncerStore.getState().announce(`${title} unmaximized`, "polite");
      }
    };

    // Seed the diff baselines from the mount-time state without announcing —
    // matches the old effects' first-render behavior (prev === undefined
    // suppressed every announcement path; hibernation subscriptions were
    // still established).
    diffPanels(usePanelStore.getState());

    // Synchronous per-notification processing keeps the documented
    // announce-immediately contract for focus/location/maximize (#9932,
    // WCAG 4.1.3); agent/flow/queue/exit announcements stay debounced by
    // their own timers. The listener never throws into the writer's
    // setState — announcements are best-effort.
    const unsubscribe = usePanelStore.subscribe((state) => {
      try {
        diffFocus(state);
        diffPanels(state);
        diffMaximize(state);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("[useAccessibilityAnnouncements] announcement pass failed:", error);
      }
    });

    const timers = debounceTimersRef.current;
    const hibUnsubs = hibernationUnsubsRef.current;
    const hibStates = hibernationStateRef.current;
    return () => {
      unsubscribe();
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      for (const unsub of hibUnsubs.values()) {
        unsub();
      }
      hibUnsubs.clear();
      hibStates.clear();
    };
  }, []);
}
