import { dispatchCarriesRecipeId } from "../../../shared/utils/dispatchRecipeId.js";
import { isGenericNativeGrantEligible } from "../../../shared/config/nativeGrantUsePolicies.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type { DispatchEnvelope } from "./shared.js";
import {
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  USER_REJECTED_CODE,
  EXECUTION_ERROR_CODE,
  buildToolError,
} from "./shared.js";
import { McpRouteBindingError, RendererBridgeUnavailableError } from "./rendererBridge.js";
import type { CallToolResultLike } from "./sessionDedup.js";
import type { SessionServerDeps } from "./sessionServerDepsContract.js";
import { bindingGoneCode, sessionGoneError } from "./sessionRouteErrors.js";
import type { McpConfirmationDecision } from "../../../shared/types/ipc/mcpServer.js";
import type { SessionStore } from "./sessionStore.js";
import type { CallFacts, CallOutcome } from "./sessionCallFacts.js";
import type { OwnedResourceTool } from "./sessionCallOwnership.js";

/**
 * The three things an approval ask writes back into its call, at the moment it
 * learns them: the call's outcome when the ask ends it, the decision the
 * dialog returned, and the confirmation an approval stands in for.
 */
export interface ApprovalRecorder {
  readonly recordOutcome: (outcome: CallOutcome) => void;
  readonly recordConfirmationDecision: (decision: McpConfirmationDecision | undefined) => void;
  readonly preconfirm: (authorization: "user") => void;
}

export function createCallApprovals(
  deps: Pick<SessionServerDeps, "requestApproval" | "requestCloseApproval"> & {
    readonly sessionStore: Pick<SessionStore, "getTier" | "hasLiveTransport" | "grantCache">;
  },
  facts: CallFacts,
  ownedResource: OwnedResourceTool | undefined,
  record: ApprovalRecorder
) {
  const { sessionId, actionId, args, tier } = facts;
  const { sessionStore, requestApproval, requestCloseApproval } = deps;

  /**
   * Mint the per-tool grant behind "Allow for this session" (#12692), unless
   * the session ended while the user was deciding — a grant written then
   * would outlive the session it was meant for.
   */
  const mintSessionApproval = (): void => {
    if (!sessionStore.hasLiveTransport(sessionId)) {
      return;
    }
    sessionStore.grantCache.issueGrant(sessionId, actionId);
  };

  /**
   * Put an above-tier pane call to the user (#12692). Returns the tool error
   * to hand back when the call must not run, or `undefined` once approved —
   * having recorded that approval as the dispatch's confirmation, so the
   * ordinary dialog is not raised a second time for the same call.
   *
   * A decline is `USER_REJECTED` and a missed dialog `CONFIRMATION_TIMEOUT`,
   * the codes the ordinary dialog already uses: both final for this call, and
   * neither counted toward revoking the session.
   */
  const askForApproval = async (): Promise<CallToolResultLike | undefined> => {
    if (requestApproval === undefined) {
      // Unreachable: `approvalRequired` implies a pane, and a pane always has
      // the route. Refuse rather than run unasked.
      const message = `action '${actionId}' is not permitted for the '${tier}' tier.`;
      record.recordOutcome({
        kind: "result",
        value: { ok: false, error: { code: TIER_NOT_PERMITTED_CODE, message } },
      });
      return buildToolError({ code: TIER_NOT_PERMITTED_CODE, message });
    }
    let approval: DispatchEnvelope;
    try {
      approval = await requestApproval(actionId, args);
    } catch (err) {
      record.recordOutcome({ kind: "throw", error: err });
      if (err instanceof McpRouteBindingError) {
        return buildToolError({
          code: bindingGoneCode(err),
          message: err.message,
          retriable: err.retriable,
        });
      }
      if (err instanceof RendererBridgeUnavailableError) {
        const message =
          `Action '${actionId}' is above this project's '${tier}' MCP tier, so it needs the user's ` +
          `approval, but no Daintree window is open to ask them. The action was not run.`;
        record.recordOutcome({
          kind: "result",
          value: {
            ok: false,
            error: {
              code: CONFIRMATION_REQUIRED_CODE,
              message,
              details: { confirmationChannel: "unavailable" },
            },
          },
        });
        return buildToolError({
          code: CONFIRMATION_REQUIRED_CODE,
          message,
          details: { confirmationChannel: "unavailable" },
        });
      }
      return buildToolError({
        code: EXECUTION_ERROR_CODE,
        message: formatErrorMessage(err, `Could not ask for approval of '${actionId}'`),
      });
    }
    record.recordConfirmationDecision(approval.confirmationDecision);
    if (approval.confirmationDecision !== "approved") {
      // Anything short of an explicit approval is a refusal. The renderer's
      // own error is kept when it sent one — it says whether the user
      // declined or the dialog timed out.
      const error: import("../../../shared/types/actions.js").ActionError = approval.result.ok
        ? {
            code: USER_REJECTED_CODE,
            message: `The user did not approve '${actionId}'. The action was not run.`,
          }
        : approval.result.error;
      record.recordOutcome({ kind: "result", value: { ok: false, error } });
      return buildToolError({
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
    if (sessionStore.getTier(sessionId) === null) throw sessionGoneError();
    if (approval.approvalScope === "session") mintSessionApproval();
    // The approval covers the ordinary confirmation too — one ask, not two —
    // except where that dialog carries something this one could not. A
    // target-picking tool still needs the pick. An owned tool was approved
    // under its wrapper id, which the preview does not recognise, so the
    // delegate's own dialog is the first to show what it destroys. And a
    // recipe dispatch's dialog is what binds the run to the recipe the user
    // read (#12263); preconfirming would drop that binding and run whatever
    // the recipe says by then.
    if (
      isGenericNativeGrantEligible(actionId) &&
      ownedResource === undefined &&
      !dispatchCarriesRecipeId(args)
    ) {
      record.preconfirm("user");
    }
    return undefined;
  };

  /**
   * Put a close by Daintree's own assistant to the user, once for every
   * panel it names (#12881). Resolves with the ids the user left checked, or
   * with the tool error to hand back when nothing may close: a decline, a
   * missed dialog, or no window to ask in. A refusal is final for the call,
   * so a batch that was turned down never falls back to asking per panel.
   */
  const askToClose = async (
    terminalIds: readonly string[]
  ): Promise<{ approved: ReadonlySet<string> } | { refusal: CallToolResultLike }> => {
    const refuse = (
      error: import("../../../shared/types/actions.js").ActionError
    ): { refusal: CallToolResultLike } => {
      record.recordOutcome({ kind: "result", value: { ok: false, error } });
      return {
        refusal: buildToolError({
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        }),
      };
    };
    if (requestCloseApproval === undefined) {
      return refuse({
        code: CONFIRMATION_REQUIRED_CODE,
        message: `Closing these panels needs the user's approval, and this session has no way to ask. Nothing was closed.`,
        details: { confirmationChannel: "unavailable" },
      });
    }
    let approval: DispatchEnvelope;
    try {
      approval = await requestCloseApproval(actionId, { terminalIds: [...terminalIds] });
    } catch (err) {
      if (err instanceof McpRouteBindingError) {
        record.recordOutcome({ kind: "throw", error: err });
        return {
          refusal: buildToolError({
            code: bindingGoneCode(err),
            message: err.message,
            retriable: err.retriable,
          }),
        };
      }
      return refuse({
        code: CONFIRMATION_REQUIRED_CODE,
        message: formatErrorMessage(
          err,
          "Closing these panels needs the user's approval, and no Daintree window could ask"
        ).concat(" Nothing was closed."),
        details: { confirmationChannel: "unavailable" },
      });
    }
    record.recordConfirmationDecision(approval.confirmationDecision);
    if (approval.confirmationDecision !== "approved") {
      return refuse(
        approval.result.ok
          ? {
              code: USER_REJECTED_CODE,
              message: `The user did not approve closing these panels. Nothing was closed; do not retry them one at a time.`,
            }
          : approval.result.error
      );
    }
    if (sessionStore.getTier(sessionId) === null) throw sessionGoneError();
    // Only ids this call asked about. Anything else the renderer reported is
    // not consent about this close; nothing reported means nothing approved.
    const requested = new Set(terminalIds);
    const selected = approval.result.ok
      ? (approval.result.result as { selectedTargetIds?: unknown } | null | undefined)
          ?.selectedTargetIds
      : undefined;
    const approved = new Set(
      Array.isArray(selected)
        ? selected.filter((id): id is string => typeof id === "string" && requested.has(id))
        : []
    );
    return { approved };
  };

  return { askForApproval, askToClose, mintSessionApproval };
}
