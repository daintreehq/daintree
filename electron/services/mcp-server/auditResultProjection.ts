import { HOST_CONTROL_OUTCOMES } from "../../../shared/types/hostControl.js";
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
 * whose result is conversation has to be reduced to its shape first. Such a
 * projection builds a fresh object from fields it names; nothing is spread,
 * and a result of an unexpected shape reduces to a marker rather than falling
 * back to the raw value.
 *
 * The status and wait tools are narrower: their results were always audited
 * whole, and the one piece of agent prose they carry is a handback message
 * (#12488), so only that is reduced.
 */

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
  // Another assistant's reply as its screen showed it (#13496): its length, never its words.
  if (record?.status === "observed") {
    return {
      status: "observed",
      source: record.source === "handback" || record.source === "screen" ? record.source : null,
      textChars: typeof record.text === "string" ? record.text.length : null,
      truncated: record.truncated === true,
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

/**
 * A handback reduced to its shape (#12488): the marker was seen, when, for which
 * submission, and how long the message was — never the message, which is text
 * the agent wrote.
 */
function reduceHandback(value: unknown): unknown {
  const handback = asRecord(value);
  if (handback === null) return null;
  return {
    messageChars: typeof handback.message === "string" ? handback.message.length : null,
    observedAt: typeof handback.observedAt === "number" ? handback.observedAt : null,
    submissionToken:
      typeof handback.submissionToken === "string" ? handback.submissionToken : undefined,
    truncated: handback.truncated === true,
  };
}

function withReducedHandback(entry: unknown): unknown {
  const record = asRecord(entry);
  if (record === null || !Object.hasOwn(record, "lastHandback")) return entry;
  return { ...record, lastHandback: reduceHandback(record.lastHandback) };
}

/**
 * Status and wait results keep their shape — they are otherwise audited as is —
 * with only each `lastHandback` reduced. They carry it on the result itself
 * (the single wait) or on each row (`terminals` for status, `results` for the
 * batched wait).
 */
function projectHandbackCarrier(result: unknown): unknown {
  const record = asRecord(withReducedHandback(result));
  if (record === null) return result;
  const reduceRows = (key: string): Record<string, unknown> => {
    const rows: unknown = record[key];
    return Array.isArray(rows) ? { [key]: rows.map(withReducedHandback) } : {};
  };
  return { ...record, ...reduceRows("terminals"), ...reduceRows("results") };
}

/**
 * An id as this machine mints them, a UUID. Anything else a caller sent is
 * dropped: a short id-shaped string can still be a few words of a message.
 */
const AUDIT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function auditId(value: unknown): string | null {
  return typeof value === "string" && AUDIT_ID_PATTERN.test(value) ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const HOST_ID_PATTERN = /^[\w.-]{1,64}$/;
const HOST_OUTCOMES: ReadonlySet<string> = new Set(HOST_CONTROL_OUTCOMES);

function auditHostId(value: unknown): string | null {
  return typeof value === "string" && HOST_ID_PATTERN.test(value) ? value : null;
}

function fromSet(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

/** Hosts by id, and how many projects each named: a host's project names stay out of the audit. */
function projectHostList(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (record === null || !Array.isArray(record.hosts)) return { status: "unrecognized" };
  return {
    hostCount: record.hosts.length,
    hostIds: record.hosts.map((host) => auditHostId(asRecord(host)?.hostId)),
    projectCounts: record.hosts.map((host) => {
      const projects = asRecord(host)?.projects;
      return Array.isArray(projects) ? projects.length : null;
    }),
  };
}

/** How a command ended and how much it printed — never what it printed. */
function projectCommandRun(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (!record) return { status: "unrecognized" };
  return {
    exitCode: finiteNumber(record.exitCode),
    signalName: typeof record.signalName === "string" ? record.signalName : null,
    timedOut: record.timedOut === true,
    aborted: record.aborted === true,
    durationMs: finiteNumber(record.durationMs),
    outputChars: typeof record.output === "string" ? record.output.length : null,
    outputTruncated: record.outputTruncated === true,
  };
}

/** The capture's size and how many console lines came back — never the pixels or the lines. */
function projectPanelCapture(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  const image = asRecord(record?.image);
  if (!record || !image) return { status: "unrecognized" };
  return {
    width: finiteNumber(image.width),
    height: finiteNumber(image.height),
    imageBytes: typeof image.data === "string" ? Buffer.byteLength(image.data, "base64") : null,
    consoleMessageCount: Array.isArray(record.consoleMessages)
      ? record.consoleMessages.length
      : null,
  };
}

const AUDIT_RESULT_PROJECTIONS: ReadonlyMap<string, (result: unknown) => unknown> = new Map<
  string,
  (result: unknown) => unknown
>([
  ["terminal.readLastMessageOwned", projectLastMessage],
  ["terminal.getStatus", projectHandbackCarrier],
  ["terminal.waitUntilIdle", projectHandbackCarrier],
  ["terminal.waitUntilIdleBatch", projectHandbackCarrier],
  ["host.list", projectHostList],
  [
    "host.call",
    // Whether the host answered and whether its tool failed, never what it returned (#13493).
    (result) => {
      const record = asRecord(result);
      if (record === null) return { status: "unrecognized" };
      const inner = asRecord(record.result);
      return {
        outcome: fromSet(record.outcome, HOST_OUTCOMES),
        callId: auditId(record.callId),
        isError: typeof inner?.isError === "boolean" ? inner.isError : null,
      };
    },
  ],
  ["plugin.capturePanel", projectPanelCapture],
  ["project.runCommand", projectCommandRun],
]);

/** The value to summarize for `toolId`'s audit record: its projection when it has one, else the result as is. */
export function projectAuditResult(toolId: string, result: unknown): unknown {
  const projection = AUDIT_RESULT_PROJECTIONS.get(toolId);
  return projection ? projection(result) : result;
}

/**
 * Tools whose arguments are rebuilt from named fields before the generic
 * summarizer sees them, so only those fields reach the audit. A malformed call
 * is reduced the same way, since refusals are audited too.
 */
const AUDIT_ARGS_PROJECTIONS: ReadonlyMap<string, (args: unknown) => unknown> = new Map<
  string,
  (args: unknown) => unknown
>([
  [
    "project.runCommand",
    (args) => {
      const record = asRecord(args);
      return {
        projectId: typeof record?.projectId === "string" ? record.projectId : null,
        command: typeof record?.command === "string" ? record.command : null,
        cwd: typeof record?.cwd === "string" ? record.cwd : null,
        timeoutMs: finiteNumber(record?.timeoutMs),
      };
    },
  ],
]);

/** A tool id as the manifest spells them: never a few words of a message. */
const RELAYED_TOOL_ID_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){1,4}$/;
/**
 * Keys whose short strings are still someone's words: kept to their length,
 * whatever the tool. Matched as a suffix, so `systemPrompt` is a prompt too.
 */
const RELAYED_TEXT_KEY_PATTERN =
  /(?:prompt|text|command|body|message|input|keys?|data|content|reply|query|title|choose|description|comment)$/i;

/**
 * A `host.call` as the Shell audits it (#13493): the host, project, tool and
 * callId, and the tool's own arguments as this machine would audit that tool,
 * flattened so the summary doesn't fold them into `<object>`. Text a person
 * or agent wrote is kept to its length, short or not.
 */
function projectHostCallArgs(args: unknown): Record<string, unknown> {
  const record = asRecord(args);
  const tool =
    typeof record?.tool === "string" && RELAYED_TOOL_ID_PATTERN.test(record.tool)
      ? record.tool
      : null;
  const inner = asRecord(record?.args);
  // Never another relay's arguments, however deep a caller nested them.
  const projected =
    tool !== null && tool !== "host.call" && inner !== null
      ? asRecord(projectAuditArgs(tool, inner))
      : null;
  const out: Record<string, unknown> = {
    hostId: auditHostId(record?.hostId),
    projectId: auditId(record?.projectId),
    tool,
    callId: auditId(record?.callId),
  };
  for (const [key, value] of Object.entries(withoutWrittenText(projected ?? {}))) {
    out[`args.${key}`] = value;
  }
  return out;
}

/** A projection with every string someone wrote kept to its length. */
function withoutWrittenText(projected: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(projected)) {
    out[key] =
      typeof value === "string" && RELAYED_TEXT_KEY_PATTERN.test(key)
        ? `<string: ${value.length} chars>`
        : value;
  }
  return out;
}

/**
 * A tool's arguments as a host audits a call another machine's assistant ran
 * here (#13493): the tool's own projection, and nothing anyone wrote, however
 * short, since the words are that machine's to keep.
 */
export function projectRelayedAuditArgs(toolId: string, args: unknown): unknown {
  const projected = projectAuditArgs(toolId, args);
  const record = asRecord(projected);
  return record === null ? projected : withoutWrittenText(record);
}

/** The arguments to summarize for `toolId`'s audit record and activity strip. */
export function projectAuditArgs(toolId: string, args: unknown): unknown {
  if (toolId === "host.call") return projectHostCallArgs(args);
  const projection = AUDIT_ARGS_PROJECTIONS.get(toolId);
  return projection ? projection(args) : args;
}

/**
 * Arguments kept whole in `toolId`'s summary rather than collapsed past 50
 * characters (#13495). A command runner's audit is worth little without the
 * command, which is the one thing the issue requires it to keep; its output
 * stays out through the result projection above.
 */
const AUDIT_VERBATIM_ARG_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["project.runCommand", new Set(["command"])],
]);

export function auditVerbatimArgKeys(toolId: string): ReadonlySet<string> | undefined {
  return AUDIT_VERBATIM_ARG_KEYS.get(toolId);
}
