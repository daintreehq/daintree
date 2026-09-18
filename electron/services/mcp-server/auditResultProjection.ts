import {
  AGENT_LAST_MESSAGE_UNAVAILABLE_REASONS,
  type AgentLastMessageUnavailableReason,
} from "../../../shared/types/agentLastMessage.js";

/**
 * Host-owned reductions of a tool's result for the audit record, applied
 * before the generic summarizer ever sees it (#12479).
 *
 * The audit ring is persisted to SQLite and exportable as NDJSON, and a
 * successful result otherwise goes into it wholesale. The summarizer's
 * redaction is built for secrets — key names and token shapes — and has
 * nothing to say about an agent's prose or the questions it asked, so a tool
 * whose result is conversation has to be reduced to its shape first. Each
 * projection builds a fresh object from fields it names; nothing is spread,
 * and a result of an unexpected shape reduces to a marker rather than falling
 * back to the raw value.
 */

type AuditResultProjection = (result: unknown) => Record<string, unknown>;

const TOOL_NAME_MAX_CHARS = 256;
const PROVIDERS: ReadonlySet<string> = new Set(["claude", "codex"]);
const UNAVAILABLE_REASONS: ReadonlySet<string> = new Set(AGENT_LAST_MESSAGE_UNAVAILABLE_REASONS);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Status, provider, how much text came back and which tools were pending — never the text or any input. */
function projectLastMessage(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (record?.status === "unavailable") {
    const reason = typeof record.reason === "string" && UNAVAILABLE_REASONS.has(record.reason);
    return {
      status: "unavailable",
      reason: reason ? (record.reason as AgentLastMessageUnavailableReason) : null,
    };
  }
  if (record?.status !== "ok") return { status: "unrecognized" };
  const message = asRecord(record.message);
  const uses = Array.isArray(record.unansweredToolUses) ? record.unansweredToolUses : [];
  return {
    status: "ok",
    provider:
      typeof record.provider === "string" && PROVIDERS.has(record.provider)
        ? record.provider
        : null,
    messageChars: typeof message?.text === "string" ? message.text.length : null,
    unansweredToolNames: uses.map((use) => {
      const name = asRecord(use)?.name;
      return typeof name === "string" ? name.slice(0, TOOL_NAME_MAX_CHARS) : null;
    }),
  };
}

const AUDIT_RESULT_PROJECTIONS: ReadonlyMap<string, AuditResultProjection> = new Map([
  ["terminal.readLastMessageOwned", projectLastMessage],
]);

/** The value to summarize for `toolId`'s audit record: its projection when it has one, else the result as is. */
export function projectAuditResult(toolId: string, result: unknown): unknown {
  const projection = AUDIT_RESULT_PROJECTIONS.get(toolId);
  return projection ? projection(result) : result;
}
