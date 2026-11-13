import type { ActionDispatchResult, ActionErrorCode } from "../../../shared/types/actions.js";
import type { PluginAgentInputResult } from "../../../shared/types/plugin.js";
import {
  BUILT_IN_ACTION_IDS,
  DENY_PLUGIN_DISPATCH_ACTION_IDS,
} from "../../../shared/config/actionIds.js";
import { AGENT_LAUNCH_ACTION_ID } from "../../../shared/utils/dispatchAgentLaunch.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { isHostPluginDispatchable } from "../plugins/pluginDispatchAllowlist.js";
import type { PtyClient } from "../../services/PtyClient.js";
import {
  PluginFrontendMethod,
  RemoteDispatchAnswerSchema,
} from "../../services/plugin/pluginFrontendRequests.js";
import {
  interruptLaunchedAgent,
  sendKeysToLaunchedAgent,
  submitToLaunchedAgent,
  validateSendKeysCall,
  type LaunchedAgentPty,
} from "../../services/plugin/pluginLaunchedAgents.js";
import type { ViewlessActionRequest } from "../../services/viewless/ViewlessActionExecutor.js";
import type { LinkSession } from "../link/session.js";
import type { MetricsSessionContext, MetricsSessionSource } from "../metrics/hostMetricsHost.js";
import {
  PLUGIN_CONTROL_CALL_MS,
  PluginControlAgentInputPayloadSchema,
  PluginControlDispatchPayloadSchema,
  PluginControlMethod,
  pluginSenderIdFor,
  type PluginControlAgentInputAnswer,
  type PluginControlAgentInputPayload,
  type PluginControlDispatchPayload,
} from "./linkMethods.js";

/**
 * Where a change to a project stands for a call from one Shell's link session,
 * as the drive lease sees it (`relayWriteRule.ts` reads it the same way).
 */
export type HostPluginStanding =
  | {
      kind: "own-view";
      endpoint: {
        request: (
          method: string,
          payload: unknown,
          options?: { timeoutMs?: number }
        ) => Promise<unknown>;
      };
    }
  | { kind: "vacant" }
  | { kind: "elsewhere"; holderName: string | null }
  | { kind: "unavailable" };

/** One record in this host's plugin audit log for a Shell plugin's call. */
export interface HostPluginAuditEntry {
  pluginId: string;
  /** The Shell's machine name from its handshake: display only, never identity. */
  shellName: string;
  actionId: string;
  args: unknown;
  result: "success" | "error" | "restricted";
  errorMessage: string;
  durationMs: number;
}

export interface HostPluginControlDeps {
  /** This host's "Accept tools run for other machines' assistants" setting, read at each call. */
  acceptsRemoteControl(): boolean;
  hasProject(projectId: string): Promise<boolean>;
  /**
   * Where a change to `projectId` stands for the Shell on `linkSessionId`.
   * Asked with `change` right before the host makes one itself, so the lease
   * hears of it, as it hears of a relayed one.
   */
  standing(projectId: string, linkSessionId: string, change: boolean): HostPluginStanding;
  hasViewlessForm(actionId: string): boolean;
  /** The host's own form of an action, run with no view; null when it has none. */
  runWithoutView(request: ViewlessActionRequest): Promise<ActionDispatchResult | null>;
  audit(entry: HostPluginAuditEntry): void;
  pty(): (LaunchedAgentPty & Pick<PtyClient, "getTerminalProjectId">) | null;
  now?: () => number;
}

/** Who a call came from, as this host established it on the link. */
export interface HostPluginCaller {
  linkSessionId: string;
  shellName: string;
}

/** Agents Shells' plugins launched here, remembered at once; past it the oldest go. */
export const MAX_REMOTE_PLUGIN_LAUNCHES = 512;

const BUILT_IN_ACTIONS: ReadonlySet<string> = new Set(BUILT_IN_ACTION_IDS);
const PLUGIN_DENIED_ACTIONS: ReadonlySet<string> = new Set(DENY_PLUGIN_DISPATCH_ACTION_IDS);

interface RemoteLaunch {
  /** The Shell that launched it, as this host derives it from that Shell's plugin credential. */
  senderId: string;
  pluginId: string;
  projectId: string;
}

function failure(code: ActionErrorCode, message: string): ActionDispatchResult {
  return { ok: false, error: { code, message } };
}

function controlOffMessage(): string {
  return "This host doesn't take actions from other machines. Turn on Accept tools run for other machines' assistants in its Daintree Assistant settings.";
}

function drivenElsewhereMessage(holderName: string | null, stopped: boolean): string {
  const who = holderName
    ? `${holderName} drives this project`
    : "Another screen drives this project";
  return stopped
    ? `${who} now, so the action stopped before changing anything more.`
    : `${who}, so the action wasn't run. Try again once nobody else is driving it.`;
}

/** A change refused, or stopped partway, because someone else drives the project. */
class DrivenElsewhere extends Error {
  constructor(
    readonly holderName: string | null,
    readonly stopped = false
  ) {
    super("DRIVEN_ELSEWHERE");
  }
}

/**
 * What an `agent.launch` the plugin dispatched says it started: the terminal
 * of a launch that started an agent under an id the launcher chose, as
 * `recordPluginLaunch` reads a local one.
 */
function launchedTerminal(
  actionId: string,
  args: unknown,
  result: ActionDispatchResult
): string | null {
  if (actionId !== AGENT_LAUNCH_ACTION_ID || !result.ok) return null;
  if (args !== null && typeof args === "object" && "requestedId" in args) return null;
  const launched = result.result as { launched?: unknown; terminalId?: unknown } | null;
  if (launched?.launched !== true) return null;
  return typeof launched.terminalId === "string" && launched.terminalId.length > 0
    ? launched.terminalId
    : null;
}

/**
 * A host's side of a Shell's installed plugins reaching it (#16767). Each call
 * is that plugin from that Shell: never an assistant's relay principal, sender
 * credential or confirmations preference. It gets the rules a plugin dispatch
 * gets here: built-in actions only, nothing closed to plugin dispatch, nothing
 * confirm-gated (plugins have no confirm path), this host's own consent to
 * other machines' calls, and its drive lease. A change goes through the view
 * that drives the project only when that view is the calling Shell's own, runs
 * in the host itself only while nobody drives it, and is refused otherwise.
 */
export function createHostPluginControl(deps: HostPluginControlDeps) {
  const now = deps.now ?? Date.now;
  const launches = new Map<string, RemoteLaunch>();

  const remember = (terminalId: string, launch: RemoteLaunch): void => {
    launches.delete(terminalId);
    launches.set(terminalId, launch);
    while (launches.size > MAX_REMOTE_PLUGIN_LAUNCHES) {
      const oldest = launches.keys().next().value;
      if (oldest === undefined) break;
      launches.delete(oldest);
    }
  };

  const inView = async (
    endpoint: Extract<HostPluginStanding, { kind: "own-view" }>["endpoint"],
    payload: PluginControlDispatchPayload
  ): Promise<ActionDispatchResult> => {
    let answer: unknown;
    try {
      // The calling Shell's own view runs it as `source: "plugin"`, held to the
      // actions that Shell lets a host's plugins run there.
      answer = await endpoint.request(
        PluginFrontendMethod.DISPATCH,
        { pluginId: payload.pluginId, actionId: payload.actionId, args: payload.args },
        { timeoutMs: PLUGIN_CONTROL_CALL_MS }
      );
    } catch {
      return failure(
        "EXECUTION_ERROR",
        `The view that drives this project couldn't run ${payload.actionId}; it may or may not have run.`
      );
    }
    const parsed = RemoteDispatchAnswerSchema.safeParse(answer);
    return parsed.success
      ? (parsed.data as ActionDispatchResult)
      : failure("EXECUTION_ERROR", `Malformed answer to ${payload.actionId} from the driving view`);
  };

  const withoutView = async (
    caller: HostPluginCaller,
    payload: PluginControlDispatchPayload,
    standing: Exclude<HostPluginStanding, { kind: "own-view" }>
  ): Promise<ActionDispatchResult> => {
    if (!deps.hasViewlessForm(payload.actionId)) {
      return standing.kind === "vacant"
        ? failure(
            "NO_FRONTEND_ATTACHED",
            `${payload.actionId} needs a window showing this project, and none is open.`
          )
        : failure(
            "DRIVEN_ELSEWHERE",
            drivenElsewhereMessage(
              standing.kind === "elsewhere" ? standing.holderName : null,
              false
            )
          );
    }
    // Asked as a change is admitted and again right before each one: a view
    // that takes the lease while this runs stops it before its next change.
    const checkWrite = (changed: boolean): Error | null => {
      const current = deps.standing(payload.projectId, caller.linkSessionId, true);
      if (current.kind === "vacant" || current.kind === "own-view") return null;
      return new DrivenElsewhere(current.kind === "elsewhere" ? current.holderName : null, changed);
    };
    try {
      const result = await deps.runWithoutView({
        workspaceId: payload.projectId,
        actionId: payload.actionId,
        args: payload.args,
        confirmed: false,
        source: "plugin",
        checkWrite,
      });
      return (
        result ??
        failure(
          "NO_FRONTEND_ATTACHED",
          `${payload.actionId} needs a window showing this project, and none is open.`
        )
      );
    } catch (error) {
      if (error instanceof DrivenElsewhere) {
        return failure("DRIVEN_ELSEWHERE", drivenElsewhereMessage(error.holderName, error.stopped));
      }
      throw error;
    }
  };

  const admitAndRun = async (
    caller: HostPluginCaller,
    payload: PluginControlDispatchPayload
  ): Promise<ActionDispatchResult> => {
    if (!deps.acceptsRemoteControl()) return failure("HOST_REFUSED", controlOffMessage());
    // Only this host's own actions, never one a plugin installed here contributes.
    if (!BUILT_IN_ACTIONS.has(payload.actionId)) {
      return failure(
        "RESTRICTED",
        `Action "${payload.actionId}" isn't a built-in action, so a plugin on another machine can't run it here.`
      );
    }
    if (PLUGIN_DENIED_ACTIONS.has(payload.actionId)) {
      return failure(
        "RESTRICTED",
        `Action "${payload.actionId}" is not available to plugin dispatch; use the corresponding capability-gated host API instead.`
      );
    }
    // The audited, default-deny set a host's own plugins may run in a Shell's
    // view, held on every route: what runs here with no view is never wider,
    // and the MCP-session reads that would list this host's own surface stay out.
    if (!isHostPluginDispatchable(payload.actionId)) {
      return failure(
        "RESTRICTED",
        `Action "${payload.actionId}" can't be run by a plugin from another machine.`
      );
    }
    if (!(await deps.hasProject(payload.projectId))) {
      return failure("NOT_FOUND", `This host has no project "${payload.projectId}".`);
    }
    const standing = deps.standing(payload.projectId, caller.linkSessionId, false);
    return standing.kind === "own-view"
      ? inView(standing.endpoint, payload)
      : withoutView(caller, payload, standing);
  };

  return {
    async dispatch(
      caller: HostPluginCaller,
      payload: PluginControlDispatchPayload
    ): Promise<ActionDispatchResult> {
      const startedAt = now();
      const senderId = pluginSenderIdFor(payload.credential);
      const audit = (result: ActionDispatchResult | null, thrown?: unknown): void => {
        const code = result === null ? "ERROR" : result.ok ? "" : result.error.code;
        deps.audit({
          pluginId: payload.pluginId,
          shellName: caller.shellName,
          actionId: `dispatch:${payload.projectId}:${payload.actionId}`,
          args: payload.args,
          result: result?.ok === true ? "success" : code === "RESTRICTED" ? "restricted" : "error",
          errorMessage: thrown === undefined ? code : "ERROR",
          durationMs: now() - startedAt,
        });
      };
      let result: ActionDispatchResult;
      try {
        result = await admitAndRun(caller, payload);
      } catch (error) {
        audit(null, error);
        throw error;
      }
      const terminalId = launchedTerminal(payload.actionId, payload.args, result);
      if (terminalId !== null) {
        remember(terminalId, {
          senderId,
          pluginId: payload.pluginId,
          projectId: payload.projectId,
        });
      }
      audit(result);
      return result;
    },

    async agentInput(
      caller: HostPluginCaller,
      payload: PluginControlAgentInputPayload
    ): Promise<PluginControlAgentInputAnswer> {
      const startedAt = now();
      const senderId = pluginSenderIdFor(payload.credential);
      const { terminalId, pluginId, input } = payload;
      const answer = await (async (): Promise<PluginControlAgentInputAnswer> => {
        if (!deps.acceptsRemoteControl()) return { status: "refused", reason: controlOffMessage() };
        const launch = launches.get(terminalId);
        // Only the agent this plugin launched here from this Shell: another
        // plugin's, another Shell's, or one nobody launched through here reads
        // as no such agent.
        if (launch === undefined || launch.senderId !== senderId || launch.pluginId !== pluginId) {
          return { status: "not-found" };
        }
        const pty = deps.pty();
        if (pty === null) return { status: "unavailable" };
        const owns = (): boolean =>
          launches.get(terminalId) === launch &&
          pty.getTerminalProjectId(terminalId) === launch.projectId;
        if (!owns()) return { status: "not-found" };
        const admitWrite = async (): Promise<boolean> => {
          if (!deps.acceptsRemoteControl() || !owns()) return false;
          const standing = deps.standing(launch.projectId, caller.linkSessionId, true);
          if (standing.kind === "own-view" || standing.kind === "vacant") return true;
          throw new DrivenElsewhere(standing.kind === "elsewhere" ? standing.holderName : null);
        };
        try {
          let result: PluginAgentInputResult | { status: "sent"; [key: string]: unknown };
          switch (input.op) {
            case "interrupt":
              result = await interruptLaunchedAgent(pty, terminalId, admitWrite);
              break;
            case "sendKeys": {
              let keys: ReturnType<typeof validateSendKeysCall>;
              try {
                keys = validateSendKeysCall(
                  pluginId,
                  terminalId,
                  "keys" in input ? { keys: input.keys } : { choose: input.choose }
                );
              } catch (error) {
                return {
                  status: "refused",
                  reason: formatErrorMessage(error, "Those keys can't be pressed."),
                };
              }
              result = await sendKeysToLaunchedAgent(pty, terminalId, keys, admitWrite);
              break;
            }
            case "submit":
              result = await submitToLaunchedAgent(pty, terminalId, input.text, admitWrite);
              break;
          }
          return result as PluginControlAgentInputAnswer;
        } catch (error) {
          if (error instanceof DrivenElsewhere) {
            return { status: "driven-elsewhere", holderName: error.holderName };
          }
          throw error;
        }
      })();
      deps.audit({
        pluginId,
        shellName: caller.shellName,
        actionId: `agents.${input.op}:${terminalId}`,
        args: null,
        result: answer.status === "sent" ? "success" : "error",
        errorMessage: answer.status === "sent" ? "" : answer.status,
        durationMs: now() - startedAt,
      });
      return answer;
    },

    /** Whether a Shell's plugin launched this agent here: for tests and diagnostics. */
    launchedBy(terminalId: string): { pluginId: string; projectId: string } | null {
      const launch = launches.get(terminalId);
      return launch ? { pluginId: launch.pluginId, projectId: launch.projectId } : null;
    },

    dispose(): void {
      launches.clear();
    },
  };
}

export type HostPluginControl = ReturnType<typeof createHostPluginControl>;

/**
 * Takes Shells' plugin calls on every link session (#16767). Registering the
 * two handlers is all it does until a Shell's plugin calls: the record of what
 * those plugins launched here is made on the first call, so a host no Shell's
 * plugin reaches keeps nothing.
 */
export function installHostPluginControl(
  server: MetricsSessionSource,
  deps: HostPluginControlDeps
): () => void {
  let control: HostPluginControl | null = null;
  let disposed = false;
  const wired = new WeakSet<LinkSession>();
  const live = (): HostPluginControl => {
    if (disposed) throw new Error("Plugin control is shutting down");
    control ??= createHostPluginControl(deps);
    return control;
  };
  const wire = ({ session, sessionId, client }: MetricsSessionContext): void => {
    if (wired.has(session)) return;
    wired.add(session);
    const caller = (): HostPluginCaller => ({
      linkSessionId: sessionId,
      shellName: client?.clientName || "Remote Shell",
    });
    session.registerCallHandler(
      PluginControlMethod.DISPATCH,
      PluginControlDispatchPayloadSchema,
      (payload) => live().dispatch(caller(), payload)
    );
    session.registerCallHandler(
      PluginControlMethod.AGENT_INPUT,
      PluginControlAgentInputPayloadSchema,
      (payload) => live().agentInput(caller(), payload)
    );
  };
  for (const ctx of server.sessions) wire(ctx);
  const off = server.onSession(wire);
  return () => {
    disposed = true;
    off();
    control?.dispose();
    control = null;
  };
}

/**
 * Where a change to `projectId` stands for the Shell on `linkSessionId`, read
 * from the drive lease the way a relayed call's is (`relayWriteRule.ts`), but
 * keeping the driving endpoint, since that is where an own-view call goes.
 */
export function leaseStanding(
  resolve: typeof import("../../services/mcp-server/driveTarget.js").resolveMcpDriveTarget,
  projectId: string,
  linkSessionId: string,
  change: boolean
): HostPluginStanding {
  const target = resolve(projectId, change ? { linkSessionId } : undefined);
  // No lease installed: nothing on this machine acts for another one.
  if (target === null) return { kind: "elsewhere", holderName: null };
  if (target.state === "vacant") return { kind: "vacant" };
  if (target.state === "unavailable") return { kind: "unavailable" };
  if (target.endpoint.kind === "remote-view" && target.endpoint.linkSessionId === linkSessionId) {
    return { kind: "own-view", endpoint: target.endpoint };
  }
  return { kind: "elsewhere", holderName: target.holderName ?? null };
}

/**
 * The record this host's plugin audit log keeps for a Shell plugin's call: the
 * plugin's own id, with the Shell it came from beside it, so it is never read
 * as a plugin installed here.
 */
export function auditRecordFor(entry: HostPluginAuditEntry, argsHash: string) {
  return {
    pluginId: entry.pluginId,
    actionId: entry.actionId,
    recordType: "ipc-invoke" as const,
    channel: HOST_PLUGIN_AUDIT_CHANNEL,
    remoteShell: entry.shellName,
    argsHash,
    durationMs: entry.durationMs,
    result: entry.result,
    errorMessage: entry.errorMessage,
  };
}

/** The audit channel a Shell plugin's calls are recorded under on a host. */
export const HOST_PLUGIN_AUDIT_CHANNEL = "plugin:remote-shell";
