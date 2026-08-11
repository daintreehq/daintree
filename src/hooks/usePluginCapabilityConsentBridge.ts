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
    // Every prompt this mount has handed to the store, kept for the mount's
    // lifetime rather than cleared on settle. Main re-pushes an unacknowledged
    // prompt, and a re-push already on the wire can arrive *after* the user has
    // answered — by which point both this Set and the store's resolver map
    // would have forgotten the id, so it would enqueue a fresh dialog for a
    // request main has already settled. The consent dialog refuses to act twice
    // on one requestId, so that phantom would sit there unanswerable until its
    // own five-minute timer. Consent prompts are first-use-per-capability, so
    // retaining ids costs nothing worth reclaiming.
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
