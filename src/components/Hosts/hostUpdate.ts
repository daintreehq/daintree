import type { HostId, HostListEntry } from "@shared/types/remoteHosts";
import { requestHostUpdate } from "@/components/Settings/Hosts/hostUpdateRequests";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { openHostsSettingsTab } from "@/components/Settings/Hosts/hostSettingsRequests";
import { updateActionLabel, updateTargetFor } from "./hostModel";

/** An update a host's build mismatch asks for: of that host, or of this machine. */
export interface HostUpdateOffer {
  hostId: HostId;
  target: "host" | "local";
  label: string;
}

/**
 * What a host whose build was refused offers, named for it; null while it
 * connects, or nothing has been heard from it. Read from the host list, so
 * a host whose switch was refused for its build still offers its update.
 */
export function hostUpdateOffer(entry: HostListEntry): HostUpdateOffer | null {
  const connection = entry.connection;
  // Only a refused build asks for an update here; a build that differs but
  // connected anyway is noted in the host's details, not pushed as a remedy.
  const mismatch = connection.status === "version-mismatch" ? connection.mismatch : null;
  if (!mismatch) return null;
  return {
    hostId: entry.descriptor.id,
    target: updateTargetFor(mismatch),
    label: updateActionLabel(mismatch, entry.descriptor.name),
  };
}

export function runHostUpdate(target: "host" | "local", hostId: HostId): void {
  if (target === "host") {
    // Updating a host is part of managing it, which lives in Settings → Hosts;
    // the request opens that host's own update flow there.
    requestHostUpdate(hostId);
    openHostsSettingsTab();
    return;
  }
  safeFireAndForget(window.electron.update.checkForUpdates(), {
    context: "Checking for an update after a host build mismatch",
  });
}
