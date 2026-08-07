import { useEffect } from "react";
import { requestPluginCapabilityConsent } from "@/store/pluginCapabilityConfirmStore";

/**
 * Wires main-process just-in-time capability consent prompts into the renderer
 * dialog queue (#10524). Subscribes to the `plugin-capability:consent-request`
 * push, enqueues each prompt through the FIFO consent store, and replies with
 * the user's decision via `plugin-capability:resolve-consent`.
 *
 * Also acknowledges receipt the moment a prompt is enqueued (#11708). Main
 * cannot otherwise tell that the push arrived — sending to a renderer with no
 * listener is a silent no-op — so without this it re-pushes until it gives up
 * and reports the capability as undeliverable. The acknowledgement is what
 * starts the user's five-minute decision window.
 *
 * Mounted once near the app root alongside the consent dialog. The store's
 * resolver map serialises concurrent prompts, so this hook only forwards.
 */
export function usePluginCapabilityConsentBridge(): void {
  useEffect(() => {
    // Prompts already handed to the store. Main re-pushes an unacknowledged
    // prompt, so a re-push can race the acknowledgement it crossed on the wire;
    // re-enqueueing it would hit the store's duplicate guard, which resolves
    // "rejected" and would surface as a denial the user never made. Re-ack
    // instead — the request is in the queue, which is all main is asking about.
    const enqueued = new Set<string>();

    return window.electron.events.on("plugin-capability:consent-request", (payload) => {
      const { requestId } = payload;
      // Both replies are fire-and-forget, but their rejections still have to be
      // consumed — during renderer teardown the IPC call can reject, and an
      // unhandled rejection there would surface as a renderer error unrelated to
      // anything the user did.
      const acknowledge = () => {
        window.electron.pluginCapability
          .acknowledgeConsent({ requestId })
          .catch((err: unknown) =>
            console.warn(`[plugin-capability] failed to acknowledge ${requestId}:`, err)
          );
      };

      if (enqueued.has(requestId)) {
        acknowledge();
        return;
      }
      enqueued.add(requestId);

      // Enqueue before acknowledging: the acknowledgement asserts the prompt is
      // queued for display, and requestPluginCapabilityConsent's executor runs
      // synchronously, so it genuinely is by the time we send.
      const decided = requestPluginCapabilityConsent(payload);
      acknowledge();

      void decided.then((decision) => {
        enqueued.delete(requestId);
        return window.electron.pluginCapability
          .resolveConsent({ requestId, decision })
          .catch((err: unknown) =>
            // Main keeps waiting and will eventually report a timeout. Nothing
            // useful to retry against a renderer that is going away, but the
            // divergence between "user decided" and "main heard" is worth a log.
            console.warn(`[plugin-capability] failed to deliver decision for ${requestId}:`, err)
          );
      });
    });
  }, []);
}
