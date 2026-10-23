import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import type {
  PluginAgentInputResult,
  PluginAgentInterruptResult,
  PluginAgentKeysInput,
  PluginAgentKeysResult,
} from "../../../shared/types/plugin.js";
import { isBuiltInAgentId } from "../../../shared/config/agentIds.js";
import { panelKindHasPty } from "../../../shared/config/panelKindRegistry.js";
import { readTailSnapshot, tailCapturedOutput } from "../../../shared/utils/artifactParser.js";
import { AGENT_LAUNCH_ACTION_ID } from "../../../shared/utils/dispatchAgentLaunch.js";
import { planChoice } from "../../../shared/utils/terminalChoice.js";
import { assessInterruptCandidate } from "../../../shared/utils/terminalInterrupt.js";
import {
  CHOOSE_SCREEN_LINES,
  keySequence,
  SEND_KEYS_GAP_MS,
  SendKeysArgsSchema,
} from "../../../shared/utils/terminalKeys.js";
import type { PtyClient } from "../PtyClient.js";
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
 * Record the agent a successful `agent.launch` result says it started.
 *
 * A launch that names its own panel id is never recorded. Its result comes back
 * before its spawn reaches the terminal host, so the id it reports can be one
 * another view holds or a user's pane will take again on restart. Without one,
 * the launcher mints the id itself and nobody else can be holding it.
 */
export function recordPluginLaunch(
  pluginId: string,
  actionId: string,
  args: unknown,
  result: ActionDispatchResult,
  projectId: string | null
): void {
  if (actionId !== AGENT_LAUNCH_ACTION_ID || !result.ok) return;
  if (args !== null && typeof args === "object" && "requestedId" in args) return;
  const launched = result.result as { launched?: unknown; terminalId?: unknown } | null;
  // `launched: false` with an id is a diagnostic panel that started no agent.
  if (launched?.launched !== true) return;
  const terminalId = launched.terminalId;
  if (typeof terminalId !== "string" || terminalId.length === 0) return;
  launches.set(terminalId, { pluginId, projectId });
}

/**
 * The project `terminalId` runs in, when `pluginId` launched it and it runs
 * where the launch was sent; null for anything else, a terminal the host
 * doesn't track included. A bound plugin's own project is checked again, so a
 * record can never carry it across projects.
 */
export function launchedAgentProject(
  pty: Pick<PtyClient, "getTerminalProjectId">,
  pluginId: string,
  terminalId: string,
  boundProjectId: string | null
): string | null {
  const record = launches.get(terminalId);
  if (record === undefined || record.pluginId !== pluginId) return null;
  const projectId = pty.getTerminalProjectId(terminalId);
  if (projectId === null) return null;
  if (record.projectId !== null && record.projectId !== projectId) return null;
  if (boundProjectId !== null && boundProjectId !== projectId) return null;
  return projectId;
}

/** Drop every agent the matching plugin instances launched: they no longer reach them. */
export function forgetPluginLaunchesWhere(matches: (pluginId: string) => boolean): void {
  for (const [terminalId, record] of launches) {
    if (matches(record.pluginId)) launches.delete(terminalId);
  }
}

export function forgetPluginLaunches(pluginId: string): void {
  forgetPluginLaunchesWhere((id) => id === pluginId);
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

export type LaunchedAgentKeys = { keys: string[] } | { choose: string };

/** Check `host.agents.sendKeys` input, keeping nothing beyond the keys or the label. */
export function validateSendKeysCall(
  pluginId: string,
  terminalId: string,
  input: PluginAgentKeysInput
): LaunchedAgentKeys {
  if (input === null || typeof input !== "object") {
    throw new Error(`Plugin "${pluginId}" agents.sendKeys: input must be an object`);
  }
  const { keys, choose } = input as { keys?: unknown; choose?: unknown };
  if ((keys === undefined) === (choose === undefined)) {
    throw new Error(`Plugin "${pluginId}" agents.sendKeys: pass exactly one of keys or choose`);
  }
  // A dense copy, so a sparse array's holes are refused rather than skipped.
  // The schema below proves the shape the casts claim.
  const picked =
    keys !== undefined
      ? { keys: (Array.isArray(keys) ? Array.from(keys as unknown[]) : keys) as string[] }
      : { choose: choose as string };
  const parsed = SendKeysArgsSchema.safeParse({ terminalId, ...picked });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Plugin "${pluginId}" agents.sendKeys: ${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}`
    );
  }
  return picked;
}

/**
 * The terminal-host calls the input methods make. The input runs in main
 * against the host's own record, as `sendToActiveAgent` does, rather than
 * through the terminal IPC handlers: those hold a write to the view that sent
 * it, and a host-side call has none, so in Host mode they would drop it while a
 * Shell drives the project. The plugin's call was held to the drive lease
 * before it got here. The eligibility rules are the shipped actions', from the
 * same shared helpers.
 */
export type LaunchedAgentPty = Pick<
  PtyClient,
  "getTerminalAsync" | "getSerializedStateAsync" | "write" | "submit" | "batchDoubleEscape"
>;

/**
 * Whether the call may still write. Asked right before each write, after every
 * await, so an unload or a lost record stops a call partway rather than letting
 * a paced key sequence finish for a plugin that is gone.
 */
export type StillAllowed = () => boolean;

type TerminalRecord = NonNullable<Awaited<ReturnType<LaunchedAgentPty["getTerminalAsync"]>>>;

const UNAVAILABLE = { status: "unavailable" } as const;

function refused(reason: string): { status: "refused"; reason: string } {
  return { status: "refused", reason };
}

/** The agent a record runs, by the rule a view's chrome applies; built-in agents only. */
function runtimeAgentId(record: TerminalRecord) {
  if (isBuiltInAgentId(record.detectedAgentId)) return record.detectedAgentId;
  const exited = record.isExited === true || record.agentState === "exited";
  return !exited && isBuiltInAgentId(record.launchAgentId) ? record.launchAgentId : undefined;
}

function hasLiveProcess(record: TerminalRecord): boolean {
  return panelKindHasPty(record.kind ?? "terminal") && record.hasPty !== false && !record.isExited;
}

export async function interruptLaunchedAgent(
  pty: LaunchedAgentPty,
  terminalId: string,
  stillAllowed: StillAllowed
): Promise<PluginAgentInterruptResult> {
  // Null for a terminal main still tracks means the host did not answer.
  const record = await pty.getTerminalAsync(terminalId);
  if (record === null) return UNAVAILABLE;
  const assessment = assessInterruptCandidate(
    {
      isPty: panelKindHasPty(record.kind ?? "terminal"),
      trashed: record.isTrashed === true,
      hasPty: record.hasPty,
      exited: record.isExited === true,
      agentId: runtimeAgentId(record),
      agentState: record.agentState,
      waitingReason: record.waitingReason,
    },
    terminalId
  );
  if (!assessment.eligible) return refused(assessment.reason);
  if (!stillAllowed()) return UNAVAILABLE;
  pty.batchDoubleEscape([terminalId]);
  return { status: "sent", cancelKey: assessment.support };
}

export async function sendKeysToLaunchedAgent(
  pty: LaunchedAgentPty,
  terminalId: string,
  input: LaunchedAgentKeys,
  stillAllowed: StillAllowed,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<PluginAgentKeysResult> {
  const record = await pty.getTerminalAsync(terminalId);
  if (record === null) return UNAVAILABLE;
  if (!hasLiveProcess(record)) {
    return refused(`Terminal ${terminalId} has no running process. Nothing was pressed.`);
  }
  let keys: string[];
  if ("choose" in input) {
    const snapshot = await readTailSnapshot(
      (options) => pty.getSerializedStateAsync(terminalId, options),
      CHOOSE_SCREEN_LINES
    );
    if (snapshot === null) return UNAVAILABLE;
    const plan = planChoice(
      tailCapturedOutput(snapshot.data, CHOOSE_SCREEN_LINES, true).content,
      input.choose
    );
    if (!plan.ok) return refused(`${plan.reason} Nothing was pressed.`);
    keys = plan.keys;
  } else {
    keys = input.keys;
  }
  // One write per key, spaced out: a TUI reading a burst as one chunk can take
  // an arrow and an Enter as a single unknown sequence.
  for (const [index, key] of keys.entries()) {
    if (index > 0) await sleep(SEND_KEYS_GAP_MS);
    if (!stillAllowed()) {
      return index === 0 ? UNAVAILABLE : { status: "sent", keys: keys.slice(0, index) };
    }
    pty.write(terminalId, keySequence(key));
  }
  // The screen the actions read back is left out: what a terminal shows is
  // `terminal:read`'s to hand over, not `agent:input`'s.
  return { status: "sent", keys };
}

export async function submitToLaunchedAgent(
  pty: LaunchedAgentPty,
  terminalId: string,
  text: string,
  stillAllowed: StillAllowed
): Promise<PluginAgentInputResult> {
  const record = await pty.getTerminalAsync(terminalId);
  if (record === null) return UNAVAILABLE;
  if (record.isTrashed === true) {
    return refused(`Terminal ${terminalId} is in the trash. Nothing was sent.`);
  }
  if (!hasLiveProcess(record)) {
    return refused(`Terminal ${terminalId} has no running process. Nothing was sent.`);
  }
  if (!stillAllowed()) return UNAVAILABLE;
  pty.submit(terminalId, text);
  return { status: "sent" };
}
