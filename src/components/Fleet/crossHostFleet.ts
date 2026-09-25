import type { HostId } from "@shared/types/remoteHosts";
import { useFleetArmingStore, type CrossHostFleetTarget } from "@/store/fleetArmingStore";
import { isClientAppError } from "@/utils/clientAppError";

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
 * Submits whose outcome the host never confirmed, by target key: the opId
 * and the prompt it carried. A retry of the same prompt reuses the opId, so a
 * host that did run it answers from its record instead of running it again.
 */
const unresolved = new Map<string, { opId: string; text: string }>();

function isUnknownOutcome(error: unknown): boolean {
  return (
    isClientAppError(error) &&
    (error.code === "OUTCOME_UNKNOWN" || error.code === "HOST_DISCONNECTED")
  );
}

/**
 * Submit over the target host's link, under an opId minted for this one
 * submit. `retry` reuses the opId of an earlier submit of the same prompt
 * whose outcome was never confirmed. Rejections carry the host's errno-led message.
 */
export async function submitCrossHostTarget(
  key: string,
  text: string,
  options: { retry?: boolean } = {}
): Promise<void> {
  const target = getCrossHostTarget(key);
  if (!target) throw new Error(`EBADF: fleet target ${key} is no longer armed`);
  const earlier = unresolved.get(key);
  const opId =
    options.retry === true && earlier !== undefined && earlier.text === text
      ? earlier.opId
      : crypto.randomUUID();
  try {
    await window.electron.hostMetrics.submitFleet({
      hostId: target.hostId,
      terminalId: target.terminalId,
      text,
      opId,
    });
    unresolved.delete(key);
  } catch (error) {
    if (isUnknownOutcome(error)) unresolved.set(key, { opId, text });
    else unresolved.delete(key);
    throw error;
  }
}

export function _resetCrossHostFleetForTesting(): void {
  unresolved.clear();
  useFleetArmingStore.setState({ crossHostTargets: [] });
}
