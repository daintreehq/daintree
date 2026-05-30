import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import type { ActionId } from "@shared/types/actions";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/**
 * Sets up the renderer-side plugin dispatch bridge.
 *
 * Listens for plugin-sourced action dispatch requests from the main process (a
 * plugin calling `host.dispatch()`), routes them through `actionService.dispatch`
 * with `source: "plugin"`, and returns the structured result. Unlike the MCP
 * bridge there is no confirmation intercept: plugins cannot bypass confirm-gating,
 * so `danger:"confirm"` actions return `CONFIRMATION_REQUIRED` and
 * `danger:"restricted"` returns `RESTRICTED` directly from ActionService.
 *
 * The success response send sits inside the try block so a non-serializable
 * action result (a DataCloneError on `ipcRenderer.send`) is caught and replaced
 * with a serializable `EXECUTION_ERROR` envelope rather than stranding the
 * main-side pending request until its timeout.
 */
export function usePluginBridge(): void {
  useEffect(() => {
    if (!window.electron?.pluginBridge) return;

    let disposed = false;

    const cleanup = window.electron.pluginBridge.onDispatchActionRequest(
      async ({ requestId, actionId, args }) => {
        try {
          const result = await actionService.dispatch(actionId as ActionId, args, {
            source: "plugin",
          });
          if (disposed) return;
          window.electron.pluginBridge.sendDispatchActionResponse({ requestId, result });
        } catch (err) {
          if (disposed) return;
          window.electron.pluginBridge.sendDispatchActionResponse({
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
