import type { RemoteRouter } from "../../ipc/endpoint.js";
import { setFocusedPanelHostRelay } from "../../ipc/handlers/pluginFocusedPanel.js";

/**
 * Shell side: a remote-bound view's focused panel belongs to its host's
 * plugins, so its report goes there, with the native focus only this machine
 * can observe.
 */
export function installFocusedPanelHostRelay(
  router: Pick<RemoteRouter, "hostForSender" | "forwardSend">
): () => void {
  return setFocusedPanelHostRelay((senderWebContentsId, channel, args) => {
    const hostId = router.hostForSender(senderWebContentsId);
    if (hostId === null) return false;
    router.forwardSend(hostId, senderWebContentsId, channel, args);
    return true;
  });
}
