import type { HostId } from "@shared/types/remoteHosts";
import { useFleetArmingStore, type CrossHostFleetTarget } from "@/store/fleetArmingStore";
import { isClientAppError } from "@/utils/clientAppError";
import { FLEET_SAFE_RETRY_MS } from "@shared/config/fleetSubmitRetention";

export type { CrossHostFleetTarget };

/**
 * Agents on other hosts armed into this view's fleet. Their membership lives
 * in `useFleetArmingStore` beside this view's own panes, so exiting the fleet
 * or replacing its selection drops them with everything else.
 */

const PREFIX = "host-fleet:";

export function crossHostTargetKey(hostId: HostId, terminalId: string): string {
  return `${PREFIX}${hostId}:${terminalId}`;
}

/** Whether `id` names another host's agent: never a local pane, armed or not. */
export function isHostQualifiedTargetId(id: string): boolean {
  return id.startsWith(PREFIX);
}

export function isCrossHostTargetId(id: string): boolean {
  return getCrossHostTarget(id) !== null;
}

export function getCrossHostTarget(id: string): CrossHostFleetTarget | null {
  return useFleetArmingStore.getState().crossHostTargets.find((t) => t.key === id) ?? null;
}

export function getArmedCrossHostTargets(): readonly CrossHostFleetTarget[] {
  return useFleetArmingStore.getState().crossHostTargets;
}

export function armCrossHostTarget(target: Omit<CrossHostFleetTarget, "key">): void {
  useFleetArmingStore
    .getState()
    .armCrossHostTarget({ ...target, key: crossHostTargetKey(target.hostId, target.terminalId) });
}

export function disarmCrossHostTarget(key: string): void {
  useFleetArmingStore.getState().disarmCrossHostTarget(key);
}

/** Keep only targets on hosts still in the host list. */
export function retainCrossHostTargetsFor(hostIds: ReadonlySet<HostId>): void {
  useFleetArmingStore.getState().retainCrossHostTargetsFor(hostIds);
  for (const key of [...unresolved.keys()]) {
    if (!getCrossHostTarget(key)) unresolved.delete(key);
  }
}

export function useArmedCrossHostTargets(): readonly CrossHostFleetTarget[] {
  return useFleetArmingStore((s) => s.crossHostTargets);
}

/**
 * Submits whose outcome the host never confirmed, by target key: the opId,
 * the prompt it carried, and when this Shell first sent it. A retry of the
 * same prompt reuses the opId, so a host that did run it answers from its
 * record instead of running it again. The host keeps that record for
 * `FLEET_SUBMIT_RETENTION_MS` from when it settled, so the reuse is trusted only
 * for `FLEET_SAFE_RETRY_MS` after the first send; past that the outcome is
 * unknown and only a send the person confirms goes out, under a fresh opId.
 */
interface UnconfirmedSubmit {
  opId: string;
  text: string;
  firstSentAt: number;
}

const unresolved = new Map<string, UnconfirmedSubmit>();

function isUnknownOutcome(error: unknown): boolean {
  return (
    isClientAppError(error) &&
    (error.code === "OUTCOME_UNKNOWN" || error.code === "HOST_DISCONNECTED")
  );
}

/**
 * When retrying `text` to `key` stops being safe; null when no unconfirmed
 * submit of that prompt is on record.
 */
export function crossHostSafeRetryDeadline(key: string, text: string): number | null {
  const earlier = unresolved.get(key);
  if (!earlier || earlier.text !== text) return null;
  return earlier.firstSentAt + FLEET_SAFE_RETRY_MS;
}

/** Whether a retry of `text` to `key` may type it twice, so only the person can send it again. */
export function needsCrossHostResendConfirmation(
  key: string,
  text: string,
  now: number = Date.now()
): boolean {
  const deadline = crossHostSafeRetryDeadline(key, text);
  return deadline !== null && now >= deadline;
}

/** The person confirmed sending again: the next retry of these targets is a fresh send. */
export function confirmCrossHostResend(keys: Iterable<string>): void {
  for (const key of keys) unresolved.delete(key);
}

/**
 * Submit over the target host's link, under an opId minted for this one
 * submit. `retry` reuses the opId of an earlier submit of the same prompt
 * whose outcome was never confirmed, while the host still holds its record.
 * Rejections carry the host's errno-led message.
 */
export async function submitCrossHostTarget(
  key: string,
  text: string,
  options: { retry?: boolean } = {}
): Promise<void> {
  const target = getCrossHostTarget(key);
  if (!target) throw new Error(`EBADF: fleet target ${key} is no longer armed`);
  const earlier = unresolved.get(key);
  const reuse = options.retry === true && earlier?.text === text ? earlier : undefined;
  if (reuse && needsCrossHostResendConfirmation(key, text)) {
    // Refused before anything is sent: the host may have forgotten this opId.
    throw new Error(
      `Couldn't confirm whether ${target.hostName} received the prompt; sending it again needs confirmation`
    );
  }
  const opId = reuse?.opId ?? crypto.randomUUID();
  const firstSentAt = reuse?.firstSentAt ?? Date.now();
  try {
    await window.electron.hostMetrics.submitFleet({
      hostId: target.hostId,
      terminalId: target.terminalId,
      text,
      opId,
    });
    forgetOwnRecord(key, opId);
  } catch (error) {
    if (isUnknownOutcome(error)) unresolved.set(key, { opId, text, firstSentAt });
    else forgetOwnRecord(key, opId);
    throw error;
  }
}

/** A submit settling late must not clear the record a newer submit to the same target left. */
function forgetOwnRecord(key: string, opId: string): void {
  if (unresolved.get(key)?.opId === opId) unresolved.delete(key);
}

export function _resetCrossHostFleetForTesting(): void {
  unresolved.clear();
  useFleetArmingStore.setState({ crossHostTargets: [] });
}
