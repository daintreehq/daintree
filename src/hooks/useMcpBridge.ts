import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { requestMcpConfirmation, useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { runWithMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import {
  buildWorktreeDeletePreview,
  formatWorktreeDeletePreviewLines,
} from "@/components/Worktree/worktreeDeletePreview";
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
 * The worktree id a `worktree.delete` dispatch targets, or undefined when the
 * action isn't a worktree delete or carries no usable id. Determines whether a
 * fresh changed-file preview should be fetched for the confirm modal (#11343).
 */
function worktreeDeleteTargetId(actionId: string, args: unknown): string | undefined {
  if (actionId !== "worktree.delete") return undefined;
  const worktreeId =
    args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>).worktreeId
      : undefined;
  return typeof worktreeId === "string" && worktreeId.length > 0 ? worktreeId : undefined;
}

/**
 * Build a fresh changed-file preview for confirm surfaces that discard content
 * (#11343). Today only `worktree.delete` qualifies: its raw args ({worktreeId,
 * force}) tell the approver nothing about what a force-delete would destroy, so
 * we fetch live git status and surface the actual file list. Fails closed — a
 * fetch error yields the "couldn't verify" note rather than an empty preview
 * that would imply a clean tree. Returns `undefined` for actions with no
 * preview so the dialog just shows args as before.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export async function buildMcpConfirmPreview(
  actionId: string,
  args: unknown
): Promise<string[] | undefined> {
  const worktreeId = worktreeDeleteTargetId(actionId, args);
  if (worktreeId === undefined) return undefined;
  try {
    const preview = await buildWorktreeDeletePreview(worktreeId);
    // Monitor gone / already removed → nothing meaningful to preview.
    if (!preview) return undefined;
    return formatWorktreeDeletePreviewLines(preview);
  } catch {
    // Fetch failed → fail closed: surface that we couldn't verify rather than
    // an empty preview that would imply a clean tree.
    return formatWorktreeDeletePreviewLines(null);
  }
}

/**
 * Stamp `spawnedBy: "mcp"` and `focusPolicy: "preserve"` onto actions that
 * can create panels. `spawnedBy` records provenance (MCP bridge is the
 * dispatch source); `focusPolicy` declares the caller's intent to keep focus
 * where it is (#6959). We override any caller-supplied values because the
 * dispatch source is authoritative — an MCP client cannot claim a different
 * origin or focus policy.
 *
 * Exported for unit tests; importing modules should not call this directly —
 * the bridge is the only authoritative caller.
 */
export function tagMcpSpawnSource(actionId: string, args: unknown): unknown {
  if (!shouldTagMcpSpawn(actionId)) return args;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return { ...(args as Record<string, unknown>), spawnedBy: "mcp", focusPolicy: "preserve" };
  }
  if (args === undefined || args === null) {
    return { spawnedBy: "mcp", focusPolicy: "preserve" };
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
      async ({ requestId, actionId, args, confirmed, context, callerInfo }) => {
        let confirmationDecision: McpConfirmationDecision | undefined;
        try {
          let effectiveConfirmed = confirmed;

          if (effectiveConfirmed !== true) {
            const definition = actionService.getDispatchMeta(actionId as ActionId);
            if (definition?.danger === "confirm") {
              inFlightConfirms.add(requestId);
              // Fetch the fresh changed-file preview OFF the critical path so
              // the modal appears immediately (never blocked on a git status)
              // and the confirm queue isn't reordered by fetch latency (#11343).
              // While it's in flight the modal keeps approval disabled
              // (previewPending) so the approver can't confirm a destructive
              // dispatch before seeing what it affects. `setPreview` patches the
              // item and re-enables approval when the fetch lands (empty lines
              // when there's nothing to show); a no-op if already resolved.
              const previewPending = worktreeDeleteTargetId(actionId, args) !== undefined;
              if (previewPending) {
                void buildMcpConfirmPreview(actionId, args).then((preview) => {
                  if (disposed) return;
                  useMcpConfirmStore.getState().setPreview(requestId, preview ?? []);
                });
              }
              let decision: McpConfirmationDecision;
              try {
                decision = await requestMcpConfirmation({
                  requestId,
                  actionId,
                  actionTitle: definition.title,
                  actionDescription: definition.description,
                  // Carry the "why this is gated" rationale into the host
                  // confirm dialog so the human sees the same justification the
                  // model does — parity with the removed elicitation prompt,
                  // which used to be the only surface that showed it (#11342).
                  ...(definition.dangerRationale
                    ? { dangerRationale: definition.dangerRationale }
                    : {}),
                  argsSummary: summarizeMcpArgs(args),
                  danger: definition.danger,
                  // Display-only requesting-bearer identity (#9157). Present
                  // only for unpinned external dispatch; the dialog renders a
                  // "Requested by" row when set, stays provenance-free when not.
                  callerInfo,
                  previewPending,
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
          const result = await runWithMcpSpawnFocusSuppressed(
            () =>
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
              }),
            actionId
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
