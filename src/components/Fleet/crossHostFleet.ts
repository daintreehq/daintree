import { useSyncExternalStore } from "react";
import type { HostId } from "@shared/types/remoteHosts";

/**
 * Agents on other hosts armed into this view's fleet. The panel store only
 * knows this view's own terminals, so these ride beside the armed set under
 * host-qualified ids, and their submits go over each host's link.
 */
export interface CrossHostFleetTarget {
  /** Host-qualified id used wherever the fleet lists targets. */
  key: string;
  hostId: HostId;
  hostName: string;
  terminalId: string;
  title: string;
}

const PREFIX = "host-fleet:";

let armed = new Map<string, CrossHostFleetTarget>();
let snapshot: CrossHostFleetTarget[] = [];
const listeners = new Set<() => void>();

function publish(next: Map<string, CrossHostFleetTarget>): void {
  armed = next;
  snapshot = [...next.values()];
  for (const listener of [...listeners]) listener();
}

export function crossHostTargetKey(hostId: HostId, terminalId: string): string {
  return `${PREFIX}${hostId}:${terminalId}`;
}

export function isCrossHostTargetId(id: string): boolean {
  return armed.has(id);
}

export function getCrossHostTarget(id: string): CrossHostFleetTarget | null {
  return armed.get(id) ?? null;
}

export function getArmedCrossHostTargets(): CrossHostFleetTarget[] {
  return snapshot;
}

export function armCrossHostTarget(target: Omit<CrossHostFleetTarget, "key">): void {
  const key = crossHostTargetKey(target.hostId, target.terminalId);
  if (armed.has(key)) return;
  const next = new Map(armed);
  next.set(key, { ...target, key });
  publish(next);
}

export function disarmCrossHostTarget(key: string): void {
  if (!armed.has(key)) return;
  const next = new Map(armed);
  next.delete(key);
  publish(next);
}

/** Keep only targets on hosts still in the host list. */
export function retainCrossHostTargetsFor(hostIds: ReadonlySet<HostId>): void {
  const next = new Map([...armed].filter(([, target]) => hostIds.has(target.hostId)));
  if (next.size !== armed.size) publish(next);
}

export function clearCrossHostTargets(): void {
  if (armed.size > 0) publish(new Map());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useArmedCrossHostTargets(): CrossHostFleetTarget[] {
  return useSyncExternalStore(subscribe, getArmedCrossHostTargets, getArmedCrossHostTargets);
}

/** Submit over the target host's link. Rejections carry the host's errno-led message. */
export async function submitCrossHostTarget(key: string, text: string): Promise<void> {
  const target = armed.get(key);
  if (!target) throw new Error(`EBADF: fleet target ${key} is no longer armed`);
  await window.electron.hostMetrics.submitFleet({
    hostId: target.hostId,
    terminalId: target.terminalId,
    text,
  });
}

export function _resetCrossHostFleetForTesting(): void {
  armed = new Map();
  snapshot = [];
  listeners.clear();
}
