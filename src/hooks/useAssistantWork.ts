import { useEffect, useState } from "react";
import { unreadAssistantWork, type AssistantWorkReading } from "@shared/types/assistantWork";
import type { HostId } from "@shared/types/remoteHosts";
import { canopyHostClient } from "@/clients/canopyHostClient";
import { AGENT_DIRECTORY_POLL_MS } from "./useAgentDirectory";

const NO_READINGS: ReadonlyMap<HostId, AssistantWorkReading> = new Map();

/**
 * Which workers each host's assistants made or hold (#14166), read while
 * `active` and held between reads. `ownHostId` is read through this machine's
 * own handler, every other host through its link. Passive: nothing is
 * started, watched or read off a screen to answer it.
 */
export function useAssistantWork(
  hostIds: readonly HostId[],
  ownHostId: HostId,
  active: boolean
): ReadonlyMap<HostId, AssistantWorkReading> {
  const [readings, setReadings] = useState(NO_READINGS);
  const key = hostIds.join("\u0000");
  useEffect(() => {
    if (!active || key === "") return;
    const ids = key.split("\u0000");
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readOne = async (hostId: HostId): Promise<AssistantWorkReading> => {
      try {
        return await (hostId === ownHostId
          ? window.electron.canopy.readAssistantWork()
          : canopyHostClient.readAssistantWork(hostId));
      } catch {
        return unreadAssistantWork("unreachable");
      }
    };
    const read = () => {
      void Promise.all(ids.map(async (id) => [id, await readOne(id)] as const)).then((pairs) => {
        if (!live) return;
        setReadings((held) => {
          const next = new Map<HostId, AssistantWorkReading>();
          for (const [id, reading] of pairs) {
            const before = held.get(id);
            // Not an empty inventory: what was read before stays, said to be stale.
            next.set(
              id,
              reading.coverage === "unreachable" && before && before.observedAt !== null
                ? { ...before, coverage: "stale", complete: false }
                : reading
            );
          }
          return next;
        });
        timer = setTimeout(read, AGENT_DIRECTORY_POLL_MS);
      });
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, key, ownHostId]);
  return active ? readings : NO_READINGS;
}
