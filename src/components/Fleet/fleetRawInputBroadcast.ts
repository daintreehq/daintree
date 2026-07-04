import { terminalClient } from "@/clients";
import { registerFleetInputBroadcastHandler } from "@/services/terminal/fleetInputRouter";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { isFleetArmEligible, useFleetArmingStore } from "@/store/fleetArmingStore";
import { useFleetFailureStore } from "@/store/fleetFailureStore";
import { usePanelStore } from "@/store/panelStore";
import { getNarrowPanel } from "@/store/slices/panelRegistry/selectors";
import { logWarn } from "@/utils/logger";
import type { BroadcastWriteResultPayload } from "@shared/types";
import { PERMANENT_FAILURE_CODES } from "./fleetBroadcast";

function resolveLiveFleetTargetIds(): string[] {
  const { armOrder, armedIds } = useFleetArmingStore.getState();
  if (armedIds.size < 2) return [];

  const { panelsById } = usePanelStore.getState();
  const targets: string[] = [];
  for (const id of armOrder) {
    if (!armedIds.has(id)) continue;
    if (isFleetArmEligible(getNarrowPanel(panelsById, id))) targets.push(id);
  }
  return targets;
}

export function broadcastFleetRawInput(originId: string, data: string): boolean {
  if (data.length === 0) return false;

  const armedIds = useFleetArmingStore.getState().armedIds;
  if (armedIds.size < 2 || !armedIds.has(originId)) return false;

  const targets = resolveLiveFleetTargetIds();
  if (targets.length < 2 || !targets.includes(originId)) return false;

  terminalClient.broadcast(targets, data);
  // Mirror the origin's xterm onData → onUserInput path on every non-origin
  // target so the `directing` indicator fires fleet-wide. Pass the raw
  // payload (not "") so Phase 2 escalation still kicks in for large pastes —
  // see #3565.
  for (const id of targets) {
    if (id === originId) continue;
    terminalInstanceService.notifyUserInput(id, data);
  }
  // Plain Enter is a submit. Mirror the structured-submit pattern from
  // `fleetExecution.ts`: optimistically advance `directing → working` for
  // every target (origin included — its own xterm onKey path is bypassed
  // when broadcast intercepts the raw input). Permanent failures fall
  // through to `applyFleetBroadcastResult`, which also disarms the target;
  // its `clearDirectingState` call is a no-op once we've already advanced
  // to `working` (TerminalAgentStateController guards on `agentState ===
  // "directing"`), so a dead-pipe target briefly reads as `working` until
  // the PTY's own exit signal drives the state machine forward. Disarm +
  // exit are the load-bearing recovery paths.
  // Match `\r` exactly — `\n` is Codex soft-newline, `\x1b\r` is legacy
  // ESC+CR, neither is a submit.
  if (data === "\r") {
    for (const id of targets) {
      terminalInstanceService.notifyEnterPressed(id);
    }
  }
  // Bump the broadcast signal so the ribbon can fire a one-shot commit
  // flash. Counter increments only; subscribers diff against their last
  // observed value to detect a new commit. Lives here (not in
  // fleetInputRouter) so the router stays free of fleetArmingStore imports
  // — the router is loaded eagerly by terminalInstanceService and pulling
  // the store in at that point breaks tests that mock usePanelStore.
  useFleetArmingStore.getState().noteBroadcastCommit();
  return true;
}

/**
 * Apply per-target results from a broadcast write.
 *
 * - Permanent failures (dead pipe, see `PERMANENT_FAILURE_CODES`, or any
 *   write error with no errno code) disarm the target so subsequent
 *   keystrokes don't keep firing into a gone process. The failure chip is
 *   *not* recorded for these — `fleetFailureStore`'s `armedIds` subscription
 *   would auto-dismiss it the moment we disarm, so a chip would never appear
 *   and we'd just thrash the store. An unknown errno is treated as permanent
 *   on purpose: the safer default is to stop typing into a target whose
 *   write semantics we can't reason about.
 * - Non-permanent failures (e.g., `EAGAIN`) leave arming alone and record a
 *   transient failure entry so the user sees the chip. The chip's "Retry
 *   failed" path is a no-op for the raw-input transport (single keystrokes
 *   are not meaningful to replay), so `recordFailure` is called with a
 *   `null` payload. `fleet.retryFailures` guards on `payload == null` and
 *   will skip the IPC write — using `""` here would slip through that guard
 *   and fire real empty-byte writes against live PTYs (#8705).
 *
 * Exported for testing — production wires this into the IPC subscription
 * registered at module load.
 */
export function applyFleetBroadcastResult(payload: BroadcastWriteResultPayload): void {
  if (!payload || !Array.isArray(payload.results) || payload.results.length === 0) return;

  const nonPermanentFailedIds: string[] = [];
  const permanentlyFailedIds: string[] = [];
  const succeededIds: string[] = [];
  for (const result of payload.results) {
    if (result.ok) {
      succeededIds.push(result.id);
      continue;
    }
    const code = result.error?.code;
    // Missing errno → permanent. We can't tell if the target is recoverable,
    // so the safer default is to disarm rather than keep firing keystrokes.
    if (!code || PERMANENT_FAILURE_CODES.has(code)) {
      permanentlyFailedIds.push(result.id);
    } else {
      nonPermanentFailedIds.push(result.id);
    }
  }

  // A successful write to a previously-failed target clears the dot — same
  // pattern as `fleetEnterBroadcast.ts`. Without this the banner persists
  // after the user has visibly recovered (e.g. ENOSPC freed and the next
  // keystroke landed).
  if (succeededIds.length > 0) {
    const failedSet = useFleetFailureStore.getState().failedIds;
    if (failedSet.size > 0) {
      for (const id of succeededIds) {
        if (failedSet.has(id)) useFleetFailureStore.getState().dismissId(id);
      }
    }
  }

  if (nonPermanentFailedIds.length === 0 && permanentlyFailedIds.length === 0) return;

  logWarn("[fleetRawInputBroadcast] broadcast had rejections", {
    nonPermanentFailedIds,
    permanentlyFailedIds,
  });

  if (nonPermanentFailedIds.length > 0) {
    // Null payload — raw input has no meaningful retry, and the
    // `Retry failed` action checks for `payload == null` before firing.
    // The chip still surfaces so the user notices something rejected.
    useFleetFailureStore
      .getState()
      .recordFailure(null, nonPermanentFailedIds, permanentlyFailedIds.length);
  }

  if (permanentlyFailedIds.length > 0) {
    const arming = useFleetArmingStore.getState();
    for (const id of permanentlyFailedIds) {
      // disarmId is a no-op for non-armed ids per fleetArmingStore semantics,
      // so a stale result for a manually-disarmed target is harmless.
      arming.disarmId(id);
      // Clear the synthetic `directing` set when we mirrored the broadcast
      // through notifyUserInput, so a dead-pipe target doesn't show the
      // blue indicator for the full 1.5s debounce window.
      terminalInstanceService.clearDirectingState(id);
    }
  }
}

registerFleetInputBroadcastHandler(broadcastFleetRawInput);

/**
 * Subscribe `applyFleetBroadcastResult` to the main-process broadcast-write
 * results IPC. Returns the IPC unsubscribe so the orchestrator's
 * `DisposableStore` can drop it on teardown — HMR re-imports and
 * `vi.resetModules()` rebuild the module fresh, so the previous listener
 * (bound to the orphaned store set) must be unsubscribed before the new
 * one is installed. Mirrors the `subscribeFleetArmingPanelPruning` pattern.
 */
export function subscribeFleetBroadcastResult(): () => void {
  return terminalClient.onBroadcastResult(applyFleetBroadcastResult);
}
