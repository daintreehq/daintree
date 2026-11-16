import { useEffect, useState, useSyncExternalStore } from "react";
import { unreadAgentDirectory, type AgentDirectory } from "@shared/types/agentDirectory";
import { isProjectViewObservable, subscribeProjectViewObservability } from "@/lib/viewCacheState";

/** How often an open surface reads the directory again; it is passive and cheap. */
export const AGENT_DIRECTORY_POLL_MS = 3_000;

/**
 * Whether a read says nothing the held one didn't, apart from when it was
 * read. A waiting confirmation is held against each read's own time, so while
 * any waits the newer read is always taken.
 */
function saysNothingNew(held: AgentDirectory | null, next: AgentDirectory): boolean {
  if (held === null) return false;
  const waits = next.entries.some(
    (entry) => entry.state === "live" && (entry.confirmations?.waiting.length ?? 0) > 0
  );
  if (waits) return false;
  return (
    JSON.stringify({ ...held, observedAt: null }) === JSON.stringify({ ...next, observedAt: null })
  );
}

/**
 * This machine's agent directory, read while `active` and held between reads.
 * Reading it lists runs and nothing more: no session is started, resumed or
 * watched, and no screen is read. Null until the first read answers. Nothing
 * is read while the view can't be seen; it reads at once when it can again.
 */
export function useAgentDirectory(active: boolean): AgentDirectory | null {
  const [directory, setDirectory] = useState<AgentDirectory | null>(null);
  const observable = useSyncExternalStore(
    subscribeProjectViewObservability,
    isProjectViewObservable
  );
  const reading = active && observable;
  useEffect(() => {
    if (!reading) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      window.electron.canopy.readAgentDirectory().then(
        (next) => {
          if (!live) return;
          setDirectory((held) => (saysNothingNew(held, next) ? held : next));
          timer = setTimeout(read, AGENT_DIRECTORY_POLL_MS);
        },
        () => {
          if (!live) return;
          // Not an empty inventory: what was read before stays, said to be stale.
          setDirectory((held) =>
            held
              ? held.coverage === "stale" && !held.complete
                ? held
                : { ...held, coverage: "stale", complete: false }
              : unreadAgentDirectory("unreachable")
          );
          timer = setTimeout(read, AGENT_DIRECTORY_POLL_MS);
        }
      );
    };
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [reading]);
  return directory;
}
