import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { requestMcpConfirmation, useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { runWithMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
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

const MCP_SPAWN_TAGGED_ACTIONS = new Set([
  "recipe.run",
  "terminal.duplicate",
  "terminal.new",
  "workflow.startWorkOnIssue",
  "worktree.createWithRecipe",
  "worktree.resource.connect",
]);

function shouldTagMcpSpawn(actionId: string): boolean {
  return actionId.startsWith("agent.") || MCP_SPAWN_TAGGED_ACTIONS.has(actionId);
}

/**
 * Stamp `spawnedBy: "mcp"` onto actions that can create panels so the panel
 * store can gate focus capture for MCP-initiated launches (#6959). We override
 * any caller-supplied `spawnedBy` because the dispatch source is authoritative
 * — an MCP client cannot claim a different origin.
 *
 * Exported for unit tests; importing modules should not call this directly —
 * the bridge is the only authoritative caller.
 */
export function tagMcpSpawnSource(actionId: string, args: unknown): unknown {
  if (!shouldTagMcpSpawn(actionId)) return args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return { ...(args as Record<string, unknown>), spawnedBy: "mcp" };
  }
  if (args === undefined || args === null) {
    return { spawnedBy: "mcp" };
  }
  return args;
}

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
    const inFlightConfirms = new Set<string>();

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
      async ({ requestId, actionId, args, confirmed, context }) => {
        let confirmationDecision: McpConfirmationDecision | undefined;
        try {
          let effectiveConfirmed = confirmed;

          if (effectiveConfirmed !== true) {
            const definition = actionService.get(actionId as ActionId);
            if (definition?.danger === "confirm") {
              inFlightConfirms.add(requestId);
              let decision: McpConfirmationDecision;
              try {
                decision = await requestMcpConfirmation({
                  requestId,
                  actionId,
                  actionTitle: definition.title,
                  actionDescription: definition.description,
                  argsSummary: summarizeMcpArgs(args),
                  danger: definition.danger,
                });
              } finally {
                inFlightConfirms.delete(requestId);
              }
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

          const dispatchArgs = tagMcpSpawnSource(actionId, args);
          const result = await runWithMcpSpawnFocusSuppressed(() =>
            actionService.dispatch(actionId as ActionId, dispatchArgs, {
              source: "agent",
              confirmed: effectiveConfirmed,
              // Pinned help-session dispatch carries the provision-time
              // context snapshot; replay it so the action targets the
              // worktree/terminal focused at launch, not wherever focus
              // drifted during the model's turn (#8317). Undefined for
              // unpinned external dispatch — ActionService then falls
              // back to live renderer context, unchanged behaviour.
              contextOverride: context,
            })
          );
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
      // Drop any modals queued by this bridge so the singleton store doesn't
      // surface dialogs that no listener is left to respond to. Main's 30s
      // dispatch timer still rejects with a generic error — acceptable since
      // unmount only happens at app teardown or HMR.
      const dropFromStore = useMcpConfirmStore.getState().drop;
      for (const requestId of inFlightConfirms) {
        dropFromStore(requestId);
      }
      inFlightConfirms.clear();
      cleanupManifest();
      cleanupDispatch();
    };
  }, []);
}
