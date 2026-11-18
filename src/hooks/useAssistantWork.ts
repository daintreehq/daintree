import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

/** The readings of the asked hosts only; all of them asked, the map itself. */
function onlyAsked(readings: Readings, key: string): Readings {
  const asked = new Set(key.split("\u0000"));
  if ([...readings.keys()].every((id) => asked.has(id))) return readings;
  return new Map([...readings].filter(([id]) => asked.has(id)));
}

/**
 * Which workers each host's assistants made or hold (#14166), read while
 * `active` and held between reads. `ownHostId` is read through this machine's
 * own handler, every other host through its link. Passive: nothing is
 * started, watched or read off a screen to answer it. Nothing is read while
 * the view can't be seen; it reads again when it can, at once if its next
 * read is already due.
 *
 * Each host is read on its own cadence and shown as soon as it answers, so a
 * slow link holds back only its own host (#17794). A host has at most one
 * read out at a time, and keeps its cadence when the view hides or the hosts
 * change: a read still out is waited on rather than sent again, and one not
 * yet due waits for its time.
 */
export function useAssistantWork(
  hostIds: readonly HostId[],
  ownHostId: HostId,
  active: boolean
): Readings {
  const [readings, setReadings] = useState(NO_READINGS);
  const outstanding = useRef(new Map<HostId, Promise<AssistantWorkReading>>());
  const shownAt = useRef(new Map<HostId, number>());
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
    const shown = shownAt.current;
    let live = true;
    const timers = new Map<HostId, ReturnType<typeof setTimeout>>();
    const readOne = (hostId: HostId): Promise<AssistantWorkReading> => {
      const pending = out.get(hostId);
      if (pending) return pending;
      const sent = (async () => {
        try {
          return await (hostId === ownHostId
            ? window.electron.canopy.readAssistantWork()
            : canopyHostClient.readAssistantWork(hostId));
        } catch {
          return unreadAssistantWork("unreachable");
        }
      })();
      out.set(hostId, sent);
      void sent.then(() => {
        if (out.get(hostId) === sent) out.delete(hostId);
      });
      return sent;
    };
    const read = (hostId: HostId) => {
      void readOne(hostId).then((fresh) => {
        if (!live) return;
        setReadings((held) => withReading(held, hostId, fresh, asked));
        shown.set(hostId, performance.now());
        timers.set(
          hostId,
          setTimeout(() => read(hostId), AGENT_DIRECTORY_POLL_MS)
        );
      });
    };
    for (const id of ids) {
      const last = shown.get(id);
      // A read still out was sent when due, so it is joined at once.
      const wait = last === undefined ? 0 : last + AGENT_DIRECTORY_POLL_MS - performance.now();
      if (wait > 0) {
        timers.set(
          id,
          setTimeout(() => read(id), wait)
        );
      } else {
        read(id);
      }
    }
    return () => {
      live = false;
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [reading, key, ownHostId]);
  // A host taken out of the list leaves at once, not when the next host answers.
  const shown = useMemo(() => onlyAsked(readings, key), [readings, key]);
  return active ? shown : NO_READINGS;
}
