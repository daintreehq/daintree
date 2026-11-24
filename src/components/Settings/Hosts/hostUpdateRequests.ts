import type { HostId } from "@shared/types/remoteHosts";

/** Why the flow opens, which names it: "Update …", or "Set up …" for a host Daintree isn't running on. */
export type HostUpdateIntent = "update" | "setup";

export interface HostUpdateRequest {
  hostId: HostId;
  intent: HostUpdateIntent;
}

type Listener = (hostId: HostId, intent: HostUpdateIntent) => void;

const listeners = new Set<Listener>();
let pending: HostUpdateRequest | null = null;

/**
 * Ask Settings → Hosts to open one host's update flow. Answered at once when
 * the tab is showing; otherwise held until it mounts, since the request is
 * what opens it.
 */
export function requestHostUpdate(hostId: HostId, intent: HostUpdateIntent = "update"): void {
  if (listeners.size === 0) {
    pending = { hostId, intent };
    return;
  }
  pending = null;
  for (const listener of [...listeners]) listener(hostId, intent);
}

/** The request made before the tab was showing, if any; taking it clears it. */
export function takePendingHostUpdateRequest(): HostUpdateRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** The host of the request made before the tab was showing, if any; taking it clears it. */
export function takePendingHostUpdate(): HostId | null {
  return takePendingHostUpdateRequest()?.hostId ?? null;
}

export function onHostUpdateRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
