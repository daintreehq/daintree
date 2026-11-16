import type { PanelInstance } from "@shared/types/panel";

// The fields `flushPanelStatusBuffer` writes every frame a docked agent streams.
// None of them is visible while the panel is parked offscreen.
const STATUS_FLUSH_KEYS: ReadonlySet<string> = new Set([
  "activityHeadline",
  "activityStatus",
  "activityType",
  "lastCommand",
  "flowStatus",
  "flowStatusTimestamp",
  "heldDurationMs",
  "runtimeStatus",
]);

// `runtimeStatus` mixes flow churn with the lifecycle states a parked panel
// still has to hear about (an exit or error changes what its pane offers).
function runtimeStopped(panel: PanelInstance): boolean {
  const status: unknown = Reflect.get(panel, "runtimeStatus");
  return status === "exited" || status === "error";
}

/**
 * Whether two records of a parked panel differ only by the status buffer's
 * per-frame writes. A parked portal keeps its previous record across such a
 * change instead of repainting a subtree nobody can see (#17053); identity,
 * configuration and lifecycle changes still get through.
 */
export function parkedPanelsEquivalent(a: PanelInstance, b: PanelInstance): boolean {
  if (a === b) return true;
  if (runtimeStopped(a) !== runtimeStopped(b)) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (STATUS_FLUSH_KEYS.has(key)) continue;
    if (Reflect.get(a, key) !== Reflect.get(b, key)) return false;
  }
  return true;
}
