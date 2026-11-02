import { useMemo } from "react";
import { useFleetSnapshotStore } from "@/store/fleetSnapshotStore";
import {
  fleetBandForRun,
  fleetBandRunKey,
  fleetUnseenAskRunKey,
  isFleetUnseenAsk,
  type FleetBand,
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
 * Whether the fleet reads this terminal's current stop as an ask the user
 * hasn't seen: the pane edge's amber. False before the fleet has reported it.
 */
export function useRunUnseenAsk(terminalId: string): boolean {
  return useFleetSnapshotStore((s) => isFleetUnseenAsk(s.snapshot, terminalId));
}

/** Runs whose current stop is an ask the user hasn't seen, stable across pushes that leave the set alone. */
export function useUnseenAskRunIds(): ReadonlySet<string> {
  const key = useFleetSnapshotStore((s) => fleetUnseenAskRunKey(s.snapshot));
  return useMemo(() => (key === "" ? EMPTY_RUN_IDS : new Set(key.split("\n"))), [key]);
}
