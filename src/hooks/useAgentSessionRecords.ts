import { useEffect, useState } from "react";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";

/**
 * Fetches the (unscoped, newest-first) closed-session journal and keeps it
 * live: refetches whenever a close path journals a new record (trash expiry,
 * kill, gracefulKill) via the `agent-session:recorded` push. Shared by every
 * resume surface — the resume launcher palette, the empty-grid card, and the
 * panel palette — so a session that leaves the trash appears in all of them
 * right away instead of waiting for the next open/remount.
 *
 * `enabled` gates both the fetch and the subscription so transient surfaces
 * (palettes) don't re-read the journal or hold listeners while closed.
 */
export function useAgentSessionRecords(enabled: boolean) {
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Latest-wins guard: the initial fetch and event-driven refetches can
    // overlap, and an older response resolving late must not overwrite a newer
    // one (it could hide the just-recorded session the event announced).
    let latestFetch = 0;

    const fetchSessions = async (initial: boolean) => {
      const fetchId = ++latestFetch;
      if (initial) setIsLoading(true);
      try {
        const list = (await window.electron?.agentSessionHistory?.list()) ?? [];
        if (!cancelled && fetchId === latestFetch) setSessions(list);
      } catch {
        if (!cancelled && fetchId === latestFetch) setSessions([]);
      } finally {
        if (!cancelled && initial) {
          setIsLoading(false);
          setHasLoaded(true);
        }
      }
    };

    void fetchSessions(true);
    // Event-driven refresh is quiet (no isLoading flip) so an already-rendered
    // list gains the new row without a skeleton/empty flash.
    const unsubscribe = window.electron?.events?.on("agent-session:recorded", () => {
      void fetchSessions(false);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      // Disable mid-fetch must not strand isLoading — the cancelled flag stops
      // the finally block from ever resetting it.
      setIsLoading(false);
    };
  }, [enabled]);

  return { sessions, isLoading, hasLoaded };
}
