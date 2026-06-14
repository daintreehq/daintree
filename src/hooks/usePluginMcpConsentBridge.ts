import { useEffect } from "react";
import { requestPluginMcpConsent } from "@/store/pluginMcpConfirmStore";

/**
 * Wires main-process plugin-MCP consent prompts into the renderer dialog queue.
 * Subscribes to the `plugin-mcp:consent-request` push (targeted at this
 * WebContents by main), enqueues each prompt through the FIFO consent store,
 * and replies with the user's decision via `plugin-mcp:resolve-consent`.
 *
 * Mounted once near the app root alongside the consent dialog. The store's
 * resolver map serialises concurrent prompts, so this hook only forwards.
 */
export function usePluginMcpConsentBridge(): void {
  useEffect(() => {
    return window.electron.events.on("plugin-mcp:consent-request", (payload) => {
      void requestPluginMcpConsent(payload).then((decision) =>
        window.electron.pluginMcp.resolveConsent({ requestId: payload.requestId, decision })
      );
    });
  }, []);
}
