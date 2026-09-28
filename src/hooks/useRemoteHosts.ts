import { useCallback, useEffect } from "react";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * This machine's host list, live: loads on mount and follows the host list,
 * connection and install events for as long as the caller is mounted.
 */
export function useRemoteHosts() {
  const hosts = useRemoteHostsStore((s) => s.hosts);
  const loaded = useRemoteHostsStore((s) => s.loaded);
  const loadError = useRemoteHostsStore((s) => s.loadError);

  const refresh = useCallback(async () => {
    try {
      useRemoteHostsStore.getState().setHosts(await remoteHostsClient.list());
    } catch (error) {
      useRemoteHostsStore
        .getState()
        .setLoadError(formatErrorMessage(error, "Couldn't load the host list"));
    }
  }, []);

  useEffect(() => {
    const off = remoteHostsClient.onEvent((event) =>
      useRemoteHostsStore.getState().applyEvent(event)
    );
    void refresh();
    return off;
  }, [refresh]);

  return { hosts, loaded, loadError, refresh };
}
