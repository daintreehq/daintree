import type { RemoteRouter } from "../../ipc/endpoint.js";
import { setHostSendRelay } from "../../ipc/hostSendRelay.js";

/**
 * Shell side: hybrid sends whose local handler relays a remote-bound view's
 * state to its host (the focused panel, plugin perf subscriptions) go through
 * this router.
 */
export function installHostSendRelay(
  router: Pick<RemoteRouter, "hostForSender" | "forwardSend">
): () => void {
  return setHostSendRelay((senderWebContentsId, channel, args) => {
    const hostId = router.hostForSender(senderWebContentsId);
    if (hostId === null) return false;
    router.forwardSend(hostId, senderWebContentsId, channel, args);
    return true;
  });
}
