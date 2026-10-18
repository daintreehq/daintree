import type { ActionErrorCode } from "../../../shared/types/actions.js";
import {
  HOST_CALL_TOOL,
  HOST_CANCEL_TASK_TOOL,
  HOST_GET_TASK_TOOL,
  HOST_LIST_ASSISTANTS_TOOL,
  HOST_LIST_TASKS_TOOL,
  HOST_LIST_TOOL,
  HOST_READ_QUOTA_TOOL,
  HOST_SEND_MESSAGE_TOOL,
  HOST_START_ASSISTANT_TOOL,
  HostCallArgsSchema,
  HostCancelTaskArgsSchema,
  HostGetTaskArgsSchema,
  HostListArgsSchema,
  HostListAssistantsArgsSchema,
  HostListTasksArgsSchema,
  HostReadQuotaArgsSchema,
  HostSendMessageArgsSchema,
  HostStartAssistantArgsSchema,
  type HostCallArgs,
  type HostCallResult,
  type HostCancelTaskArgs,
  type HostCancelTaskResult,
  type HostGetTaskArgs,
  type HostGetTaskResult,
  type HostListAssistantsArgs,
  type HostListAssistantsResult,
  type HostListResult,
  type HostListTasksArgs,
  type HostListTasksResult,
  type HostMessagingOutcome,
  type HostMessagingRefusalCode,
  type HostMessagingToolResult,
  type HostReadQuotaArgs,
  type HostReadQuotaResult,
  type HostSendMessageArgs,
  type HostSendMessageResult,
  type HostStartAssistantArgs,
  type HostStartAssistantResult,
} from "../../../shared/types/hostMessaging.js";

/**
 * What the MCP server needs of the Shell's host messaging runtime (#13336),
 * which Remote Hosts owns and installs (electron/remote/assistant/install.ts).
 * Core code never imports the runtime, so a build or platform without Remote
 * Hosts leaves this empty and offers none of the tools. Every call names the
 * help session it came from; the runtime decides whether that is one of this
 * machine's assistants (#13468).
 */
export interface HostMessagingRuntimeHandle {
  isAvailable(helpSessionId: string): boolean;
  /** Whether this session's tools are offered: from its start, before its run is confirmed. */
  isReachable?(helpSessionId: string): boolean;
  list(helpSessionId: string): Promise<HostMessagingOutcome<HostListResult>>;
  listAssistants(
    helpSessionId: string,
    args: HostListAssistantsArgs
  ): Promise<HostMessagingOutcome<HostListAssistantsResult>>;
  sendMessage(
    helpSessionId: string,
    args: HostSendMessageArgs
  ): Promise<HostMessagingOutcome<HostSendMessageResult>>;
  getTask(
    helpSessionId: string,
    args: HostGetTaskArgs
  ): Promise<HostMessagingOutcome<HostGetTaskResult>>;
  listTasks(
    helpSessionId: string,
    args: HostListTasksArgs
  ): Promise<HostMessagingOutcome<HostListTasksResult>>;
  cancelTask(
    helpSessionId: string,
    args: HostCancelTaskArgs
  ): Promise<HostMessagingOutcome<HostCancelTaskResult>>;
  startAssistant(
    helpSessionId: string,
    args: HostStartAssistantArgs
  ): Promise<HostMessagingOutcome<HostStartAssistantResult>>;
  readQuota(
    helpSessionId: string,
    args: HostReadQuotaArgs
  ): Promise<HostMessagingOutcome<HostReadQuotaResult>>;
  /** Whether this session is offered `host.call` (#13493): from its start, hosts or not. */
  isCallReachable?(helpSessionId: string): boolean;
  call?(
    helpSessionId: string,
    args: HostCallArgs,
    context: HostCallContext
  ): Promise<HostMessagingOutcome<HostCallResult>>;
}

/** What a `host.call` carries from the calling session beyond its arguments. */
export interface HostCallContext {
  /** The tier the call was admitted at here, which is all it may have on the host. */
  tier: "core" | "full";
}

let installedRuntime: HostMessagingRuntimeHandle | null = null;

/** Installs the process's host messaging runtime; the returned call removes it again. */
export function setHostMessagingRuntime(runtime: HostMessagingRuntimeHandle): () => void {
  installedRuntime = runtime;
  return () => {
    if (installedRuntime === runtime) installedRuntime = null;
  };
}

export const HOST_MESSAGING_NOT_ELIGIBLE_MESSAGE =
  "Only a Daintree Assistant running on this machine can reach assistants on other hosts.";
const INVALID_ARGS_MESSAGE = "The arguments don't match this tool's schema.";

/** One MCP session's view of the host messaging runtime, keyed on the help session bound to it. */
export interface HostMessagingAccess {
  /** Whether this session is one of this machine's assistants and a host exists right now. */
  isAvailable(): boolean;
  /** Whether it is an assistant session while a host exists; listing goes by this. */
  isReachable?(): boolean;
  /** Whether it is offered `host.call`: one of this machine's assistants, hosts or not. */
  isCallReachable?(): boolean;
  run(
    toolId: string,
    args: unknown,
    context?: HostCallContext
  ): Promise<HostMessagingOutcome<HostMessagingToolResult>>;
}

function notEligible(): { ok: false; code: "NOT_ELIGIBLE"; message: string } {
  return { ok: false, code: "NOT_ELIGIBLE", message: HOST_MESSAGING_NOT_ELIGIBLE_MESSAGE };
}

function invalidArgs(): { ok: false; code: "INVALID_ARGS"; message: string } {
  return { ok: false, code: "INVALID_ARGS", message: INVALID_ARGS_MESSAGE };
}

/**
 * Arguments are checked against the manifest schema here, since a
 * main-process tool never passes through renderer dispatch; a refusal is fixed
 * text and never repeats what was sent, because refusals reach the audit log.
 */
async function dispatch(
  runtime: HostMessagingRuntimeHandle,
  helpSessionId: string,
  toolId: string,
  args: unknown,
  context: HostCallContext | undefined
): Promise<HostMessagingOutcome<HostMessagingToolResult>> {
  const raw = args ?? {};
  switch (toolId) {
    case HOST_CALL_TOOL: {
      // A call with no tier from its session is no call this machine admitted.
      if (context === undefined || runtime.call === undefined) return notEligible();
      const parsed = HostCallArgsSchema.safeParse(raw);
      return parsed.success ? runtime.call(helpSessionId, parsed.data, context) : invalidArgs();
    }
    case HOST_LIST_TOOL: {
      if (!HostListArgsSchema.safeParse(raw).success) return invalidArgs();
      return runtime.list(helpSessionId);
    }
    case HOST_LIST_ASSISTANTS_TOOL: {
      const parsed = HostListAssistantsArgsSchema.safeParse(raw);
      return parsed.success ? runtime.listAssistants(helpSessionId, parsed.data) : invalidArgs();
    }
    case HOST_SEND_MESSAGE_TOOL: {
      const parsed = HostSendMessageArgsSchema.safeParse(raw);
      return parsed.success ? runtime.sendMessage(helpSessionId, parsed.data) : invalidArgs();
    }
    case HOST_GET_TASK_TOOL: {
      const parsed = HostGetTaskArgsSchema.safeParse(raw);
      return parsed.success ? runtime.getTask(helpSessionId, parsed.data) : invalidArgs();
    }
    case HOST_LIST_TASKS_TOOL: {
      const parsed = HostListTasksArgsSchema.safeParse(raw);
      return parsed.success ? runtime.listTasks(helpSessionId, parsed.data) : invalidArgs();
    }
    case HOST_CANCEL_TASK_TOOL: {
      const parsed = HostCancelTaskArgsSchema.safeParse(raw);
      return parsed.success ? runtime.cancelTask(helpSessionId, parsed.data) : invalidArgs();
    }
    case HOST_START_ASSISTANT_TOOL: {
      const parsed = HostStartAssistantArgsSchema.safeParse(raw);
      return parsed.success ? runtime.startAssistant(helpSessionId, parsed.data) : invalidArgs();
    }
    case HOST_READ_QUOTA_TOOL: {
      const parsed = HostReadQuotaArgsSchema.safeParse(raw);
      return parsed.success ? runtime.readQuota(helpSessionId, parsed.data) : invalidArgs();
    }
    default:
      return invalidArgs();
  }
}

/**
 * Binds one MCP session to the runtime. The help session and the runtime are
 * read live at each call, so a revoked bearer or a stopped runtime refuses at once.
 */
export function bindHostMessaging(
  resolveHelpSessionId: () => string | undefined
): HostMessagingAccess {
  const caller = () => {
    const helpSessionId = resolveHelpSessionId();
    const runtime = installedRuntime;
    return helpSessionId === undefined || runtime === null ? null : { helpSessionId, runtime };
  };
  return {
    isAvailable: () => {
      const found = caller();
      return found !== null && found.runtime.isAvailable(found.helpSessionId);
    },
    isReachable: () => {
      const found = caller();
      return found !== null && found.runtime.isReachable?.(found.helpSessionId) === true;
    },
    isCallReachable: () => {
      const found = caller();
      return found !== null && found.runtime.isCallReachable?.(found.helpSessionId) === true;
    },
    run: async (toolId, args, context) => {
      const found = caller();
      if (found === null) return notEligible();
      return dispatch(found.runtime, found.helpSessionId, toolId, args, context);
    },
  };
}

/** Runs one host tool for the caller's session; no access means the caller isn't an assistant at all. */
export function runHostMessagingTool(
  toolId: string,
  args: unknown,
  access: HostMessagingAccess | undefined,
  context?: HostCallContext
): Promise<HostMessagingOutcome<HostMessagingToolResult>> {
  if (access === undefined) return Promise.resolve(notEligible());
  return context === undefined ? access.run(toolId, args) : access.run(toolId, args, context);
}

export function auditCodeForHostMessagingRefusal(code: HostMessagingRefusalCode): ActionErrorCode {
  switch (code) {
    case "NOT_ELIGIBLE":
      return "RESTRICTED";
    case "UNAVAILABLE":
      return "EXECUTION_ERROR";
    default:
      return "VALIDATION_ERROR";
  }
}
