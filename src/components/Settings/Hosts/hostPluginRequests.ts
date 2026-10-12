import type { HostId } from "@shared/types/remoteHosts";

type Listener = (hostId: HostId) => void;

const listeners = new Set<Listener>();
let pending: HostId | null = null;

/**
 * Ask Settings → Hosts to show one host's plugins. Answered at once when the
 * tab is showing; otherwise held until it mounts, since the request is what
 * opens it.
 */
export function requestHostPlugins(hostId: HostId): void {
  if (listeners.size === 0) {
    pending = hostId;
    return;
  }
  pending = null;
  for (const listener of [...listeners]) listener(hostId);
}

/** The request made before the tab was showing, if any; taking it clears it. */
export function takePendingHostPlugins(): HostId | null {
  const hostId = pending;
  pending = null;
  return hostId;
}

export function onHostPluginsRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
