import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";

/**
 * Sets up the renderer-side MCP bridge.
 *
 * Listens for requests from the main process MCP server and responds
 * with the action manifest or action dispatch results.
 */
export function useMcpBridge(): void {
  useEffect(() => {
    if (!window.electron?.mcpBridge) return;

    const cleanupManifest = window.electron.mcpBridge.onGetManifestRequest((requestId) => {
      try {
        const manifest = actionService.list();
        window.electron.mcpBridge.sendGetManifestResponse(requestId, manifest);
      } catch (err) {
        console.error("[MCP Bridge] Failed to build manifest:", err);
        window.electron.mcpBridge.sendGetManifestResponse(requestId, []);
      }
    });

    const cleanupDispatch = window.electron.mcpBridge.onDispatchActionRequest(
      async ({ requestId, actionId, args, confirmed }) => {
        try {
          const result = await actionService.dispatch(actionId as ActionId, args, {
            source: "agent",
            confirmed,
          });
          window.electron.mcpBridge.sendDispatchActionResponse({ requestId, result });
        } catch (err) {
          window.electron.mcpBridge.sendDispatchActionResponse({
            requestId,
            result: {
              ok: false,
              error: {
                code: "EXECUTION_ERROR",
                message: err instanceof Error ? err.message : String(err),
              },
            },
          });
        }
      }
    );

    return () => {
      cleanupManifest();
      cleanupDispatch();
    };
  }, []);
}
