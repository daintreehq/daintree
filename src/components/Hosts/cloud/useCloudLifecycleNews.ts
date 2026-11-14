import { useEffect, useState, useSyncExternalStore } from "react";
import type { CloudHostStatus } from "@shared/types/cloudHosts";
import type { HostId } from "@shared/types/remoteHosts";
import { cloudStatusLabel } from "./cloudHostLabels";

interface News {
  seq: number;
  moved: ReadonlyArray<{ hostId: HostId; label: string }>;
}

// One record per renderer: every surface reads the same transitions, so a
// move is worked out once however many surfaces show the machines.
let ingested: readonly CloudHostStatus[] | null = null;
let labels: ReadonlyMap<HostId, string> | null = null;
let news: News = { seq: 0, moved: [] };
/** Mounted announcers, newest last; only the newest speaks. */
const owners: Array<{ id: symbol; since: number }> = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function ingest(statuses: readonly CloudHostStatus[]): void {
  if (statuses === ingested) return;
  ingested = statuses;
  const next = new Map<HostId, string>();
  const moved: Array<{ hostId: HostId; label: string }> = [];
  for (const status of statuses) {
    const label = cloudStatusLabel(status);
    next.set(status.hostId, label);
    const before = labels?.get(status.hostId);
    if (before !== undefined && before !== label) moved.push({ hostId: status.hostId, label });
  }
  labels = next;
  if (moved.length > 0) {
    news = { seq: news.seq + 1, moved };
    emit();
  }
}

/**
 * One sentence per machine whose lifecycle moved ("boat-e2e: machine
 * running"), for a polite status message. Every surface that shows machines
 * mounts one, and only the newest mounted speaks (Settings over the host
 * chip), so a transition is heard once whichever is open. The first sight of
 * a machine is not news, and neither is an age ticking or an auto-stop
 * moving: only the state word changing is.
 */
export function useCloudLifecycleNews(
  statuses: readonly CloudHostStatus[],
  nameOf: (hostId: HostId) => string
): string {
  const [id] = useState(() => Symbol("cloud-news"));
  useEffect(() => {
    // News from before it took over was someone else's to say.
    owners.push({ id, since: news.seq });
    emit();
    return () => {
      const at = owners.findIndex((owner) => owner.id === id);
      if (at >= 0) owners.splice(at, 1);
      const top = owners[owners.length - 1];
      if (top) top.since = news.seq;
      emit();
    };
  }, [id]);
  useEffect(() => ingest(statuses), [statuses]);
  const mine = useSyncExternalStore(subscribe, () => {
    const top = owners[owners.length - 1];
    return top?.id === id && news.seq > top.since ? news : null;
  });
  return mine
    ? mine.moved.map((m) => `${nameOf(m.hostId)}: ${m.label.toLowerCase()}`).join(". ")
    : "";
}
