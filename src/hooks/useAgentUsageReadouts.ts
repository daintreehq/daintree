import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentUsageReadout, AgentUsageSnapshot } from "@shared/types/ipc/agentUsage";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";

const NONE: AgentUsageReadout[] = [];

/** First retry after a refused follow; doubles up to the cap while the view stays observable. */
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 30_000;

function newer(
  current: AgentUsageSnapshot | null,
  next: AgentUsageSnapshot | null
): AgentUsageSnapshot | null {
  if (next === null) return current;
  return current === null || next.revision >= current.revision ? next : current;
}

/**
 * Every usage readout this machine knows of (#17318): its own agents' and
 * every linked host's. Main watches them only while some view that shows
 * them can be seen, so this follows while this view is observable; changes
 * arrive pushed, and a seed a newer push overtook is dropped. A refused
 * follow clears what this view held from before, unless a push has since
 * confirmed it, and tries again while the view stays observable.
 */
export function useAgentUsageReadouts(): AgentUsageReadout[] {
  const [snapshot, setSnapshot] = useState<AgentUsageSnapshot | null>(null);
  // Read around the subscription by React, so an edge between render and subscribe isn't lost.
  const observable = useSyncExternalStore(
    subscribeProjectViewObservability,
    isProjectViewObservable
  );
  // Pushes that were newer than what this view held: only those confirm it.
  const confirmed = useRef(0);
  const heldRevision = useRef<number | null>(null);

  useEffect(() => {
    const api = window.electron?.agentUsage;
    if (!api) return;
    return api.onChanged((next) => {
      if (heldRevision.current !== null && next.revision < heldRevision.current) return;
      // Only news confirms: a repeat of what this view holds says nothing new.
      if (heldRevision.current === null || next.revision > heldRevision.current) {
        confirmed.current++;
      }
      heldRevision.current = next.revision;
      setSnapshot((current) => newer(current, next));
    });
  }, []);

  useEffect(() => {
    const api = window.electron?.agentUsage;
    if (!api || !observable) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const confirmedAtStart = confirmed.current;
    const follow = () => {
      api.setFollowing({ following: true }).then(
        (seed) => {
          if (cancelled || seed === null) return;
          if (heldRevision.current !== null && seed.revision < heldRevision.current) return;
          heldRevision.current = seed.revision;
          setSnapshot((current) => newer(current, seed));
        },
        () => {
          if (cancelled) return;
          if (confirmed.current === confirmedAtStart) setSnapshot(null);
          retry = setTimeout(follow, Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt++));
        }
      );
    };
    follow();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      void api.setFollowing({ following: false }).catch(() => {});
    };
  }, [observable]);

  return snapshot?.readouts ?? NONE;
}
