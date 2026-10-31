import type { ActionErrorCode } from "../../../shared/types/actions.js";
import { HOST_THROWAWAY_TOOL_SIGNATURES } from "../../../shared/types/hostThrowaway.js";
import {
  HOST_CALL_TOOL,
  HOST_ENSURE_PROJECT_TOOL,
  HOST_LIST_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_WATCH_TOOL,
  HostCallArgsSchema,
  HostEnsureProjectArgsSchema,
  HostListArgsSchema,
  HostSettingsArgsSchema,
  HostWatchArgsSchema,
  type HostCallArgs,
  type HostCallResult,
  type HostControlOutcome,
  type HostControlRefusalCode,
  type HostControlToolResult,
  type HostEnsureProjectArgs,
  type HostEnsureProjectResult,
  type HostListArgs,
  type HostListResult,
  type HostSettingsArgs,
  type HostSettingsResult,
  type HostWatchArgs,
  type HostWatchResult,
} from "../../../shared/types/hostControl.js";
import type { HostInventorySnapshot } from "../globalAssistantInventory.js";

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
  list(helpSessionId: string, args: HostListArgs): Promise<HostControlOutcome<HostListResult>>;
  call(
    helpSessionId: string,
    args: HostCallArgs,
    context: HostCallContext
  ): Promise<HostControlOutcome<HostCallResult>>;
  /** Puts the calling assistant's own project on a host, with no window (#14140). */
  ensureProject(
    helpSessionId: string,
    args: HostEnsureProjectArgs
  ): Promise<HostControlOutcome<HostEnsureProjectResult>>;
  /** Reads, previews and applies a host's named settings, asking the person before any change (#14167). */
  settings(
    helpSessionId: string,
    args: HostSettingsArgs
  ): Promise<HostControlOutcome<HostSettingsResult>>;
  /** Arms, cancels or lists the calling run's one-shot watches on a host's link or capacity (#14463). */
  watch(helpSessionId: string, args: HostWatchArgs): Promise<HostControlOutcome<HostWatchResult>>;
  /** The hosts and projects the global assistant starts knowing (#14547); never dials a host. */
  inventory?(): Promise<HostInventorySnapshot>;
}

/** What a `host.call` carries from the calling session beyond its arguments. */
export interface HostCallContext {
  /** The tier the call was admitted at here, which is all it may have on the host. */
  tier: "core" | "full";
  /**
   * Told when the call ran on the host under this machine's own skip
   * preference (#15698), never anything the host said: for its audit record.
   */
  noteSkipPreference?: () => void;
}

let installedRuntime: HostControlRuntimeHandle | null = null;

/** Installs the process's host-control runtime; the returned call removes it again. */
export function setHostControlRuntime(runtime: HostControlRuntimeHandle): () => void {
  installedRuntime = runtime;
  return () => {
    if (installedRuntime === runtime) installedRuntime = null;
  };
}

/**
 * The global assistant's launch snapshot (#14547), or null when no runtime is
 * installed or it couldn't be read: the assistant is then told to ask
 * `host.list`, never that there are no hosts.
 */
export async function readHostInventory(): Promise<HostInventorySnapshot | null> {
  const read = installedRuntime?.inventory;
  if (!installedRuntime || !read) return null;
  try {
    return await read.call(installedRuntime);
  } catch (error) {
    console.warn("[HostControl] Couldn't read the host inventory:", error);
    return null;
  }
}

export const HOST_CONTROL_NOT_ELIGIBLE_MESSAGE =
  "Only a Daintree Assistant running on this machine can reach its hosts.";
const INVALID_ARGS_MESSAGE = "The arguments don't match this tool's schema.";
/** Why a throwaway call didn't parse (#14446): only its own tools, named so the caller can pick one. */
const INVALID_THROWAWAY_MESSAGE = `A throwaway call names no projectId and takes only these tools, with these args: ${HOST_THROWAWAY_TOOL_SIGNATURES}. Project tools need a projectId instead.`;

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

function invalidArgs(message = INVALID_ARGS_MESSAGE): {
  ok: false;
  code: "INVALID_ARGS";
  message: string;
} {
  return { ok: false, code: "INVALID_ARGS", message };
}

/** Each operation takes its own arguments and no other's, so an apply carries nothing but its ticket. */
function settingsArgsFit(args: HostSettingsArgs): boolean {
  switch (args.operation) {
    case "read":
      return (
        args.hostIds !== undefined &&
        (args.keys === undefined || args.keys.length > 0) &&
        args.patch === undefined &&
        args.ticket === undefined
      );
    case "preview":
      return (
        args.hostIds !== undefined &&
        args.patch !== undefined &&
        Object.keys(args.patch).length > 0 &&
        args.keys === undefined &&
        args.ticket === undefined
      );
    case "apply":
      return (
        args.ticket !== undefined &&
        args.hostIds === undefined &&
        args.keys === undefined &&
        args.patch === undefined
      );
  }
}

/** An arm names a host and one kind of condition; cancel and list take only their own. */
function watchArgsFit(args: HostWatchArgs): boolean {
  const capacity =
    args.memoryAvailableBytesAtLeast !== undefined ||
    args.cpuIdleCoresAtLeast !== undefined ||
    args.memoryPressureAtMost !== undefined;
  const armOnly =
    capacity ||
    args.connection !== undefined ||
    args.expiresInSeconds !== undefined ||
    args.note !== undefined;
  switch (args.operation) {
    case "arm":
      return (
        args.hostId !== undefined &&
        args.watchId === undefined &&
        (args.connection !== undefined) !== capacity
      );
    case "cancel":
      return args.watchId !== undefined && args.hostId === undefined && !armOnly;
    case "list":
      return args.watchId === undefined && !armOnly;
  }
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
      if (parsed.success) return runtime.call(helpSessionId, parsed.data, context);
      const throwaway = (raw as { throwaway?: unknown } | null)?.throwaway === true;
      return invalidArgs(throwaway ? INVALID_THROWAWAY_MESSAGE : INVALID_ARGS_MESSAGE);
    }
    case HOST_ENSURE_PROJECT_TOOL: {
      const parsed = HostEnsureProjectArgsSchema.safeParse(raw);
      return parsed.success ? runtime.ensureProject(helpSessionId, parsed.data) : invalidArgs();
    }
    case HOST_SETTINGS_TOOL: {
      const parsed = HostSettingsArgsSchema.safeParse(raw);
      return parsed.success && settingsArgsFit(parsed.data)
        ? runtime.settings(helpSessionId, parsed.data)
        : invalidArgs();
    }
    case HOST_WATCH_TOOL: {
      const parsed = HostWatchArgsSchema.safeParse(raw);
      return parsed.success && watchArgsFit(parsed.data)
        ? runtime.watch(helpSessionId, parsed.data)
        : invalidArgs();
    }
    case HOST_LIST_TOOL: {
      const parsed = HostListArgsSchema.safeParse(raw);
      return parsed.success ? runtime.list(helpSessionId, parsed.data) : invalidArgs();
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
