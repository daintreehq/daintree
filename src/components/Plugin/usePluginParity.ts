import { useCallback, useEffect, useState } from "react";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { PluginParityRow } from "@shared/types/ipc/pluginParity";
import type { HostId } from "@shared/types/remoteHosts";

export type PluginParityState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; hostId: HostId; rows: PluginParityRow[] }
  | { status: "error"; message: string };

/**
 * This machine's plugins against `hostId`'s, read while `enabled` (the host is
 * connected). Only reads: installing or updating is a separate, explicit call.
 */
export function usePluginParity(
  hostId: HostId | null,
  enabled: boolean
): { state: PluginParityState; refresh: () => void } {
  const [state, setState] = useState<PluginParityState>({ status: "idle" });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (hostId === null || !enabled) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    // Rows for another host are never shown, let alone acted on, for this one.
    setState((prev) =>
      prev.status === "ready" && prev.hostId === hostId ? prev : { status: "loading" }
    );
    window.electron.pluginParity.diff({ hostId }).then(
      (rows) => {
        if (!cancelled) setState({ status: "ready", hostId, rows });
      },
      (err: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: formatErrorMessage(err, "Couldn't compare plugins"),
          });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [hostId, enabled, generation]);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  const current: PluginParityState =
    state.status === "ready" && state.hostId !== hostId ? { status: "loading" } : state;
  return { state: current, refresh };
}
