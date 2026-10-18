import type { ActionErrorCode } from "../../../shared/types/actions.js";
import {
  HOST_CALL_TOOL,
  HOST_LIST_TOOL,
  HostCallArgsSchema,
  HostListArgsSchema,
  type HostCallArgs,
  type HostCallResult,
  type HostControlOutcome,
  type HostControlRefusalCode,
  type HostControlToolResult,
  type HostListResult,
} from "../../../shared/types/hostControl.js";

/**
 * What the MCP server needs of the Shell's host-control runtime (#13493),
 * which Remote Hosts owns and installs (electron/remote/assistant/install.ts).
 * Core code never imports the runtime, so a build or platform without Remote
 * Hosts leaves this empty and offers none of the tools. Every call names the
 * help session it came from; the runtime decides whether that is one of this
 * machine's assistants (#13468).
 */
export interface HostControlRuntimeHandle {
  /** Whether this session is offered the host tools (#13493): from its start, hosts or not. */
  isCallReachable(helpSessionId: string): boolean;
  list(helpSessionId: string): Promise<HostControlOutcome<HostListResult>>;
  call(
    helpSessionId: string,
    args: HostCallArgs,
    context: HostCallContext
  ): Promise<HostControlOutcome<HostCallResult>>;
}

/** What a `host.call` carries from the calling session beyond its arguments. */
export interface HostCallContext {
  /** The tier the call was admitted at here, which is all it may have on the host. */
  tier: "core" | "full";
}

let installedRuntime: HostControlRuntimeHandle | null = null;

/** Installs the process's host-control runtime; the returned call removes it again. */
export function setHostControlRuntime(runtime: HostControlRuntimeHandle): () => void {
  installedRuntime = runtime;
  return () => {
    if (installedRuntime === runtime) installedRuntime = null;
  };
}

export const HOST_CONTROL_NOT_ELIGIBLE_MESSAGE =
  "Only a Daintree Assistant running on this machine can reach its hosts.";
const INVALID_ARGS_MESSAGE = "The arguments don't match this tool's schema.";

/** One MCP session's view of the host-control runtime, keyed on the help session bound to it. */
export interface HostControlAccess {
  /** Whether it is offered the host tools: one of this machine's assistants, hosts or not. */
  isCallReachable(): boolean;
  run(
    toolId: string,
    args: unknown,
    context?: HostCallContext
  ): Promise<HostControlOutcome<HostControlToolResult>>;
}

function notEligible(): { ok: false; code: "NOT_ELIGIBLE"; message: string } {
  return { ok: false, code: "NOT_ELIGIBLE", message: HOST_CONTROL_NOT_ELIGIBLE_MESSAGE };
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
  runtime: HostControlRuntimeHandle,
  helpSessionId: string,
  toolId: string,
  args: unknown,
  context: HostCallContext | undefined
): Promise<HostControlOutcome<HostControlToolResult>> {
  const raw = args ?? {};
  switch (toolId) {
    case HOST_CALL_TOOL: {
      // A call with no tier from its session is no call this machine admitted.
      if (context === undefined) return notEligible();
      const parsed = HostCallArgsSchema.safeParse(raw);
      return parsed.success ? runtime.call(helpSessionId, parsed.data, context) : invalidArgs();
    }
    case HOST_LIST_TOOL: {
      if (!HostListArgsSchema.safeParse(raw).success) return invalidArgs();
      return runtime.list(helpSessionId);
    }
    default:
      return invalidArgs();
  }
}

/**
 * Binds one MCP session to the runtime. The help session and the runtime are
 * read live at each call, so a revoked bearer or a stopped runtime refuses at once.
 */
export function bindHostControl(resolveHelpSessionId: () => string | undefined): HostControlAccess {
  const caller = () => {
    const helpSessionId = resolveHelpSessionId();
    const runtime = installedRuntime;
    return helpSessionId === undefined || runtime === null ? null : { helpSessionId, runtime };
  };
  return {
    isCallReachable: () => {
      const found = caller();
      return found !== null && found.runtime.isCallReachable(found.helpSessionId);
    },
    run: async (toolId, args, context) => {
      const found = caller();
      if (found === null) return notEligible();
      return dispatch(found.runtime, found.helpSessionId, toolId, args, context);
    },
  };
}

/** Runs one host tool for the caller's session; no access means the caller isn't an assistant at all. */
export function runHostControlTool(
  toolId: string,
  args: unknown,
  access: HostControlAccess | undefined,
  context?: HostCallContext
): Promise<HostControlOutcome<HostControlToolResult>> {
  if (access === undefined) return Promise.resolve(notEligible());
  return context === undefined ? access.run(toolId, args) : access.run(toolId, args, context);
}

export function auditCodeForHostControlRefusal(code: HostControlRefusalCode): ActionErrorCode {
  switch (code) {
    case "NOT_ELIGIBLE":
      return "RESTRICTED";
    case "UNAVAILABLE":
      return "EXECUTION_ERROR";
    default:
      return "VALIDATION_ERROR";
  }
}
