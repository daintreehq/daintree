import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { requestMcpConfirmation } from "@/store/mcpConfirmStore";
import type { ActionDispatchResult, ActionId } from "@shared/types/actions";
import type { McpConfirmationDecision } from "@shared/types/ipc/mcpServer";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { summarizeMcpArgs } from "@shared/utils/mcpArgsSummary";

const REJECTION_RESULT: ActionDispatchResult = {
  ok: false,
  error: {
    code: "USER_REJECTED",
    message: "User rejected the confirmation request.",
  },
};

const TIMEOUT_RESULT: ActionDispatchResult = {
  ok: false,
  error: {
    code: "CONFIRMATION_TIMEOUT",
    message: "Confirmation request timed out before the user responded.",
  },
};

/**
 * Sets up the renderer-side MCP bridge.
 *
 * Listens for requests from the main process MCP server and responds
 * with the action manifest or action dispatch results. For actions
 * declared `danger: "confirm"`, intercepts the dispatch to surface a
 * native confirmation modal — only forwards to `actionService.dispatch`
 * after explicit user approval. Rejection or timeout returns a structured
 * error to main without ever invoking the action.
 */
export function useMcpBridge(): void {
  useEffect(() => {
    if (!window.electron?.mcpBridge) return;

    let disposed = false;

    const cleanupManifest = window.electron.mcpBridge.onGetManifestRequest((requestId) => {
      try {
        const manifest = actionService.list();
        window.electron.mcpBridge.sendGetManifestResponse(requestId, manifest);
      } catch (err) {
        logError("[MCP Bridge] Failed to build manifest", err);
        window.electron.mcpBridge.sendGetManifestResponse(requestId, []);
      }
    });

    const cleanupDispatch = window.electron.mcpBridge.onDispatchActionRequest(
      async ({ requestId, actionId, args, confirmed }) => {
        let confirmationDecision: McpConfirmationDecision | undefined;
        try {
          let effectiveConfirmed = confirmed;

          if (effectiveConfirmed !== true) {
            const definition = actionService.get(actionId as ActionId);
            if (definition?.danger === "confirm") {
              const decision = await requestMcpConfirmation({
                requestId,
                actionId,
                actionTitle: definition.title,
                actionDescription: definition.description,
                argsSummary: summarizeMcpArgs(args),
              });
              if (disposed) return;
              if (decision === "rejected") {
                window.electron.mcpBridge.sendDispatchActionResponse({
                  requestId,
                  result: REJECTION_RESULT,
                  confirmationDecision: "rejected",
                });
                return;
              }
              if (decision === "timeout") {
                window.electron.mcpBridge.sendDispatchActionResponse({
                  requestId,
                  result: TIMEOUT_RESULT,
                  confirmationDecision: "timeout",
                });
                return;
              }
              confirmationDecision = "approved";
              effectiveConfirmed = true;
            }
          }

          const result = await actionService.dispatch(actionId as ActionId, args, {
            source: "agent",
            confirmed: effectiveConfirmed,
          });
          if (disposed) return;
          window.electron.mcpBridge.sendDispatchActionResponse({
            requestId,
            result,
            confirmationDecision,
          });
        } catch (err) {
          if (disposed) return;
          window.electron.mcpBridge.sendDispatchActionResponse({
            requestId,
            result: {
              ok: false,
              error: {
                code: "EXECUTION_ERROR",
                message: formatErrorMessage(err, "Action dispatch failed"),
              },
            },
            confirmationDecision,
          });
        }
      }
    );

    return () => {
      disposed = true;
      cleanupManifest();
      cleanupDispatch();
    };
  }, []);
}
