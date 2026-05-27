import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Sets up the renderer-side bridge for plugin `host.dispatch` (#9280).
 *
 * Listens for dispatch requests forwarded from the main-process PluginService
 * and executes them via `actionService.dispatch` as the `"plugin"` source,
 * threading the originating `pluginId` through for the `action:dispatched`
 * audit (#9232). Always replies with the dispatch result — never throws back
 * across the boundary — so the plugin's awaited promise always settles with a
 * typed {@link import("@shared/types/actions").ActionDispatchResult} envelope.
 *
 * Unlike {@link import("./useMcpBridge").useMcpBridge} there is no confirmation
 * modal: plugins are first-party (curated-only), so `danger: "confirm"` actions
 * resolve to `CONFIRMATION_REQUIRED` from ActionService and `danger:"restricted"`
 * to `RESTRICTED`. The plugin caller decides what to do with that result.
 */
export function usePluginDispatchBridge(): void {
  useEffect(() => {
    if (!window.electron?.pluginDispatchBridge) return;

    let disposed = false;

    const cleanup = window.electron.pluginDispatchBridge.onDispatchActionRequest(
      async ({ requestId, pluginId, actionId, args }) => {
        try {
          const result = await actionService.dispatch(actionId as ActionId, args, {
            source: "plugin",
            pluginId,
          });
          if (disposed) return;
          window.electron.pluginDispatchBridge.sendDispatchActionResponse({ requestId, result });
        } catch (err) {
          if (disposed) return;
          window.electron.pluginDispatchBridge.sendDispatchActionResponse({
            requestId,
            result: {
              ok: false,
              error: {
                code: "EXECUTION_ERROR",
                message: formatErrorMessage(err, "Plugin action dispatch failed"),
              },
            },
          });
        }
      }
    );

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);
}
