import type { z } from "zod";
import type { ActionErrorCode } from "../../../shared/types/actions.js";
import {
  HOST_THROWAWAY_TOOL_SIGNATURES,
  HostThrowawayCallSchema,
} from "../../../shared/types/hostThrowaway.js";
import {
  HOST_BRING_BACK_TOOL,
  HOST_CALL_TOOL,
  HOST_ENSURE_PROJECT_TOOL,
  HOST_LIST_TOOL,
  HOST_SETTINGS_TOOL,
  HOST_STATUS_TOOL,
  HOST_WATCH_TOOL,
  HostBringBackArgsSchema,
  HostCallArgsSchema,
  HostEnsureProjectArgsSchema,
  HostListArgsSchema,
  HostSettingsArgsSchema,
  HostStatusArgsSchema,
  HostWatchArgsSchema,
  type HostBringBackArgs,
  type HostBringBackResult,
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
  type HostStatusArgs,
  type HostStatusResult,
  type HostWatchArgs,
  type HostWatchResult,
} from "../../../shared/types/hostControl.js";
import type { HostInventorySnapshot } from "../globalAssistantInventory.js";
import { describeArgsIssue } from "./fixedArgsIssue.js";

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
  /**
   * Why this session can't call the host tools right now, in fixed words that
   * say what it lacks; null when it can. Asked before any arguments are read
   * (#18164), so a caller that can't call is told so whatever it sent.
   */
  callerRefusal(helpSessionId: string): string | null;
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
    args: HostSettingsArgs,
    context?: HostSettingsContext
  ): Promise<HostControlOutcome<HostSettingsResult>>;
  /**
   * Arms, cancels or lists the calling run's one-shot watches on a host's link
   * or capacity (#14463), or on agents starting to wait (#16188).
   */
  watch(helpSessionId: string, args: HostWatchArgs): Promise<HostControlOutcome<HostWatchResult>>;
  /** Tries to bring back a host whose link is down, waking and starting it where it can (#16170). */
  bringBack(
    helpSessionId: string,
    args: HostBringBackArgs
  ): Promise<HostControlOutcome<HostBringBackResult>>;
  /** `terminal.getStatus` in many projects on many hosts, in one answer (#16191). */
  status(
    helpSessionId: string,
    args: HostStatusArgs,
    context: HostCallContext
  ): Promise<HostControlOutcome<HostStatusResult>>;
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
  /**
   * The calling request's own abort (#17985): a `host.call` cancelled by its
   * MCP client is cancelled on the host too.
   */
  signal?: AbortSignal;
}

/** What a `host.settings` call carries from the calling session beyond its arguments. */
export interface HostSettingsContext {
  /**
   * Told when an apply went ahead without asking, because the person handed
   * host settings changes to their assistant here (#16752): for its audit record.
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
/** An assistant's call with no host-control runtime to take it: none installed, or one stopped. */
export const HOST_CONTROL_UNAVAILABLE_MESSAGE =
  "Host tools aren't available on this machine right now.";
/** A `host.call` or `host.status` from a session admitted at neither assistant tier. */
const TIER_NOT_ELIGIBLE_MESSAGE =
  "This tool needs a session at the core or full tool set, and this one has neither.";
const INVALID_ARGS_LEAD = "The arguments don't match this tool's schema";
const INVALID_ARGS_MESSAGE = `${INVALID_ARGS_LEAD}.`;
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

function notEligible(message = HOST_CONTROL_NOT_ELIGIBLE_MESSAGE): {
  ok: false;
  code: "NOT_ELIGIBLE";
  message: string;
} {
  return { ok: false, code: "NOT_ELIGIBLE", message };
}

function invalidArgs(message = INVALID_ARGS_MESSAGE): {
  ok: false;
  code: "INVALID_ARGS";
  message: string;
} {
  return { ok: false, code: "INVALID_ARGS", message };
}

/** The first field a parse refused, named by the schema and never by what was sent (#18164). */
function parseRefusal(schema: z.ZodType, raw: unknown, error: z.ZodError) {
  return invalidArgs(describeArgsIssue(schema, raw, error, INVALID_ARGS_LEAD));
}

/**
 * A throwaway call that broke its own rule (#14446): the field a known tool's
 * arguments got wrong, or the tools it takes when it named none of them.
 */
function throwawayRefusal(tool: unknown, args: unknown) {
  const call = { tool, args: args ?? {} };
  const parsed = HostThrowawayCallSchema.safeParse(call);
  if (parsed.success || parsed.error.issues[0]?.path[0] === "tool") {
    return invalidArgs(INVALID_THROWAWAY_MESSAGE);
  }
  return invalidArgs(
    describeArgsIssue(HostThrowawayCallSchema, call, parsed.error, INVALID_ARGS_LEAD)
  );
}

/** Fields that each parse but don't go together for the operation named, a schema value. */
function operationMisfit(operation: string) {
  return invalidArgs(
    `${INVALID_ARGS_LEAD}: these fields don't go together for operation "${operation}". Each field's description says which operations take it.`
  );
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

/**
 * An arm names one kind of condition, and a host unless it watches agents,
 * which may cover every host, or plugins' notifications, which are this
 * machine's; cancel, list and read take only their own.
 */
function watchArgsFit(args: HostWatchArgs): boolean {
  const capacity =
    args.memoryAvailableBytesAtLeast !== undefined ||
    args.cpuIdleCoresAtLeast !== undefined ||
    args.memoryPressureAtMost !== undefined;
  const agents = args.agentsWaiting === true;
  const plugins = args.pluginNotifications === true;
  const armOnly =
    capacity ||
    agents ||
    plugins ||
    args.waitingReasons !== undefined ||
    args.projectId !== undefined ||
    args.pluginId !== undefined ||
    args.connection !== undefined ||
    args.expiresInSeconds !== undefined ||
    args.note !== undefined;
  switch (args.operation) {
    case "arm":
      if (args.watchId !== undefined || args.notificationId !== undefined) return false;
      if (agents) {
        return (
          !plugins && args.pluginId === undefined && args.connection === undefined && !capacity
        );
      }
      if (plugins) {
        return (
          args.hostId === undefined &&
          args.waitingReasons === undefined &&
          args.connection === undefined &&
          !capacity
        );
      }
      return (
        args.hostId !== undefined &&
        args.waitingReasons === undefined &&
        args.projectId === undefined &&
        args.pluginId === undefined &&
        (args.connection !== undefined) !== capacity
      );
    case "cancel":
      return (
        args.watchId !== undefined &&
        args.hostId === undefined &&
        args.notificationId === undefined &&
        !armOnly
      );
    case "list":
      return args.watchId === undefined && args.notificationId === undefined && !armOnly;
    case "read":
      return (
        args.notificationId !== undefined &&
        args.watchId === undefined &&
        args.hostId === undefined &&
        !armOnly
      );
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
      if (context === undefined) return notEligible(TIER_NOT_ELIGIBLE_MESSAGE);
      const parsed = HostCallArgsSchema.safeParse(raw);
      if (parsed.success) return runtime.call(helpSessionId, parsed.data, context);
      // A throwaway call with one target whose first failure is a rule across
      // its fields broke the throwaway rule: it is told what that rule wants.
      // Anything it got wrong first is named like any call's.
      const first = parsed.error.issues[0];
      const sent = raw as {
        throwaway?: unknown;
        projectId?: unknown;
        tool?: unknown;
        args?: unknown;
      };
      const throwawayRule =
        sent.throwaway === true &&
        sent.projectId === undefined &&
        first?.code === "custom" &&
        first.path.length === 0;
      return throwawayRule
        ? throwawayRefusal(sent.tool, sent.args)
        : parseRefusal(HostCallArgsSchema, raw, parsed.error);
    }
    case HOST_ENSURE_PROJECT_TOOL: {
      const parsed = HostEnsureProjectArgsSchema.safeParse(raw);
      return parsed.success
        ? runtime.ensureProject(helpSessionId, parsed.data)
        : parseRefusal(HostEnsureProjectArgsSchema, raw, parsed.error);
    }
    case HOST_SETTINGS_TOOL: {
      const parsed = HostSettingsArgsSchema.safeParse(raw);
      if (!parsed.success) return parseRefusal(HostSettingsArgsSchema, raw, parsed.error);
      if (!settingsArgsFit(parsed.data)) return operationMisfit(parsed.data.operation);
      return context === undefined
        ? runtime.settings(helpSessionId, parsed.data)
        : runtime.settings(helpSessionId, parsed.data, context);
    }
    case HOST_WATCH_TOOL: {
      const parsed = HostWatchArgsSchema.safeParse(raw);
      if (!parsed.success) return parseRefusal(HostWatchArgsSchema, raw, parsed.error);
      return watchArgsFit(parsed.data)
        ? runtime.watch(helpSessionId, parsed.data)
        : operationMisfit(parsed.data.operation);
    }
    case HOST_LIST_TOOL: {
      const parsed = HostListArgsSchema.safeParse(raw);
      return parsed.success
        ? runtime.list(helpSessionId, parsed.data)
        : parseRefusal(HostListArgsSchema, raw, parsed.error);
    }
    case HOST_BRING_BACK_TOOL: {
      const parsed = HostBringBackArgsSchema.safeParse(raw);
      return parsed.success
        ? runtime.bringBack(helpSessionId, parsed.data)
        : parseRefusal(HostBringBackArgsSchema, raw, parsed.error);
    }
    case HOST_STATUS_TOOL: {
      // Each project is read at the tier the call was admitted at here, as `host.call` is.
      if (context === undefined) return notEligible(TIER_NOT_ELIGIBLE_MESSAGE);
      const parsed = HostStatusArgsSchema.safeParse(raw);
      return parsed.success
        ? runtime.status(helpSessionId, parsed.data, context)
        : parseRefusal(HostStatusArgsSchema, raw, parsed.error);
    }
    default:
      return invalidArgs();
  }
}

/**
 * Binds one MCP session to the runtime. The help session and the runtime are
 * read live at each call, so a revoked bearer or a stopped runtime refuses at
 * once, and a session that can't call is refused before its arguments are read.
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
      if (found === null) {
        // An assistant is told the tools are missing here, not that it isn't one.
        return resolveHelpSessionId() === undefined
          ? notEligible()
          : notEligible(HOST_CONTROL_UNAVAILABLE_MESSAGE);
      }
      const refusal = found.runtime.callerRefusal(found.helpSessionId);
      if (refusal !== null) return notEligible(refusal);
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
