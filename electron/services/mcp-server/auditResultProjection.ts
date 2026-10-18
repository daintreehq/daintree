import { HOST_MESSAGING_OUTCOMES } from "../../../shared/types/hostMessaging.js";
import {
  ASSISTANT_SEND_REFUSALS,
  ASSISTANT_SENT_STATES,
} from "../../../shared/types/assistantMessaging.js";
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
 * A task id as the exchange store mints it, a UUID. Anything else a caller
 * sent is dropped: a short id-shaped string can still be a few words of a
 * message.
 */
const AUDIT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REPLY_STATES: ReadonlySet<string> = new Set(["input-required", "completed"]);
const INBOX_VIEWS: ReadonlySet<string> = new Set(["received", "sent"]);

function auditId(value: unknown): string | null {
  return typeof value === "string" && AUDIT_ID_PATTERN.test(value) ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * An inbox page reduced to how much came back (#13335): never a body, and
 * never the sending host or lane, which are labels another machine chose.
 */
function projectInbox(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (record === null || !Array.isArray(record.messages)) return { status: "unrecognized" };
  let bodyChars = 0;
  const taskIds: Array<string | null> = [];
  for (const message of record.messages) {
    const row = asRecord(message);
    bodyChars += finiteNumber(row?.bodyChars) ?? 0;
    taskIds.push(auditId(row?.taskId));
  }
  return {
    messageCount: record.messages.length,
    bodyChars,
    taskIds,
    ...(Array.isArray(record.sent) ? projectSent(record.sent) : {}),
    cursor: finiteNumber(record.cursor),
    hasMore: record.hasMore === true,
  };
}

const SENT_STATES: ReadonlySet<string> = new Set(ASSISTANT_SENT_STATES);
const SEND_REFUSALS: ReadonlySet<string> = new Set(ASSISTANT_SEND_REFUSALS);

/** Messages a lane sent the hub (#13338), reduced to their ids, states and reply sizes. */
function projectSent(sent: unknown[]): Record<string, unknown> {
  let replyCount = 0;
  let replyChars = 0;
  const rows = sent.map((item) => {
    const row = asRecord(item);
    const replies = Array.isArray(row?.replies) ? row.replies : [];
    replyCount += replies.length;
    for (const reply of replies) {
      const text = asRecord(reply)?.untrustedText;
      replyChars += typeof text === "string" ? text.length : 0;
    }
    return {
      messageId: auditId(row?.messageId),
      state: fromSet(row?.state, SENT_STATES),
      refusal: fromSet(row?.refusal, SEND_REFUSALS),
    };
  });
  return { sentCount: sent.length, sent: rows, replyCount, replyChars };
}

function projectSendMessage(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (record === null) return { status: "unrecognized" };
  return {
    messageId: auditId(record.messageId),
    contextId: auditId(record.contextId),
    hopCount: finiteNumber(record.hopCount),
    state: fromSet(record.state, SENT_STATES),
  };
}

function projectReply(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (record === null) return { status: "unrecognized" };
  return {
    taskId: auditId(record.taskId),
    state: typeof record.state === "string" && REPLY_STATES.has(record.state) ? record.state : null,
    revision: finiteNumber(record.revision),
  };
}

const HOST_ID_PATTERN = /^[\w.-]{1,64}$/;
const HOST_OUTCOMES: ReadonlySet<string> = new Set(HOST_MESSAGING_OUTCOMES);
const CODEX_QUOTA_STATUSES: ReadonlySet<string> = new Set(["ok", "unavailable"]);
const TASK_STATES: ReadonlySet<string> = new Set([
  "submitted",
  "working",
  "input-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
]);

function auditHostId(value: unknown): string | null {
  return typeof value === "string" && HOST_ID_PATTERN.test(value) ? value : null;
}

function fromSet(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

/** A hub tool's result as named outcome, host and task, never a message or reply (#13336). */
function projectHostOutcome(
  record: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const task = asRecord(record.task);
  return {
    outcome: fromSet(record.outcome, HOST_OUTCOMES),
    taskId: auditId(record.taskId ?? task?.taskId),
    state: fromSet(task?.state, TASK_STATES),
    ...extra,
  };
}

function hostResultProjection(
  extra: (record: Record<string, unknown>) => Record<string, unknown> = () => ({})
): (result: unknown) => unknown {
  return (result) => {
    const record = asRecord(result);
    return record === null ? { status: "unrecognized" } : projectHostOutcome(record, extra(record));
  };
}

function projectHostList(result: unknown): Record<string, unknown> {
  const record = asRecord(result);
  if (record === null || !Array.isArray(record.hosts)) return { status: "unrecognized" };
  return {
    hostCount: record.hosts.length,
    hostIds: record.hosts.map((host) => auditHostId(asRecord(host)?.hostId)),
  };
}

function projectHostReplies(record: Record<string, unknown>): Record<string, unknown> {
  const replies = Array.isArray(record.replies) ? record.replies : null;
  return {
    replyCount: replies?.length ?? null,
    replyChars:
      replies?.reduce<number>((sum, reply) => {
        const text = asRecord(reply)?.untrustedText;
        return sum + (typeof text === "string" ? text.length : 0);
      }, 0) ?? null,
    repliesOmitted: finiteNumber(record.repliesOmitted),
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
  ["assistant.getInbox", projectInbox],
  ["assistant.reply", projectReply],
  ["assistant.sendMessage", projectSendMessage],
  ["host.list", projectHostList],
  [
    "host.listAssistants",
    // Counts only: a host's project names and paths stay out of the audit.
    hostResultProjection((record) => {
      const projects = Array.isArray(record.projects) ? record.projects : null;
      return {
        projectCount: projects?.length ?? null,
        assistantCount:
          projects?.reduce<number>((sum, project) => {
            const assistants = asRecord(project)?.assistants;
            return sum + (Array.isArray(assistants) ? assistants.length : 0);
          }, 0) ?? null,
        projectsOmitted: finiteNumber(record.projectsOmitted),
      };
    }),
  ],
  [
    "host.sendMessage",
    hostResultProjection((record) => ({
      wait: typeof record.wait === "string" ? record.wait : null,
    })),
  ],
  ["host.getTask", hostResultProjection(projectHostReplies)],
  [
    "host.listTasks",
    hostResultProjection((record) => ({
      taskCount: Array.isArray(record.tasks) ? record.tasks.length : null,
      cursor: finiteNumber(record.cursor),
      hasMore: record.hasMore === true,
      reset: record.reset === true,
    })),
  ],
  ["host.cancelTask", hostResultProjection()],
  [
    "host.startAssistant",
    hostResultProjection((record) => {
      const assistant = asRecord(record.assistant);
      return {
        slot: finiteNumber(assistant?.slot),
        started: typeof assistant?.started === "boolean" ? assistant.started : null,
      };
    }),
  ],
  [
    "host.readQuota",
    // Whether Codex answered and how many windows, never what it said of them.
    hostResultProjection((record) => {
      const codex = asRecord(record.codex);
      return {
        codexStatus: fromSet(codex?.status, CODEX_QUOTA_STATUSES),
        windowCount: Array.isArray(codex?.windows) ? codex.windows.length : null,
      };
    }),
  ],
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
 * Tools whose arguments are conversation (#13335). The generic summarizer
 * keeps any string of 50 characters or fewer verbatim, which is a whole short
 * message, so these are rebuilt from named fields first: ids that look like
 * ids, enums from their own set, and the length of the text — never the text.
 * A malformed call is reduced the same way, since refusals are audited too.
 */
const AUDIT_ARGS_PROJECTIONS: ReadonlyMap<string, (args: unknown) => unknown> = new Map<
  string,
  (args: unknown) => unknown
>([
  [
    "assistant.getInbox",
    (args) => {
      const record = asRecord(args);
      return {
        cursor: finiteNumber(record?.cursor),
        limit: finiteNumber(record?.limit),
        view: fromSet(record?.view, INBOX_VIEWS),
      };
    },
  ],
  [
    "assistant.sendMessage",
    (args) => {
      const record = asRecord(args);
      return {
        contextId: auditId(record?.contextId),
        referenceTaskIds: Array.isArray(record?.referenceTaskIds)
          ? record.referenceTaskIds.length
          : null,
        textChars: typeof record?.text === "string" ? record.text.length : null,
      };
    },
  ],
  ["host.list", () => ({})],
  ["host.listAssistants", (args) => ({ hostId: auditHostId(asRecord(args)?.hostId) })],
  [
    "host.sendMessage",
    (args) => {
      const record = asRecord(args);
      return {
        hostId: auditHostId(record?.hostId),
        slot: finiteNumber(record?.slot),
        taskId: auditId(record?.taskId),
        contextId: auditId(record?.contextId),
        referenceTaskIds: Array.isArray(record?.referenceTaskIds)
          ? record.referenceTaskIds.length
          : null,
        waitMs: finiteNumber(record?.waitMs),
        textChars: typeof record?.text === "string" ? record.text.length : null,
      };
    },
  ],
  [
    "host.getTask",
    (args) => ({
      hostId: auditHostId(asRecord(args)?.hostId),
      taskId: auditId(asRecord(args)?.taskId),
    }),
  ],
  [
    "host.listTasks",
    (args) => {
      const record = asRecord(args);
      return {
        hostId: auditHostId(record?.hostId),
        cursor: finiteNumber(record?.cursor),
        limit: finiteNumber(record?.limit),
        states: Array.isArray(record?.states)
          ? record.states.map((state) => fromSet(state, TASK_STATES))
          : null,
      };
    },
  ],
  [
    "host.cancelTask",
    (args) => ({
      hostId: auditHostId(asRecord(args)?.hostId),
      taskId: auditId(asRecord(args)?.taskId),
    }),
  ],
  [
    "host.startAssistant",
    (args) => {
      const record = asRecord(args);
      return {
        hostId: auditHostId(record?.hostId),
        projectId: auditId(record?.projectId),
        agentId: auditId(record?.agentId),
        startNew: record?.startNew === true,
      };
    },
  ],
  ["host.readQuota", (args) => ({ hostId: auditHostId(asRecord(args)?.hostId) })],
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
  [
    "assistant.reply",
    (args) => {
      const record = asRecord(args);
      return {
        taskId: auditId(record?.taskId),
        state:
          typeof record?.state === "string" && REPLY_STATES.has(record.state) ? record.state : null,
        textChars: typeof record?.text === "string" ? record.text.length : null,
      };
    },
  ],
]);

/** A tool id as the manifest spells them: never a few words of a message. */
const RELAYED_TOOL_ID_PATTERN = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){1,4}$/;
/** Keys whose short strings are still someone's words: kept to their length, whatever the tool. */
const RELAYED_TEXT_KEY_PATTERN =
  /^(?:prompt|text|command|body|message|input|keys|data|content|reply|query)$/i;

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
  for (const [key, value] of Object.entries(projected ?? {})) {
    out[`args.${key}`] =
      typeof value === "string" && RELAYED_TEXT_KEY_PATTERN.test(key)
        ? `<string: ${value.length} chars>`
        : value;
  }
  return out;
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
