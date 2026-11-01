import { useShallow } from "zustand/react/shallow";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import type { AgentState } from "@shared/types/agent";
import { useRunFleetBand } from "@/hooks/useRunFleetBand";
import { fleetBandForRun, type FleetBand } from "@/lib/fleetAttention";
import {
  resolvePaneSessionPresentation,
  type PaneObservation,
  type SessionPresentationState,
} from "@/lib/paneSessionPresentation";

/**
 * What one terminal's pane last observed of its run, as the panel store holds
 * it. Undefined for a terminal this view holds no pane for, and for `null`, so
 * a caller that may not own the terminal can still call it unconditionally.
 */
export function usePaneObservation(terminalId: string | null): PaneObservation | undefined {
  return usePanelStore(
    useShallow((s) => {
      if (terminalId === null) return undefined;
      const panel = s.panelsById[terminalId];
      if (!panel || !isPtyPanel(panel)) return undefined;
      return {
        agentState: panel.agentState,
        waitingReason: panel.waitingReason,
        isRestarting: panel.isRestarting,
        runtimeStatus: panel.runtimeStatus,
      };
    })
  );
}

/**
 * What one terminal's state glyph draws, wherever the run shows: its display
 * state through the run's fleet band and the pane's own observation, the call
 * the pane's header makes. Amber is an unread Canopy ask the pane still shows
 * stopped, a hand-back is unread or finished, an error wait is blocked, and a
 * prompt that asks nothing draws nothing.
 */
export function useRunSessionPresentation(
  terminalId: string,
  displayState: AgentState | undefined
): SessionPresentationState | undefined {
  const band = useRunFleetBand(terminalId);
  const observed = usePaneObservation(terminalId);
  return resolvePaneSessionPresentation(displayState, band, observed);
}

/** Fleet bands for several terminals, in the order given. Primitives, so a push that moves none of them doesn't re-render. */
export function useRunFleetBands(terminalIds: readonly string[]): (FleetBand | undefined)[] {
  return useFleetSnapshotStore(
    useShallow((s) => terminalIds.map((id) => fleetBandForRun(s.snapshot, id)))
  );
}
