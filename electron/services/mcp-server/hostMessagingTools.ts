import type { ActionErrorCode } from "../../../shared/types/actions.js";
import {
  HOST_CANCEL_TASK_TOOL,
  HOST_GET_TASK_TOOL,
  HOST_LIST_ASSISTANTS_TOOL,
  HOST_LIST_TASKS_TOOL,
  HOST_LIST_TOOL,
  HOST_SEND_MESSAGE_TOOL,
  HOST_START_ASSISTANT_TOOL,
  HostCancelTaskArgsSchema,
  HostGetTaskArgsSchema,
  HostListArgsSchema,
  HostListAssistantsArgsSchema,
  HostListTasksArgsSchema,
  HostSendMessageArgsSchema,
  HostStartAssistantArgsSchema,
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
  type HostSendMessageArgs,
  type HostSendMessageResult,
  type HostStartAssistantArgs,
  type HostStartAssistantResult,
} from "../../../shared/types/hostMessaging.js";

/**
 * What the MCP server needs of the hub's messaging runtime (#13336), which
 * Remote Hosts owns and installs (electron/remote/assistant/install.ts). Core
 * code never imports the runtime, so a build or platform without Remote Hosts
 * leaves this empty and offers none of the tools. Every call names the help
 * session it came from; the runtime decides whether that is the hub.
 */
export interface HostMessagingRuntimeHandle {
  isAvailable(helpSessionId: string): boolean;
  /** Whether this session could become the hub: offered from its start, refused until it is. */
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
}

let installedRuntime: HostMessagingRuntimeHandle | null = null;

/** Installs the process's hub messaging runtime; the returned call removes it again. */
export function setHostMessagingRuntime(runtime: HostMessagingRuntimeHandle): () => void {
  installedRuntime = runtime;
  return () => {
    if (installedRuntime === runtime) installedRuntime = null;
  };
}

export const HOST_MESSAGING_NOT_ELIGIBLE_MESSAGE =
  "Only this Shell's hub assistant, in the session it was enrolled with, can reach assistants on other hosts.";
const INVALID_ARGS_MESSAGE = "The arguments don't match this tool's schema.";

/** One MCP session's view of the hub runtime, keyed on the help session bound to it. */
export interface HostMessagingAccess {
  /** Whether this session is the hub and a host exists right now. */
  isAvailable(): boolean;
  /** Whether it could become the hub while a host exists; listing goes by this. */
  isReachable?(): boolean;
  run(toolId: string, args: unknown): Promise<HostMessagingOutcome<HostMessagingToolResult>>;
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
  args: unknown
): Promise<HostMessagingOutcome<HostMessagingToolResult>> {
  const raw = args ?? {};
  switch (toolId) {
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
    run: async (toolId, args) => {
      const found = caller();
      if (found === null) return notEligible();
      return dispatch(found.runtime, found.helpSessionId, toolId, args);
    },
  };
}

/** Runs one hub tool for the caller's session; no access means the caller isn't a hub at all. */
export function runHostMessagingTool(
  toolId: string,
  args: unknown,
  access: HostMessagingAccess | undefined
): Promise<HostMessagingOutcome<HostMessagingToolResult>> {
  if (access === undefined) return Promise.resolve(notEligible());
  return access.run(toolId, args);
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
