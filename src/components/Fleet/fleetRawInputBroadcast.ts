import { terminalClient } from "@/clients";
import { registerFleetInputBroadcastHandler } from "@/services/terminal/fleetInputRouter";
import { isFleetArmEligible, useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { usePanelStore } from "@/store/panelStore";
import { logWarn } from "@/utils/logger";
import type { BroadcastWriteResultPayload } from "@shared/types";

/**
 * Errno codes that mean the target PTY is permanently gone — the renderer
 * should auto-disarm so the user isn't typing into a dead pane. Other
 * failures still surface the failure chip but leave the arming alone.
 */
const PERMANENT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "EPIPE",
  "EIO",
  "EBADF",
  "ECONNRESET",
]);

/**
 * Track the most recent payload broadcast so the failure chip can replay it
 * via "Retry failed". Updated on every fan-out and read when the
 * `broadcast-write-result` event fires from the pty-host.
 */
let lastBroadcastPayload = "";

function resolveLiveFleetTargetIds(): string[] {
  const { armOrder, armedIds } = useFleetArmingStore.getState();
  if (armedIds.size < 2) return [];

  const { panelsById } = usePanelStore.getState();
  const targets: string[] = [];
  for (const id of armOrder) {
    if (!armedIds.has(id)) continue;
    const panel = panelsById[id];
    if (isFleetArmEligible(panel)) targets.push(id);
  }
  return targets;
}

export function broadcastFleetRawInput(originId: string, data: string): boolean {
  if (data.length === 0) return false;

  const armedIds = useFleetArmingStore.getState().armedIds;
  if (armedIds.size < 2 || !armedIds.has(originId)) return false;

  const targets = resolveLiveFleetTargetIds();
  if (targets.length < 2 || !targets.includes(originId)) return false;

  lastBroadcastPayload = data;
  terminalClient.broadcast(targets, data);
  return true;
}

/**
 * Apply per-target results from a broadcast write.
 *
 * - Permanent failures (dead pipe, see `PERMANENT_FAILURE_CODES`) disarm the
 *   target so subsequent keystrokes don't keep firing into a gone process.
 *   The failure chip is *not* recorded for these — `fleetFailureStore`'s
 *   `armedIds` subscription would auto-dismiss it the moment we disarm, so a
 *   chip would never appear and we'd just thrash the store.
 * - Non-permanent failures (e.g., `ENOSPC`) leave arming alone and record
 *   the failure so the user sees the chip and can retry.
 *
 * Exported for testing — production wires this into the IPC subscription
 * registered at module load.
 */
export function applyFleetBroadcastResult(payload: BroadcastWriteResultPayload): void {
  if (!payload || !Array.isArray(payload.results) || payload.results.length === 0) return;

  const nonPermanentFailedIds: string[] = [];
  const permanentlyFailedIds: string[] = [];
  for (const result of payload.results) {
    if (result.ok) continue;
    const code = result.error?.code;
    if (code && PERMANENT_FAILURE_CODES.has(code)) {
      permanentlyFailedIds.push(result.id);
    } else {
      nonPermanentFailedIds.push(result.id);
    }
  }

  if (nonPermanentFailedIds.length === 0 && permanentlyFailedIds.length === 0) return;

  logWarn("[fleetRawInputBroadcast] broadcast had rejections", {
    nonPermanentFailedIds,
    permanentlyFailedIds,
  });

  if (nonPermanentFailedIds.length > 0) {
    useFleetFailureStore.getState().recordFailure(lastBroadcastPayload, nonPermanentFailedIds);
  }

  if (permanentlyFailedIds.length > 0) {
    const arming = useFleetArmingStore.getState();
    for (const id of permanentlyFailedIds) {
      arming.disarmId(id);
    }
  }
}

registerFleetInputBroadcastHandler(broadcastFleetRawInput);

// Module-level subscription: HMR/test re-imports would otherwise stack
// listeners. Stash a flag on globalThis the same way fleetArmingStore does
// so a reload reuses the existing subscription instead of doubling up.
const FLEET_BROADCAST_RESULT_SUB_KEY = "__daintreeFleetBroadcastResultSubscription";

interface FleetBroadcastResultSubscriptionState {
  registered: boolean;
}

function getBroadcastResultSubscriptionState(): FleetBroadcastResultSubscriptionState {
  const target = globalThis as typeof globalThis & {
    [FLEET_BROADCAST_RESULT_SUB_KEY]?: FleetBroadcastResultSubscriptionState;
  };
  const existing = target[FLEET_BROADCAST_RESULT_SUB_KEY];
  if (existing) return existing;
  const created: FleetBroadcastResultSubscriptionState = { registered: false };
  target[FLEET_BROADCAST_RESULT_SUB_KEY] = created;
  return created;
}

(function registerBroadcastResultSubscription(): void {
  if (typeof window === "undefined") return;
  // `window.electron` is declared as required for the renderer, but unit tests
  // run under jsdom without preload. Cast to a permissive shape so the runtime
  // existence check is honest.
  const win = window as unknown as {
    electron?: { terminal?: { onBroadcastWriteResult?: unknown } };
  };
  if (typeof win.electron?.terminal?.onBroadcastWriteResult !== "function") return;
  const subState = getBroadcastResultSubscriptionState();
  if (subState.registered) return;
  subState.registered = true;
  terminalClient.onBroadcastResult(applyFleetBroadcastResult);
})();
