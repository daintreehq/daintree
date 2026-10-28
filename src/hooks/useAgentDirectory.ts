import { useEffect, useState } from "react";
import { unreadAgentDirectory, type AgentDirectory } from "@shared/types/agentDirectory";

/** How often an open surface reads the directory again; it is passive and cheap. */
export const AGENT_DIRECTORY_POLL_MS = 3_000;

/**
 * This machine's agent directory, read while `active` and held between reads.
 * Reading it lists runs and nothing more: no session is started, resumed or
 * watched, and no screen is read. Null until the first read answers.
 */
export function useAgentDirectory(active: boolean): AgentDirectory | null {
  const [directory, setDirectory] = useState<AgentDirectory | null>(null);
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      window.electron.canopy.readAgentDirectory().then(
        (next) => {
          if (!live) return;
          setDirectory(next);
          timer = setTimeout(read, AGENT_DIRECTORY_POLL_MS);
        },
        () => {
          if (!live) return;
          // Not an empty inventory: what was read before stays, said to be stale.
          setDirectory((held) =>
            held
              ? { ...held, coverage: "stale", complete: false }
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
  }, [active]);
  return directory;
}
