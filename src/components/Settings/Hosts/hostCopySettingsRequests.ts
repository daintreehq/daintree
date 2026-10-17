import type { HostId } from "@shared/types/remoteHosts";

type Listener = (hostId: HostId) => void;

const listeners = new Set<Listener>();
let pending: HostId | null = null;
/** Hosts added here whose first connection hasn't happened yet. */
const awaitingFirstConnect = new Set<HostId>();

/**
 * A host was just added: offer the copy on its first connection, whether that
 * happens in the add flow or later from Settings.
 */
export function awaitFirstConnect(hostId: HostId): void {
  awaitingFirstConnect.add(hostId);
}

/** True once, for a host added here that has now connected. */
export function takeFirstConnect(hostId: HostId): boolean {
  return awaitingFirstConnect.delete(hostId);
}

/**
 * Offer to copy this machine's settings to a host, once: the add-host flow
 * asks right after a new host first connects. Answered at once when the Hosts
 * tab is showing; otherwise held until it mounts.
 */
export function requestHostCopySettings(hostId: HostId): void {
  if (listeners.size === 0) {
    pending = hostId;
    return;
  }
  pending = null;
  for (const listener of [...listeners]) listener(hostId);
}

/** The request made before the tab was showing, if any; taking it clears it. */
export function takePendingHostCopySettings(): HostId | null {
  const hostId = pending;
  pending = null;
  return hostId;
}

export function onHostCopySettingsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
