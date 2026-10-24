import type {
  McpDispatchAuthorization,
  McpConfirmationDecision,
} from "../../../shared/types/ipc/mcpServer.js";
import type { SessionServerDeps } from "./sessionServerDepsContract.js";
import type { CallAuditWriter, CallFacts, CallOutcome } from "./sessionCallFacts.js";

/** Announce a dispatch on the live activity strip (#9759); whether the push went out. */
export function announceCallStarted(
  notifyToolCallStarted: SessionServerDeps["notifyToolCallStarted"],
  facts: CallFacts,
  danger: boolean,
  asks: boolean
): boolean {
  const { sessionId, actionId, args, startedAt, capturedTurnId } = facts;
  if (!notifyToolCallStarted) return false;
  try {
    notifyToolCallStarted({
      sessionId,
      toolId: actionId,
      args,
      startedAt,
      danger,
      asks,
      capturedTurnId,
    });
    return true;
  } catch (err) {
    console.error("[MCP] Failed to notify tool-call-started:", err);
    return false;
  }
}

/**
 * Close out a dispatch: its audit record, then the settle for a strip row that
 * was announced, both under one duration read.
 */
export function settleCall(
  deps: {
    readonly appendAuditRecord: CallAuditWriter;
    readonly notifyToolCallSettled: SessionServerDeps["notifyToolCallSettled"];
  },
  facts: CallFacts,
  settled: {
    readonly outcome: CallOutcome | undefined;
    readonly confirmationDecision: McpConfirmationDecision | undefined;
    readonly dispatchAuthorization: McpDispatchAuthorization | undefined;
    readonly started: { readonly danger: boolean; readonly asks: boolean } | undefined;
  }
): void {
  const { sessionId, actionId, args, tier, startedAt, capturedTurnId } = facts;
  const { appendAuditRecord, notifyToolCallSettled } = deps;
  const { outcome, confirmationDecision, dispatchAuthorization, started } = settled;
  const settledOutcome = outcome ?? { kind: "throw" as const, error: new Error("unknown") };
  // Compute the duration once so the audit record and the live strip
  // report the same wall-clock, not two reads a few µs apart (#9759).
  const durationMs = Date.now() - startedAt;
  // A decision only comes back from a dialog that was raised, so a call
  // stamped `skip-preference` that carries one was asked after all — by
  // a remote Shell that keeps asking for a move of its window, or one
  // too old to take the stamp (#13368). The decision says what happened.
  const recordedAuthorization: McpDispatchAuthorization | undefined =
    dispatchAuthorization === "skip-preference" && confirmationDecision !== undefined
      ? undefined
      : dispatchAuthorization;
  try {
    appendAuditRecord({
      toolId: actionId,
      sessionId,
      tier,
      args,
      durationMs,
      startedAt,
      outcome: settledOutcome,
      confirmationDecision,
      ...(recordedAuthorization !== undefined ? { authorization: recordedAuthorization } : {}),
      capturedTurnId,
    });
  } catch (err) {
    console.error("[MCP] Failed to append audit record:", err);
  }
  // Settle the live activity strip for the matching started push. Guarded
  // so a dispatch that never announced (pre-dispatch rejection, or a
  // started-notify that threw) can't emit a dangling settle (#9759).
  if (started !== undefined && notifyToolCallSettled) {
    try {
      notifyToolCallSettled({
        sessionId,
        toolId: actionId,
        startedAt,
        danger: started.danger,
        asks: started.asks,
        durationMs,
        outcome: settledOutcome,
        capturedTurnId,
      });
    } catch (err) {
      console.error("[MCP] Failed to notify tool-call-settled:", err);
    }
  }
}
