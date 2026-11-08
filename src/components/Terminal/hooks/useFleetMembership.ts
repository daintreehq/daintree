import { useFleetArmingStore } from "@/store/fleetArmingStore";

/**
 * A pane's own place in the fleet, read as two booleans so arming or disarming
 * another pane re-renders only the panes whose own state changed. Selecting the
 * whole `armedIds` set (or its size) wakes every pane in the grid on every
 * change.
 *
 * `isFleetComposing` is membership AND a fleet of two or more, so an unarmed
 * pane reads a constant when the fleet grows past one. An `isolated` pane is
 * never part of the fleet.
 */
export function useFleetMembership(
  terminalId: string,
  { isolated = false }: { isolated?: boolean } = {}
): { isArmed: boolean; isFleetComposing: boolean } {
  const isArmed = useFleetArmingStore((s) => !isolated && s.armedIds.has(terminalId));
  const isFleetComposing = useFleetArmingStore(
    (s) => !isolated && s.armedIds.has(terminalId) && s.armedIds.size >= 2
  );
  return { isArmed, isFleetComposing };
}
