import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import {
  fleetBandForRun,
  fleetBandRunKey,
  fleetUnseenAskForRun,
  fleetUnseenAsks,
  type FleetBand,
  type UnseenAsk,
} from "@/lib/fleetAttention";

/**
 * One terminal's fleet band, or undefined before the fleet has reported it. A
 * primitive, so fleet pushes that leave this run's band alone don't re-render.
 */
export function useRunFleetBand(terminalId: string): FleetBand | undefined {
  return useFleetSnapshotStore((s) => fleetBandForRun(s.snapshot, terminalId));
}

const EMPTY_RUN_IDS: ReadonlySet<string> = new Set();

/**
 * Runs the fleet places in `bands`, which must be a module constant. Stable
 * across fleet pushes that leave the set alone, so it can sit in a store
 * selector's closure.
 */
export function useFleetBandRunIds(bands: ReadonlySet<FleetBand>): ReadonlySet<string> {
  const key = useFleetSnapshotStore((s) => fleetBandRunKey(s.snapshot, bands));
  return useMemo(() => (key === "" ? EMPTY_RUN_IDS : new Set(key.split("\n"))), [key]);
}

/**
 * This terminal's current stop as an outstanding ask, and whose: the pane
 * edge's amber. Undefined before the fleet has reported it.
 */
export function useRunUnseenAsk(terminalId: string): UnseenAsk | undefined {
  return useFleetSnapshotStore((s) => fleetUnseenAskForRun(s.snapshot, terminalId));
}

/** Every run with an outstanding ask, by run id, the same map across pushes that leave the asks alone. */
export function useUnseenAsks(): ReadonlyMap<string, UnseenAsk> {
  return useFleetSnapshotStore(useShallow((s) => fleetUnseenAsks(s.snapshot)));
}
