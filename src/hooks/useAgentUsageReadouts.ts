import { useEffect, useState } from "react";
import type { AgentUsageReadout, AgentUsageSnapshot } from "@shared/types/ipc/agentUsage";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";

const NONE: AgentUsageReadout[] = [];

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
 * arrive pushed, and a seed a newer push overtook is dropped.
 */
export function useAgentUsageReadouts(): AgentUsageReadout[] {
  const [snapshot, setSnapshot] = useState<AgentUsageSnapshot | null>(null);
  const [observable, setObservable] = useState(isProjectViewObservable);

  useEffect(() => subscribeProjectViewObservability(setObservable), []);

  useEffect(() => {
    const api = window.electron?.agentUsage;
    if (!api) return;
    return api.onChanged((next) => setSnapshot((current) => newer(current, next)));
  }, []);

  useEffect(() => {
    const api = window.electron?.agentUsage;
    if (!api || !observable) return;
    let cancelled = false;
    api.setFollowing({ following: true }).then(
      (seed) => {
        if (!cancelled) setSnapshot((current) => newer(current, seed));
      },
      () => {
        // Nothing to show is the answer: the row stays hidden.
      }
    );
    return () => {
      cancelled = true;
      void api.setFollowing({ following: false }).catch(() => {});
    };
  }, [observable]);

  return snapshot?.readouts ?? NONE;
}
