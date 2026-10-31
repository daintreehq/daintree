import { randomUUID } from "node:crypto";
import {
  MCP_DISPATCH_TIMEOUT_MS,
  MCP_REMOTE_DISPATCH_TIMEOUT_MS,
} from "../../../shared/config/mcpConfirmWindow.js";
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
 * How long a host waits for a Shell to answer an approval (#15699): a whole
 * confirmation in the Shell's window, from waiting behind other prompts to a
 * full decision window once it is on screen, then the trip back. The Shell
 * holds its dialog inside this.
 */
export const RELAY_APPROVAL_WINDOW_MS = MCP_REMOTE_DISPATCH_TIMEOUT_MS;

/**
 * How long an approval covers the call from when it arrives: the run a local
 * approval buys, so the call reaches its change promptly or not at all.
 */
const RELAY_APPROVED_RUN_MS = MCP_DISPATCH_TIMEOUT_MS;

/** One confirm-gated call a Shell assistant is making here, to put to its person. */
export interface RelayApprovalAsk extends ViewlessApprovalAsk {
  helpSessionId: string;
  /** The MCP_CALL being made: the Shell asks only about one of its own in flight. */
  callId: string;
  projectId: string;
  /**
   * When that call stops waiting on its answer, on this host's clock
   * (#15699): the ask ends by then, and an approval covers nothing after it.
   * Never sent.
   */
  holdUntil?: number;
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
  const args = ask.args;
  if (session === null || args === null || typeof args !== "object" || Array.isArray(args)) {
    return { decision: "unavailable" };
  }
  const askedAt = now();
  const holdUntil = ask.holdUntil ?? Infinity;
  const windowMs = Math.floor(
    Math.min(options.windowMs ?? RELAY_APPROVAL_WINDOW_MS, holdUntil - askedAt)
  );
  // The call gives up before anyone could answer: asked now, it would only
  // show a dialog whose answer runs nothing.
  if (windowMs <= 0) return { decision: "timeout" };
  const approvalId = (options.newId ?? randomUUID)();
  const argsHash = canonicalArgsHash(ask.actionId, args);
  const answerBy = askedAt + windowMs;
  // Covered for a run from when the answer came, never past the call's own wait.
  const covered = (): number => Math.min(now() + RELAY_APPROVED_RUN_MS, holdUntil);
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
      return now() > answerBy
        ? { decision: "timeout" }
        : { decision: "approved", deadline: covered() };
    // The Shell's own "Never ask" (#15698): covered as an approval is, and said as a skip.
    case "skip-preference":
      return now() > answerBy
        ? { decision: "timeout" }
        : { decision: "approved", deadline: covered(), authorization: "skip-preference" };
    case "rejected":
    case "timeout":
      return { decision: parsed.data.decision };
    case "refused":
      return { decision: "unavailable" };
  }
}
