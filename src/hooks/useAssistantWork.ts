import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { unreadAssistantWork, type AssistantWorkReading } from "@shared/types/assistantWork";
import type { HostId } from "@shared/types/remoteHosts";
import { canopyHostClient } from "@/clients/canopyHostClient";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";
import { AGENT_DIRECTORY_POLL_MS } from "./useAgentDirectory";

type Readings = ReadonlyMap<HostId, AssistantWorkReading>;

const NO_READINGS: Readings = new Map();

/** Whether two readings say the same, apart from when each was read. */
function sameReading(a: AssistantWorkReading, b: AssistantWorkReading): boolean {
  return JSON.stringify({ ...a, observedAt: null }) === JSON.stringify({ ...b, observedAt: null });
}

/**
 * The held readings with one host's fresh one, and none of the hosts no longer
 * asked about. Unchanged, it is the held map itself, so nothing re-renders.
 */
function withReading(
  held: Readings,
  hostId: HostId,
  fresh: AssistantWorkReading,
  asked: ReadonlySet<HostId>
): Readings {
  const before = held.get(hostId);
  // Not an empty inventory: what was read before stays, said to be stale.
  const kept: AssistantWorkReading =
    fresh.coverage === "unreachable" && before && before.observedAt !== null
      ? { ...before, coverage: "stale", complete: false }
      : fresh;
  const same = before !== undefined && sameReading(before, kept);
  const dropped = [...held.keys()].some((id) => !asked.has(id));
  if (same && !dropped) return held;
  const next = new Map<HostId, AssistantWorkReading>();
  for (const [id, reading] of held) if (asked.has(id)) next.set(id, reading);
  if (!same) next.set(hostId, kept);
  return next;
}

/**
 * Which workers each host's assistants made or hold (#14166), read while
 * `active` and held between reads. `ownHostId` is read through this machine's
 * own handler, every other host through its link. Passive: nothing is
 * started, watched or read off a screen to answer it. Nothing is read while
 * the view can't be seen; it reads at once when it can again.
 *
 * Each host is read on its own cadence and shown as soon as it answers, so a
 * slow link holds back only its own host (#17794). A host has at most one
 * read out at a time: one still out when the view hides, or the hosts change,
 * is waited on rather than sent again.
 */
export function useAssistantWork(
  hostIds: readonly HostId[],
  ownHostId: HostId,
  active: boolean
): Readings {
  const [readings, setReadings] = useState(NO_READINGS);
  const outstanding = useRef(new Map<string, Promise<AssistantWorkReading>>());
  const key = hostIds.join("\u0000");
  const observable = useSyncExternalStore(
    subscribeProjectViewObservability,
    isProjectViewObservable
  );
  const reading = active && observable;
  useEffect(() => {
    if (!reading || key === "") return;
    const ids = key.split("\u0000");
    const asked: ReadonlySet<HostId> = new Set(ids);
    const out = outstanding.current;
    let live = true;
    const timers = new Map<HostId, ReturnType<typeof setTimeout>>();
    const readOne = (hostId: HostId): Promise<AssistantWorkReading> => {
      const own = hostId === ownHostId;
      const slot = `${own ? "own" : "link"}\u0000${hostId}`;
      const pending = out.get(slot);
      if (pending) return pending;
      const sent = (async () => {
        try {
          return await (own
            ? window.electron.canopy.readAssistantWork()
            : canopyHostClient.readAssistantWork(hostId));
        } catch {
          return unreadAssistantWork("unreachable");
        }
      })();
      out.set(slot, sent);
      void sent.then(() => {
        if (out.get(slot) === sent) out.delete(slot);
      });
      return sent;
    };
    const read = (hostId: HostId) => {
      void readOne(hostId).then((fresh) => {
        if (!live) return;
        setReadings((held) => withReading(held, hostId, fresh, asked));
        timers.set(
          hostId,
          setTimeout(() => read(hostId), AGENT_DIRECTORY_POLL_MS)
        );
      });
    };
    for (const id of ids) read(id);
    return () => {
      live = false;
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [reading, key, ownHostId]);
  return active ? readings : NO_READINGS;
}
