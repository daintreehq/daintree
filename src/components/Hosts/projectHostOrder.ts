import { useEffect, useState } from "react";
import type { HostId } from "@shared/types/remoteHosts";
import type { ProjectHost } from "./projectHosts";
import type { HostProjectSummary } from "./projectHostSummary";

/**
 * The order a click on the section was made in, for the window that click
 * opens: written at the click, read by the new view as it mounts. Every view
 * shares one storage partition.
 */
export const PROJECT_HOSTS_HANDOFF_KEY = "daintree_project_hosts_handoff";

/** Long enough for a switch to open its view; past it, a handoff is someone else's. */
export const HANDOFF_TTL_MS = 15_000;

/** How long a view waits on a host that never answers before it orders without it. */
export const ORDER_SETTLE_MS = 5_000;

/**
 * This machine first; then hosts with an agent asking, then with work in
 * flight, then the rest that have the project, then the connected ones
 * without it, then the ones not connected. Bands, not counts, so a host
 * doesn't overtake another for one more agent working.
 */
export function hostPriority(host: ProjectHost, summary: HostProjectSummary | null): number {
  if (host.isLocal) return 0;
  if (host.away) return 5;
  if (host.presence === "none") return 4;
  if (!summary) return 3;
  if (summary.counts.asking > 0) return 1;
  if (summary.counts.quiet + summary.counts.review + summary.counts.running > 0) return 2;
  return 3;
}

/** Hosts by priority; within one, the order they came in (the host menu's, by name). */
export function priorityOrder(
  hosts: readonly ProjectHost[],
  summaries: ReadonlyMap<HostId, HostProjectSummary>
): HostId[] {
  return hosts
    .map((host, index) => ({
      hostId: host.hostId,
      index,
      priority: hostPriority(host, summaries.get(host.hostId) ?? null),
    }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.hostId);
}

/** Every host has said enough to be placed: no lookup still out, no read still due. */
export function isOrderSettled(hosts: readonly ProjectHost[]): boolean {
  return hosts.every(
    (host) =>
      host.away !== null ||
      host.presence === "none" ||
      host.presence === "unknown" ||
      (host.presence === "has" && host.entries !== null)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The order a click just handed this view, if one is fresh; each host once. */
function readHandoff(now: number): HostId[] | null {
  try {
    const raw = localStorage.getItem(PROJECT_HOSTS_HANDOFF_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.at !== "number" || !Array.isArray(parsed.order)) {
      return null;
    }
    if (now - parsed.at > HANDOFF_TTL_MS || parsed.at > now) return null;
    return [...new Set(parsed.order.filter((id): id is string => typeof id === "string"))];
  } catch {
    return null;
  }
}

/** Hand the order on screen to the window a click is about to open. */
export function handOffOrder(order: readonly HostId[]): void {
  try {
    localStorage.setItem(PROJECT_HOSTS_HANDOFF_KEY, JSON.stringify({ order, at: Date.now() }));
  } catch {
    // the new window orders from its own answers
  }
}

/**
 * `base` with the hosts no longer present dropped and each newcomer slotted
 * in after the last host the priority ranks ahead of it.
 */
function reconcile(base: readonly HostId[], desired: readonly HostId[]): HostId[] {
  const present = new Set(desired);
  const out = [...new Set(base)].filter((hostId) => present.has(hostId));
  const placed = new Set(out);
  for (const hostId of desired) {
    if (placed.has(hostId)) continue;
    const ahead = new Set(desired.slice(0, desired.indexOf(hostId)));
    let at = 0;
    for (let i = 0; i < out.length; i += 1) if (ahead.has(out[i]!)) at = i + 1;
    out.splice(at, 0, hostId);
    placed.add(hostId);
  }
  return out;
}

function sameOrder(a: readonly HostId[] | null, b: readonly HostId[]): boolean {
  return a !== null && a.length === b.length && a.every((hostId, i) => hostId === b[i]);
}

/**
 * The priority order, held still while it is in use. It takes the priority
 * order only while `free` (everything has answered, and neither the pointer
 * nor focus is in the section); otherwise it keeps what it showed, with a
 * host that joins placed once and kept there, so a row never shifts under a
 * click. A view opened by a click starts from the order that click was made
 * in. Nothing is held for an empty list: that is the host list still loading.
 */
export function useSteadyOrder(desired: readonly HostId[], free: boolean): HostId[] {
  const [held, setHeld] = useState<readonly HostId[] | null>(() => readHandoff(Date.now()));
  if (desired.length === 0) return [];
  const next = free ? [...desired] : reconcile(held ?? desired, desired);
  if (!sameOrder(held, next)) setHeld(next);
  return next;
}

/** Whether the section may reorder yet: settled, or out of patience with a host that never answers. */
export function useOrderPatience(): boolean {
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setPatient(false), ORDER_SETTLE_MS);
    return () => clearTimeout(timer);
  }, []);
  return patient;
}
