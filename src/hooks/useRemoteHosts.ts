import { useCallback, useEffect } from "react";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";

/**
 * This machine's host list, live: loads on mount and follows the host list,
 * connection, install and summary events for as long as the caller is mounted.
 */
export function useRemoteHosts() {
  const hosts = useRemoteHostsStore((s) => s.hosts);
  const loaded = useRemoteHostsStore((s) => s.loaded);
  const loadError = useRemoteHostsStore((s) => s.loadError);

  const refresh = useCallback(
    () => useRemoteHostsStore.getState().loadHosts(() => remoteHostsClient.list()),
    []
  );

  useEffect(() => {
    const off = remoteHostsClient.onEvent((event) =>
      useRemoteHostsStore.getState().applyEvent(event)
    );
    // What each host reports (its agent CLIs, its forges) arrives on host metrics,
    // not on the host list: without it a host's details waited for a report forever.
    const offMetrics = window.electron?.hostMetrics?.onEvent((event) => {
      if (event.type === "summary") useRemoteHostsStore.getState().applySummary(event.summary);
    });
    void refresh();
    return () => {
      off();
      offMetrics?.();
    };
  }, [refresh]);

  return { hosts, loaded, loadError, refresh };
}
