import type { HostId, HostListEntry } from "@shared/types/remoteHosts";
import { requestHostUpdate } from "@/components/Settings/Hosts/hostUpdateRequests";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { updateActionLabel, updateTargetFor } from "./hostModel";

/** An update a host's build mismatch asks for: of that host, or of this machine. */
export interface HostUpdateOffer {
  hostId: HostId;
  target: "host" | "local";
  label: string;
}

/**
 * What a host that runs a different build offers, named for it; null while its
 * build matches or nothing has been heard from it. Read from the host list, so
 * a host whose switch was refused for its build still offers its update.
 */
export function hostUpdateOffer(entry: HostListEntry): HostUpdateOffer | null {
  const connection = entry.connection;
  if (connection.status !== "version-mismatch") return null;
  return {
    hostId: entry.descriptor.id,
    target: updateTargetFor(connection.mismatch),
    label: updateActionLabel(connection.mismatch, entry.descriptor.name),
  };
}

export function runHostUpdate(target: "host" | "local", hostId: HostId): void {
  if (target === "host") {
    // Updating a host is part of managing it, which lives in Settings → Hosts;
    // the request opens that host's own update flow there. Loaded on use: the
    // action registry's own definitions reach this module.
    requestHostUpdate(hostId);
    safeFireAndForget(
      import("@/services/ActionService").then(({ actionService }) =>
        actionService.dispatch("host.add", undefined, { source: "user" })
      ),
      { context: "Opening a host's update flow" }
    );
    return;
  }
  safeFireAndForget(window.electron.update.checkForUpdates(), {
    context: "Checking for an update after a host build mismatch",
  });
}
