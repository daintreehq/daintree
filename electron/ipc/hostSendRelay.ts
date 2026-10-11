/**
 * Shell-side seam for fire-and-forget channels whose local handler decides
 * what a view bound to a remote host tells that host (hybrid sends). The
 * Remote Hosts boot installs the relay; core handlers stay free of remote
 * imports and fall back to local handling while it is absent.
 */
export type HostSendRelay = (
  senderWebContentsId: number,
  channel: string,
  args: unknown[]
) => boolean;

let relay: HostSendRelay | null = null;
const reopenListeners = new Set<(webContentsId: number) => void>();

export function setHostSendRelay(next: HostSendRelay | null): () => void {
  relay = next;
  return () => {
    if (relay === next) relay = null;
  };
}

/** Forward to the sender's host. False when the sender is not bound to one. */
export function relaySendToHost(
  senderWebContentsId: number,
  channel: string,
  args: unknown[]
): boolean {
  return relay?.(senderWebContentsId, channel, args) ?? false;
}

/**
 * Called whenever a remote-bound view gets an endpoint on its host, fresh or
 * resumed. A send relayed while the link was down was dropped, and a fresh
 * endpoint starts with none of the view's standing state, so a handler that
 * relays state (a subscription, the focused panel) re-sends it here.
 */
export function onRemoteViewEndpointOpened(listener: (webContentsId: number) => void): () => void {
  reopenListeners.add(listener);
  return () => {
    reopenListeners.delete(listener);
  };
}

export function notifyRemoteViewEndpointOpened(webContentsId: number): void {
  for (const listener of [...reopenListeners]) {
    try {
      listener(webContentsId);
    } catch (error) {
      console.warn("[HostSendRelay] endpoint-opened replay failed:", error);
    }
  }
}
