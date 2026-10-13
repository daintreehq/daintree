import { useEffect } from "react";
import type { HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";
import { remoteHostsClient } from "@/clients/remoteHostsClient";

/** Under the Shell's idle release window, so an open overview never sees its hosts closed. */
export const OVERVIEW_TOUCH_MS = 60_000;

/**
 * Whether the overview should hold a link to this host. Not one that gave up
 * waiting for the user (ssh couldn't log in, Host mode is off) or runs
 * another build: opening the overview isn't asking to try those again.
 */
export function overviewWantsConnection(connection: HostConnectionState): boolean {
  switch (connection.status) {
    case "local":
    case "version-mismatch":
      return false;
    case "unreachable":
      return connection.stoppedRetrying !== true && connection.hostModeOff !== true;
    default:
      return true;
  }
}

/**
 * Nothing dials a host on its own: the overview connects the hosts it shows
 * while it is open, and keeps telling the Shell they're in use so its idle
 * release leaves them up. Once it closes they're released like anything else.
 */
export function useOverviewConnections(hosts: readonly HostListEntry[]): void {
  const wanted = hosts
    .filter((entry) => overviewWantsConnection(entry.connection))
    .map((entry) => entry.descriptor.id)
    .sort()
    .join("\n");
  useEffect(() => {
    if (wanted.length === 0) return undefined;
    const hostIds = wanted.split("\n");
    const touch = () => {
      for (const hostId of hostIds) {
        Promise.resolve()
          .then(() => remoteHostsClient.connect(hostId))
          .catch(() => {
            // Its card shows what the connection saw; nothing to add here.
          });
      }
    };
    touch();
    const timer = setInterval(touch, OVERVIEW_TOUCH_MS);
    return () => clearInterval(timer);
  }, [wanted]);
}
