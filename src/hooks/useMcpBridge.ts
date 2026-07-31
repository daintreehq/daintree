import { useEffect } from "react";
import { actionService } from "@/services/ActionService";
import { logError } from "@/utils/logger";
import { requestMcpConfirmation, useMcpConfirmStore } from "@/store/mcpConfirmStore";
import { runWithMcpSpawnFocusSuppressed } from "@/store/mcpSpawnFocusGuard";
import {
  buildWorktreeDeletePreview,
  formatWorktreeDeletePreviewLines,
} from "@/components/Worktree/worktreeDeletePreview";
import {
  buildGitRemoteOperationPreview,
  formatGitRemoteOperationPreviewLines,
} from "@/components/Git/gitRemoteOperationPreview";
import type { ActionContext, ActionDispatchResult, ActionId } from "@shared/types/actions";
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
 * What a confirm modal should preview, resolved once per dispatch. Raw args
 * ({worktreeId, force} / {cwd, setUpstream}) tell an approver nothing about
 * what the dispatch would actually affect, so each kind names a live fetch to
 * run instead. Actions with no meaningful preview resolve to `undefined` and
 * the modal just shows args as before.
 */
export type McpConfirmPreviewTarget =
  | { kind: "worktreeDelete"; worktreeId: string }
  | { kind: "gitPush"; cwd: string }
  | { kind: "gitPullRebase"; cwd: string };

/** Section heading rendered above each kind's preview lines. */
const PREVIEW_TITLES: Record<McpConfirmPreviewTarget["kind"], string> = {
  worktreeDelete: "Working tree changes",
  gitPush: "Branch and local commits",
  gitPullRebase: "Branch and local commits",
};

export function mcpConfirmPreviewTitle(target: McpConfirmPreviewTarget): string {
  return PREVIEW_TITLES[target.kind];
}

/**
 * The worktree id a `worktree.delete` targets, or undefined when it carries no
 * usable id (#11343).
 */
function worktreeIdArg(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || !("worktreeId" in args)) return undefined;
  // `in` narrows the property to `unknown` — no cast needed (and no
  // no-unsafe-type-assertion warning).
  const worktreeId = args.worktreeId;
  return typeof worktreeId === "string" && worktreeId.length > 0 ? worktreeId : undefined;
}

/**
 * How a git dispatch supplied its `cwd`, which is NOT the same question as
 * "what is the cwd".
 *
 * `"omitted"` means the caller deferred to context — the action itself falls
 * back to `ctx.activeWorktreePath`, so previewing and pinning that path is
 * faithful. `"invalid"` means the caller DID name a cwd but not a usable one
 * (`""`, `null`, a number). Those must never be silently replaced with the
 * active worktree: the dispatch would stop failing validation and start pushing
 * a repository the caller never asked for — precisely the #7880 no-silent-
 * fallback rule for destructive submissions.
 */
type GitCwdArg = { state: "omitted" } | { state: "invalid" } | { state: "supplied"; cwd: string };

function readGitCwdArg(args: unknown): GitCwdArg {
  if (args === null || typeof args !== "object" || !("cwd" in args)) return { state: "omitted" };
  const cwd = args.cwd;
  if (cwd === undefined) return { state: "omitted" };
  if (typeof cwd !== "string" || cwd.length === 0) return { state: "invalid" };
  return { state: "supplied", cwd };
}

/**
 * Resolve what this dispatch should preview, or `undefined` when it has no
 * preview. Called ONCE per dispatch: the result drives `previewPending`, the
 * fetch, the modal heading, and — for git — the cwd the approved dispatch is
 * pinned to, so all four can never disagree.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export function resolveMcpConfirmPreviewTarget(
  actionId: string,
  args: unknown,
  context: ActionContext | undefined
): McpConfirmPreviewTarget | undefined {
  if (actionId === "worktree.delete") {
    const worktreeId = worktreeIdArg(args);
    return worktreeId === undefined ? undefined : { kind: "worktreeDelete", worktreeId };
  }
  if (actionId === "git.push" || actionId === "git.pullRebase") {
    const cwdArg = readGitCwdArg(args);
    // A named-but-unusable cwd gets no preview and no pinning — it falls
    // through to schema/`run()` validation and fails, as it did before #11538.
    if (cwdArg.state === "invalid") return undefined;
    // Mirror the action's own `cwd ?? ctx.activeWorktreePath` resolution, and
    // mirror ActionService's WHOLE-OBJECT `contextOverride ?? live` precedence
    // (ActionService.ts:349). A per-field fallback would diverge: a pinned
    // context that carries no worktree path must NOT borrow the live one.
    const cwd =
      cwdArg.state === "supplied"
        ? cwdArg.cwd
        : (context ?? actionService.getContext()).activeWorktreePath;
    if (cwd === undefined || cwd.length === 0) return undefined;
    return actionId === "git.push" ? { kind: "gitPush", cwd } : { kind: "gitPullRebase", cwd };
  }
  return undefined;
}

/**
 * Build fresh preview lines for a resolved target (#11343, #11538).
 *
 * Never rejects: a fetch failure yields the kind's "couldn't verify" note
 * rather than an empty preview that would imply a clean tree / nothing to push.
 * That keeps approval available with the human explicitly warned — blocking it
 * instead would strand the dispatch until the modal's 28s timeout.
 *
 * Exported for unit tests; the bridge is the only production caller.
 */
export async function buildMcpConfirmPreview(target: McpConfirmPreviewTarget): Promise<string[]> {
  if (target.kind === "worktreeDelete") {
    try {
      const preview = await buildWorktreeDeletePreview(target.worktreeId);
      // Monitor gone / already removed → nothing meaningful to preview.
      if (!preview) return [];
      return formatWorktreeDeletePreviewLines(preview);
    } catch {
      return formatWorktreeDeletePreviewLines(null);
    }
  }
  try {
    const preview = await buildGitRemoteOperationPreview(target.cwd);
    return formatGitRemoteOperationPreviewLines(
      preview,
      target.kind === "gitPush"
        ? "No local commits found on this branch."
        : "No local commits to replay."
    );
  } catch {
    return formatGitRemoteOperationPreviewLines(null, "");
  }
}

/**
 * Pin an approved git dispatch to the cwd the human actually previewed.
 *
 * The preview resolves cwd when the modal opens; `ActionService.dispatch` would
 * otherwise re-resolve live context AFTER the wait, so switching worktrees
 * mid-modal could push a different repository than the one just approved
 * (#8725). Non-git targets are untouched — only these two carry a cwd.
 *
 * Only ever fills in an ABSENT cwd. A target only exists when the caller
 * omitted `cwd` or gave a usable one, so this can never overwrite a caller's
 * value with a different path, and malformed args are passed through untouched
 * for validation to reject rather than being repaired into a valid push.
 */
function withPreviewedGitCwd(args: unknown, target: McpConfirmPreviewTarget | undefined): unknown {
  if (target === undefined || target.kind === "worktreeDelete") return args;
  if (args === undefined) return { cwd: target.cwd };
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  return { ...args, cwd: target.cwd };
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
        // Declared outside the confirm block so the approved dispatch can pin
        // itself to the previewed cwd. Stays undefined for pre-granted
        // dispatches, which show no modal and so previewed nothing to pin to.
        let previewTarget: McpConfirmPreviewTarget | undefined;
        try {
          let effectiveConfirmed = confirmed;

          if (effectiveConfirmed !== true) {
            const definition = actionService.getDispatchMeta(actionId as ActionId);
            if (definition?.danger === "confirm") {
              inFlightConfirms.add(requestId);
              // Fetch the fresh preview OFF the critical path so the modal
              // appears immediately (never blocked on a git read) and the
              // confirm queue isn't reordered by fetch latency (#11343). While
              // it's in flight the modal keeps approval disabled
              // (previewPending) so the approver can't confirm a destructive
              // dispatch before seeing what it affects. `setPreview` patches the
              // item and re-enables approval when the fetch lands (empty lines
              // when there's nothing to show); a no-op if already resolved.
              previewTarget = resolveMcpConfirmPreviewTarget(actionId, args, context);
              const previewPending = previewTarget !== undefined;
              if (previewTarget !== undefined) {
                void buildMcpConfirmPreview(previewTarget)
                  .then((preview) => {
                    if (disposed) return;
                    useMcpConfirmStore.getState().setPreview(requestId, preview);
                  })
                  // The builder already fails soft, but a rejection escaping it
                  // would leave previewPending stuck true and the modal
                  // unapprovable — the exact stall class #11538 removes. Clear
                  // it unconditionally.
                  .catch(() => {
                    if (disposed) return;
                    useMcpConfirmStore.getState().setPreview(requestId, []);
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
                  ...(previewTarget ? { previewTitle: mcpConfirmPreviewTitle(previewTarget) } : {}),
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

          const dispatchArgs = tagMcpSpawnSource(
            actionId,
            withPreviewedGitCwd(args, previewTarget)
          );
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
