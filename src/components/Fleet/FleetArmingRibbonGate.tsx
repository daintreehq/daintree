import { useKeepMounted } from "@/hooks/useKeepMounted";
import { lazyWhenLoaded } from "@/lib/lazyWithPreload";
import { selectFleetMemberCount, useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { useFleetPendingActionStore } from "@/store/fleetPendingActionStore";
// Keystrokes fan out to the fleet from the moment a second pane is armed, not
// from whenever the ribbon's chunk lands.
import "./fleetRawInputBroadcast";

const LazyFleetArmingRibbon = lazyWhenLoaded(
  () => import("./FleetArmingRibbon"),
  (m) => m.FleetArmingRibbon
);

/**
 * The fleet ribbon, loaded once there is a fleet to show: a member armed here
 * or on another host, a failure banner, or a confirmation waiting. Most views
 * never arm a pane, so they never pay for the ribbon.
 *
 * Kept mounted once loaded: the ribbon still has work after the fleet drains —
 * the "Fleet disarmed" announcement, a failure banner that outlives the fleet,
 * a save dialog someone is typing in, preview cleanup.
 */
export function FleetArmingRibbonGate() {
  const hasMembers = useFleetArmingStore((s) => selectFleetMemberCount(s) > 0);
  const hasFailures = useFleetFailureStore((s) => s.failedIds.size > 0);
  const hasPending = useFleetPendingActionStore((s) => s.pending !== null);
  const active = useKeepMounted(hasMembers || hasFailures || hasPending);
  return active ? <LazyFleetArmingRibbon /> : null;
}
