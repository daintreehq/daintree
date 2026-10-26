import { useEffect, useSyncExternalStore } from "react";
import type { HostId } from "@shared/types/remoteHosts";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import { logWarn } from "@/utils/logger";

/** A worktree list a host gave, and when it answered. */
export interface HostWorktreeListing {
  entries: readonly HostWorktreeEntry[];
  listedAt: number;
}

interface WorktreeCatalogueEntry {
  lastGood: HostWorktreeListing | null;
  /** The last request: pending, or when it settled. */
  pending: boolean;
  settledAt: number;
  failed: boolean;
}

/** A finished read is reused this long before a host is asked again. */
const CACHE_TTL_MS = 10_000;

// Module-level like the project catalogue: a host's last list outlives the
// palette that asked for it, and is marked stale when its link has gone.
let entries: ReadonlyMap<HostId, WorktreeCatalogueEntry> = new Map();
let nextGeneration = 1;
const generations = new Map<HostId, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getEntries(): ReadonlyMap<HostId, WorktreeCatalogueEntry> {
  return entries;
}

function setEntry(hostId: HostId, entry: WorktreeCatalogueEntry | null): void {
  const next = new Map(entries);
  if (entry) next.set(hostId, entry);
  else next.delete(hostId);
  entries = next;
  emit();
}

function requestHostWorktrees(hostId: HostId, now: number): void {
  const entry = entries.get(hostId);
  if (entry?.pending) return;
  if (entry && !entry.failed && now - entry.settledAt < CACHE_TTL_MS) return;
  const list = window.electron?.hostMetrics?.listWorktrees;
  if (typeof list !== "function") return;
  const generation = nextGeneration++;
  generations.set(hostId, generation);
  setEntry(hostId, {
    lastGood: entry?.lastGood ?? null,
    pending: true,
    settledAt: entry?.settledAt ?? 0,
    failed: false,
  });
  const settle = (result: readonly HostWorktreeEntry[] | null) => {
    if (generations.get(hostId) !== generation) return;
    const current = entries.get(hostId);
    const settledAt = Date.now();
    setEntry(hostId, {
      lastGood: result ? { entries: result, listedAt: settledAt } : (current?.lastGood ?? null),
      pending: false,
      settledAt,
      failed: result === null,
    });
  };
  list({ hostId }).then(settle, (error: unknown) => {
    logWarn("[Hosts] Couldn't list another host's worktrees", { error });
    settle(null);
  });
}

const NO_LISTINGS: ReadonlyMap<HostId, HostWorktreeListing> = new Map();

/**
 * Each host's worktrees, for a search to look through. Asked only while
 * `enabled` (a query is typed), and only of the hosts in `reachableIds`; a host
 * that isn't reachable keeps the list it gave earlier, never dialled here.
 * Browsing asks nothing, so a host's worktrees cost it nothing until searched.
 */
export function useHostWorktreeListings(
  reachableIds: readonly HostId[],
  enabled: boolean
): ReadonlyMap<HostId, HostWorktreeListing> {
  const catalogue = useSyncExternalStore(subscribe, getEntries, getEntries);
  const key = reachableIds.join("\n");
  useEffect(() => {
    if (!enabled || key === "") return;
    const now = Date.now();
    for (const id of key.split("\n")) requestHostWorktrees(id, now);
  }, [enabled, key]);
  const listings = new Map<HostId, HostWorktreeListing>();
  for (const [hostId, entry] of catalogue) if (entry.lastGood) listings.set(hostId, entry.lastGood);
  return enabled ? listings : NO_LISTINGS;
}

/** A removed host's history goes with it; the id could come back as another machine. */
export function pruneHostWorktrees(known: ReadonlySet<HostId>): void {
  for (const id of [...entries.keys()]) {
    if (known.has(id)) continue;
    generations.delete(id);
    setEntry(id, null);
  }
}

export function _resetHostWorktreesForTesting(): void {
  entries = new Map();
  generations.clear();
  listeners.clear();
}
