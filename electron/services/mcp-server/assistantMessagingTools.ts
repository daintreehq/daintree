import type { ActionErrorCode } from "../../../shared/types/actions.js";
import {
  ASSISTANT_GET_INBOX_TOOL,
  ASSISTANT_REPLY_TOOL,
  ASSISTANT_SEND_MESSAGE_TOOL,
  AssistantGetInboxArgsSchema,
  AssistantReplyArgsSchema,
  AssistantSendMessageArgsSchema,
  type AssistantGetInboxArgs,
  type AssistantGetInboxResult,
  type AssistantMessagingOutcome,
  type AssistantMessagingRefusalCode,
  type AssistantReplyArgs,
  type AssistantReplyResult,
  type AssistantSendMessageArgs,
  type AssistantSendMessageResult,
} from "../../../shared/types/assistantMessaging.js";

/**
 * An enrolled lane's messaging, bound to one MCP session's help-session
 * bearer (#13335). The session server never names a lane: whichever lane
 * this session's bearer belongs to is the only one these reach.
 */
export interface AssistantMessagingAccess {
  /** Whether this session is an enrolled lane right now. */
  isAvailable(): boolean;
  /** Whether this session may start a message to its Shell's hub (#13338); never true for the hub. */
  isSendAvailable(): boolean;
  /** Whether its lane could be enrolled here; listing goes by this or `isAvailable`. */
  isReachable?(): boolean;
  /** Whether its lane could be one a remote Shell enrolls; listing of the send tool goes by this. */
  isSendReachable?(): boolean;
  getInbox(args: AssistantGetInboxArgs): AssistantMessagingOutcome<AssistantGetInboxResult>;
  reply(args: AssistantReplyArgs): AssistantMessagingOutcome<AssistantReplyResult>;
  sendMessage(
    args: AssistantSendMessageArgs
  ): AssistantMessagingOutcome<AssistantSendMessageResult>;
}

/**
 * What the MCP server needs of the messaging runtime, which Remote Hosts owns
 * and installs (electron/remote/assistant/install.ts). Core code never imports
 * the runtime itself, so a build without Remote Hosts leaves this empty and
 * offers neither tool.
 */
export interface AssistantMessagingRuntimeHandle {
  isAvailable(helpSessionId: string): boolean;
  isSendAvailable(helpSessionId: string): boolean;
  isReachable?(helpSessionId: string): boolean;
  isSendReachable?(helpSessionId: string): boolean;
  getInbox(
    helpSessionId: string,
    args: AssistantGetInboxArgs
  ): AssistantMessagingOutcome<AssistantGetInboxResult>;
  reply(
    helpSessionId: string,
    args: AssistantReplyArgs
  ): AssistantMessagingOutcome<AssistantReplyResult>;
  sendMessage(
    helpSessionId: string,
    args: AssistantSendMessageArgs
  ): AssistantMessagingOutcome<AssistantSendMessageResult>;
}

let installedRuntime: AssistantMessagingRuntimeHandle | null = null;

/** Installs the process's messaging runtime; the returned call removes it again. */
export function setAssistantMessagingRuntime(runtime: AssistantMessagingRuntimeHandle): () => void {
  installedRuntime = runtime;
  return () => {
    if (installedRuntime === runtime) installedRuntime = null;
  };
}

const NOT_ELIGIBLE_MESSAGE =
  "Only an assistant whose lane is enrolled for messaging, in the session it was enrolled with, has an inbox.";
const INVALID_ARGS_MESSAGE = "The arguments don't match this tool's schema.";

/**
 * One MCP session's view of the runtime: whichever help session the session
 * is bound to when each call lands. Both are read live, so a revoked bearer
 * that drops out of the binding, or a runtime that stops, refuses at once.
 */
export function bindAssistantMessaging(
  resolveHelpSessionId: () => string | undefined
): AssistantMessagingAccess {
  const caller = () => {
    const helpSessionId = resolveHelpSessionId();
    const runtime = installedRuntime;
    return helpSessionId === undefined || runtime === null ? null : { helpSessionId, runtime };
  };
  const notEligible = {
    ok: false as const,
    code: "NOT_ELIGIBLE" as const,
    message: NOT_ELIGIBLE_MESSAGE,
  };
  return {
    isAvailable: () => {
      const found = caller();
      return found !== null && found.runtime.isAvailable(found.helpSessionId);
    },
    isSendAvailable: () => {
      const found = caller();
      return found !== null && found.runtime.isSendAvailable(found.helpSessionId);
    },
    isReachable: () => {
      const found = caller();
      return found !== null && found.runtime.isReachable?.(found.helpSessionId) === true;
    },
    isSendReachable: () => {
      const found = caller();
      return found !== null && found.runtime.isSendReachable?.(found.helpSessionId) === true;
    },
    getInbox: (args) => {
      const found = caller();
      return found === null ? notEligible : found.runtime.getInbox(found.helpSessionId, args);
    },
    reply: (args) => {
      const found = caller();
      return found === null ? notEligible : found.runtime.reply(found.helpSessionId, args);
    },
    sendMessage: (args) => {
      const found = caller();
      return found === null ? notEligible : found.runtime.sendMessage(found.helpSessionId, args);
    },
  };
}

/**
 * Runs one of the messaging tools for the caller's own lane. Arguments are checked
 * against the manifest schema here, since a main-process tool never passes
 * through renderer dispatch; a refusal says what was wrong in fixed words and
 * never repeats what was sent, because refusals reach the audit log.
 */
export function runAssistantMessagingTool(
  toolId: string,
  args: unknown,
  access: AssistantMessagingAccess | undefined
): AssistantMessagingOutcome<
  AssistantGetInboxResult | AssistantReplyResult | AssistantSendMessageResult
> {
  if (access === undefined) {
    return { ok: false, code: "NOT_ELIGIBLE", message: NOT_ELIGIBLE_MESSAGE };
  }
  const invalid = {
    ok: false as const,
    code: "INVALID_ARGS" as const,
    message: INVALID_ARGS_MESSAGE,
  };
  switch (toolId) {
    case ASSISTANT_GET_INBOX_TOOL: {
      const parsed = AssistantGetInboxArgsSchema.safeParse(args ?? {});
      return parsed.success ? access.getInbox(parsed.data) : invalid;
    }
    case ASSISTANT_REPLY_TOOL: {
      const parsed = AssistantReplyArgsSchema.safeParse(args ?? {});
      return parsed.success ? access.reply(parsed.data) : invalid;
    }
    case ASSISTANT_SEND_MESSAGE_TOOL: {
      const parsed = AssistantSendMessageArgsSchema.safeParse(args ?? {});
      return parsed.success ? access.sendMessage(parsed.data) : invalid;
    }
    default:
      return { ok: false, code: "NOT_ELIGIBLE", message: NOT_ELIGIBLE_MESSAGE };
  }
}

export function auditCodeForMessagingRefusal(code: AssistantMessagingRefusalCode): ActionErrorCode {
  switch (code) {
    case "NOT_ELIGIBLE":
      return "RESTRICTED";
    case "UNKNOWN_TASK":
      return "NOT_FOUND";
    case "PAUSED":
      return "RESTRICTED";
    case "UNAVAILABLE":
      return "EXECUTION_ERROR";
    default:
      return "VALIDATION_ERROR";
  }
}
