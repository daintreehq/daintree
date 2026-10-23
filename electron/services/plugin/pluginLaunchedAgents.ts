import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type {
  PluginAgentInputResult,
  PluginAgentInterruptResult,
  PluginAgentKeysInput,
  PluginAgentKeysResult,
} from "../../../shared/types/plugin.js";
import { AGENT_LAUNCH_ACTION_ID } from "../../../shared/utils/dispatchAgentLaunch.js";
import { SendKeysArgsSchema } from "../../../shared/utils/terminalKeys.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import { SEND_TO_AGENT_MAX_ID_LENGTH } from "./sendToAgentLimits.js";

/**
 * The agents a plugin started with its own `agent.launch` (#14018), the only
 * terminals its `host.agents` input methods reach. Main writes a record from
 * the launch's own result, never from anything the plugin says about itself,
 * so an agent the user, an MCP client or another plugin started has none.
 *
 * Keyed by terminal id, like the MCP ownership ledger: a restart or a
 * terminal-host recovery brings the same pane back under the same id, and it
 * stays the plugin's. An exited terminal's record is inert, since nothing can
 * be written to it, and goes when the plugin unloads.
 */
interface PluginLaunchRecord {
  readonly pluginId: string;
  /** The project the launch was sent to; null for an installed plugin's ambient launch. */
  readonly projectId: string | null;
}

const launches = new Map<string, PluginLaunchRecord>();

/**
 * Whether an `agent.launch` asks for a panel id a running terminal already
 * holds. The launch result comes back before its spawn reaches the terminal
 * host, so a result naming that id could be the running terminal's rather than
 * a new one, and is never taken as the plugin's.
 */
export function launchClaimsLiveTerminal(actionId: string, args: unknown): boolean {
  if (actionId !== AGENT_LAUNCH_ACTION_ID || args === null || typeof args !== "object") {
    return false;
  }
  const requestedId = (args as { requestedId?: unknown }).requestedId;
  if (typeof requestedId !== "string") return false;
  return getPtyClient()?.getLiveGeneration(requestedId) != null;
}

/** Record the agent a successful `agent.launch` result says it started. */
export function recordPluginLaunch(
  pluginId: string,
  actionId: string,
  result: ActionDispatchResult,
  projectId: string | null
): void {
  if (actionId !== AGENT_LAUNCH_ACTION_ID || !result.ok) return;
  const launched = result.result as { launched?: unknown; terminalId?: unknown } | null;
  // `launched: false` with an id is a diagnostic panel that started no agent.
  if (launched?.launched !== true) return;
  const terminalId = launched.terminalId;
  if (typeof terminalId !== "string" || terminalId.length === 0) return;
  launches.set(terminalId, { pluginId, projectId });
}

/**
 * The project `terminalId` runs in, when `pluginId` launched it and it runs
 * where the launch was sent; null for anything else. A bound plugin's own
 * project is checked again, so a record can never carry it across projects.
 */
export function launchedAgentProject(
  pluginId: string,
  terminalId: string,
  boundProjectId: string | null
): string | null {
  const record = launches.get(terminalId);
  if (record === undefined || record.pluginId !== pluginId) return null;
  const projectId = getPtyClient()?.getTerminalProjectId(terminalId) ?? null;
  if (projectId === null) return null;
  if (record.projectId !== null && record.projectId !== projectId) return null;
  if (boundProjectId !== null && boundProjectId !== projectId) return null;
  return projectId;
}

/** Drop every agent `pluginId` launched: it no longer reaches them. */
export function forgetPluginLaunches(pluginId: string): void {
  for (const [terminalId, record] of launches) {
    if (record.pluginId === pluginId) launches.delete(terminalId);
  }
}

export function _resetPluginLaunchesForTests(): void {
  launches.clear();
}

/** Check a terminal id passed to a `host.agents` input method. */
export function validateLaunchedAgentId(pluginId: string, op: string, terminalId: unknown): string {
  if (
    typeof terminalId !== "string" ||
    terminalId.length === 0 ||
    terminalId.length > SEND_TO_AGENT_MAX_ID_LENGTH
  ) {
    throw new Error(
      `Plugin "${pluginId}" agents.${op}: terminalId must be a non-empty string of at most ${SEND_TO_AGENT_MAX_ID_LENGTH} characters`
    );
  }
  return terminalId;
}

/** Check `host.agents.sendKeys` input and build the delegate's arguments from it alone. */
export function validateSendKeysCall(
  pluginId: string,
  terminalId: string,
  input: PluginAgentKeysInput
): { terminalId: string; keys: string[] } | { terminalId: string; choose: string } {
  if (input === null || typeof input !== "object") {
    throw new Error(`Plugin "${pluginId}" agents.sendKeys: input must be an object`);
  }
  const { keys, choose } = input as { keys?: unknown; choose?: unknown };
  if ((keys === undefined) === (choose === undefined)) {
    throw new Error(`Plugin "${pluginId}" agents.sendKeys: pass exactly one of keys or choose`);
  }
  // Built field by field, so nothing beyond the keys (a `notify`) reaches the delegate.
  const args =
    keys !== undefined
      ? { terminalId, keys: Array.isArray(keys) ? [...keys] : keys }
      : { terminalId, choose };
  const parsed = SendKeysArgsSchema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Plugin "${pluginId}" agents.sendKeys: ${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`
    );
  }
  return args as { terminalId: string; keys: string[] } | { terminalId: string; choose: string };
}

/**
 * Run one input delegate in main against the terminal host's own record, as an
 * MCP call does for a project with no view: the eligibility rules, key pacing
 * and submission path are the shipped action's, and a terminal in a project
 * whose view is not loaded answers like any other.
 */
async function runDelegate(
  projectId: string,
  actionId: "terminal.interrupt" | "terminal.sendKeys" | "terminal.sendCommand",
  args: Record<string, unknown>
): Promise<ActionDispatchResult | null> {
  const { runViewlessAction } = await import("../viewless/index.js");
  return runViewlessAction({ workspaceId: projectId, actionId, args, confirmed: false });
}

type NotSent = Exclude<PluginAgentInputResult, { status: "sent" }>;

function notSent(result: ActionDispatchResult | null): NotSent | null {
  if (result === null) return { status: "unavailable" };
  if (result.ok) return null;
  return { status: "refused", reason: result.error.message };
}

export async function interruptLaunchedAgent(
  projectId: string,
  terminalId: string
): Promise<PluginAgentInterruptResult> {
  const result = await runDelegate(projectId, "terminal.interrupt", { terminalId });
  const refusal = notSent(result);
  if (refusal) return refusal;
  const status = (result as { ok: true; result: { status?: unknown } }).result.status;
  return { status: "sent", cancelKey: status === "requested" ? "advertised" : "unverified" };
}

export async function sendKeysToLaunchedAgent(
  projectId: string,
  args: { terminalId: string; keys: string[] } | { terminalId: string; choose: string }
): Promise<PluginAgentKeysResult> {
  const result = await runDelegate(projectId, "terminal.sendKeys", args);
  const refusal = notSent(result);
  if (refusal) return refusal;
  // The screen the delegate reads back is left out: what a terminal shows is
  // `terminal:read`'s to hand over, not `agent:input`'s.
  const keys = (result as { ok: true; result: { keys?: unknown } }).result.keys;
  return {
    status: "sent",
    keys: Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [],
  };
}

export async function submitToLaunchedAgent(
  projectId: string,
  terminalId: string,
  text: string
): Promise<PluginAgentInputResult> {
  const result = await runDelegate(projectId, "terminal.sendCommand", {
    terminalId,
    command: text,
  });
  return notSent(result) ?? { status: "sent" };
}
