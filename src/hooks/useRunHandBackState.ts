import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import type { AgentState } from "@shared/types/agent";
import {
  handBackRunKey,
  handBackStateForRun,
  resolveSessionPresentation,
  type HandBackSeenState,
  type SessionPresentationState,
} from "@/lib/handBackPresentation";

/** One terminal's hand-back state. A primitive, so unrelated fleet changes don't re-render. */
export function useRunHandBackState(terminalId: string): HandBackSeenState {
  return useFleetSnapshotStore((s) => handBackStateForRun(s.snapshot, terminalId));
}

/** Hand-back states for several terminals, in the order given. */
export function useRunHandBackStates(terminalIds: readonly string[]): HandBackSeenState[] {
  return useFleetSnapshotStore(
    useShallow((s) => terminalIds.map((id) => handBackStateForRun(s.snapshot, id)))
  );
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * Every terminal the fleet holds a hand-back for. Stable across fleet ticks that
 * leave the set alone, so it can sit in a store selector's closure.
 */
export function useHandBackRunIds(): ReadonlySet<string> {
  const key = useFleetSnapshotStore((s) => handBackRunKey(s.snapshot));
  return useMemo(() => (key === "" ? EMPTY_IDS : new Set(key.split("\n"))), [key]);
}

/**
 * What one terminal's state glyph should draw: its display state, with a
 * hand-back drawn unread or done rather than as the amber waiting ring. The raw
 * observation and its reason are read from the panel store here so a surface
 * that only carries the display state still makes the same call the pane does.
 */
export function useSessionPresentation(
  terminalId: string,
  displayState: AgentState | undefined
): SessionPresentationState | undefined {
  const handBack = useRunHandBackState(terminalId);
  const raw = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) ? panel.agentState : undefined;
  });
  const reason = usePanelStore((s) => {
    const panel = s.panelsById[terminalId];
    return panel && isPtyPanel(panel) ? panel.waitingReason : undefined;
  });
  return resolveSessionPresentation(displayState, raw, reason, handBack);
}
