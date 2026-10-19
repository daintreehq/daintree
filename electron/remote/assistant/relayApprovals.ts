import { randomUUID } from "node:crypto";
import { canonicalArgsHash } from "../../services/mcp-server/sessionDedup.js";
import type {
  ViewlessApprovalAsk,
  ViewlessApprovalDecision,
} from "../../services/viewless/index.js";
import type { LinkSession } from "../link/session.js";
import {
  AssistantLinkMethod,
  RelayApproveAnswerSchema,
  type RelayApprovePayload,
} from "./linkMethods.js";

/**
 * How long a host waits for a Shell to answer an approval, and how long the
 * answer covers the call. The Shell's dialog gives up after 28 s, inside its
 * own 30 s dispatch, so this leaves the call time to reach its change once
 * approved, and no more.
 */
export const RELAY_APPROVAL_WINDOW_MS = 40_000;

/** One confirm-gated call a Shell assistant is making here, to put to its person. */
export interface RelayApprovalAsk extends ViewlessApprovalAsk {
  helpSessionId: string;
  /** The MCP_CALL being made: the Shell asks only about one of its own in flight. */
  callId: string;
  projectId: string;
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Ask the Shell a relayed call came from to put it to its person (#13501),
 * in its own window, with this host's preview of it. Each ask carries a fresh
 * id and the canonical hash of exactly the arguments the call runs with, and
 * an answer counts only if it echoes both and arrives in time: an approval is
 * this one call's, until the deadline, and nothing here keeps it for another.
 * Anything else — no link, a Shell too old to ask, an answer that doesn't
 * match — is nobody approving, and the call is refused as it was before.
 */
export async function askShellApproval(
  session: Pick<LinkSession, "call"> | null,
  ask: RelayApprovalAsk,
  options: { now?: () => number; newId?: () => string; windowMs?: number } = {}
): Promise<ViewlessApprovalDecision> {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? RELAY_APPROVAL_WINDOW_MS;
  const args = ask.args;
  if (session === null || args === null || typeof args !== "object" || Array.isArray(args)) {
    return { decision: "unavailable" };
  }
  const approvalId = (options.newId ?? randomUUID)();
  const argsHash = canonicalArgsHash(ask.actionId, args);
  const deadline = now() + windowMs;
  const payload: RelayApprovePayload = {
    approvalId,
    helpSessionId: ask.helpSessionId,
    callId: ask.callId,
    projectId: ask.projectId,
    actionId: ask.actionId,
    args: args as Record<string, unknown>,
    argsHash,
    ...(ask.subject ? { subject: ask.subject.slice(0, 256) } : {}),
    lines: ask.lines,
  };
  let answer: unknown;
  try {
    answer = await session.call(AssistantLinkMethod.RELAY_APPROVE, payload, {
      timeoutMs: windowMs,
    });
  } catch (error) {
    // It may have been answered and the answer lost: nothing approved it here.
    return codeOf(error) === "OUTCOME_UNKNOWN"
      ? { decision: "timeout" }
      : { decision: "unavailable" };
  }
  const parsed = RelayApproveAnswerSchema.safeParse(answer);
  if (
    !parsed.success ||
    parsed.data.approvalId !== approvalId ||
    parsed.data.argsHash !== argsHash
  ) {
    return { decision: "unavailable" };
  }
  switch (parsed.data.decision) {
    case "approved":
      return now() > deadline ? { decision: "timeout" } : { decision: "approved", deadline };
    case "rejected":
    case "timeout":
      return { decision: parsed.data.decision };
    case "refused":
      return { decision: "unavailable" };
  }
}
