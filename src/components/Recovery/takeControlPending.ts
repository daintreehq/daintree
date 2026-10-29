import { useSyncExternalStore } from "react";
import { useDohertyGate } from "@/hooks/useDeferredLoading";

/**
 * Which projects a take-control request is in flight for, from any control.
 * Kept apart from the action itself, which reaches the panel store: a file or
 * plugin placeholder draws the shared busy state without pulling that in.
 */

const pending = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isTakeControlPending(projectId: string): boolean {
  return pending.has(projectId);
}

export function setTakeControlPending(projectId: string, inFlight: boolean): void {
  if (pending.has(projectId) === inFlight) return;
  if (inFlight) pending.add(projectId);
  else pending.delete(projectId);
  emit();
}

/** Whether a take-control request for this project is in flight, from any control. */
export function useTakeControlPending(projectId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => (projectId ? pending.has(projectId) : false),
    () => false
  );
}

/**
 * Whether a control offering Take control should draw it as busy: only once
 * the request has outlasted the 400ms gate, so a quick hand-over never
 * flashes a spinner. A click inside the gate is already ignored by the
 * one-request-per-project guard.
 */
export function useTakeControlBusy(projectId: string | null | undefined): boolean {
  return useDohertyGate(useTakeControlPending(projectId));
}

export function _resetTakeControlPendingForTesting(): void {
  pending.clear();
  listeners.clear();
}
