import { useEffect } from "react";
import { requestPluginCapabilityConsent } from "@/store/pluginCapabilityConfirmStore";

/**
 * Wires main-process just-in-time capability consent prompts into the renderer
 * dialog queue (#10524). Subscribes to the `plugin-capability:consent-request`
 * push (sent to the focused window by main), enqueues each prompt through the
 * FIFO consent store, and replies with the user's decision via
 * `plugin-capability:resolve-consent`.
 *
 * Mounted once near the app root alongside the consent dialog. The store's
 * resolver map serialises concurrent prompts, so this hook only forwards.
 */
export function usePluginCapabilityConsentBridge(): void {
  useEffect(() => {
    return window.electron.events.on("plugin-capability:consent-request", (payload) => {
      void requestPluginCapabilityConsent(payload).then((decision) =>
        window.electron.pluginCapability.resolveConsent({
          requestId: payload.requestId,
          decision,
        })
      );
    });
  }, []);
}
