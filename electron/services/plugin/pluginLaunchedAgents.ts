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
 * Keyed by terminal id, like the MCP ownership ledger: a pane restart or a
 * terminal-host recovery brings the same pane back under the same id, and it
 * stays the plugin's. An exited terminal's record is inert, since nothing can
 * be written to it.
 *
 * The ledger is also kept on disk (#16240), so it survives an app restart. A
 * stored record comes back only for a pane that main's own hydrate hands back
 * to restore under the id it was launched with, and only while that pane still
 * names the same launching plugin: a pane restored under a fresh id, or one
 * that never comes back, regains nothing, and a later spawn reusing the id
 * inherits nothing. Every forget below reaches the disk too, so an unload that
 * ends a plugin's reach also ends it across a restart; the one exception is
 * the service's own teardown, which detaches the disk first and leaves it.
 */
interface PluginLaunchRecord {
  readonly pluginId: string;
  /** The project the launch was sent to; null for an installed plugin's ambient launch. */
  readonly projectId: string | null;
}

/** A record as kept on disk. */
export interface StoredPluginLaunch extends PluginLaunchRecord {
  /** When main last recorded the launch or handed its pane back to restore. */
  readonly seenAt: number;
}

/** Where the ledger is kept between runs: the `pluginLaunchedAgents` store key in production. */
export interface PluginLaunchPersistence {
  load(): unknown;
  save(records: Record<string, StoredPluginLaunch>): void;
}

/**
 * A stored record whose pane hasn't come back in this long is dropped: its
 * project went unopened for a month, or the pane is gone and nothing said so.
 */
export const STORED_PLUGIN_LAUNCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** At most this many stored records, the oldest dropped first. */
export const MAX_STORED_PLUGIN_LAUNCHES = 200;

/** A loaded `seenAt` this far past "now" is corrupt, not early. */
const FUTURE_SKEW_MS = 60_000;

const launches = new Map<string, PluginLaunchRecord>();

let persistence: PluginLaunchPersistence | null = null;
/** The disk's copy, loaded on attach. Holds records restore hasn't handed back yet. */
const stored = new Map<string, StoredPluginLaunch>();

function readStoredRecord(terminalId: string, raw: unknown, now: number): StoredPluginLaunch | null {
  if (terminalId.length === 0 || terminalId.length > SEND_TO_AGENT_MAX_ID_LENGTH) return null;
  if (raw === null || typeof raw !== "object") return null;
  const { pluginId, projectId, seenAt } = raw as Record<string, unknown>;
  if (typeof pluginId !== "string" || pluginId.length === 0) return null;
  if (projectId !== null && (typeof projectId !== "string" || projectId.length === 0)) return null;
  if (typeof seenAt !== "number" || !Number.isFinite(seenAt)) return null;
  if (seenAt < now - STORED_PLUGIN_LAUNCH_TTL_MS || seenAt > now + FUTURE_SKEW_MS) return null;
  return { pluginId, projectId, seenAt };
}

/** Drop the oldest records past the cap. Reports whether any went. */
function capStored(): boolean {
  if (stored.size <= MAX_STORED_PLUGIN_LAUNCHES) return false;
  const oldestFirst = [...stored].sort(([, a], [, b]) => a.seenAt - b.seenAt);
  for (const [terminalId] of oldestFirst.slice(0, stored.size - MAX_STORED_PLUGIN_LAUNCHES)) {
    stored.delete(terminalId);
  }
  return true;
}

function persist(): void {
  if (persistence === null) return;
  try {
    persistence.save(Object.fromEntries(stored));
  } catch (error) {
    console.error("[pluginLaunchedAgents] Failed to save the plugin launch ledger:", error);
  }
}

/**
 * Keep the ledger on disk from here on, loading what an earlier run left. The
 * first caller wins: both the plugin host's start and a hydrate that needs the
 * records attach the same store, in whichever order they run.
 */
export function attachPluginLaunchPersistence(target: PluginLaunchPersistence): void {
  if (persistence !== null) return;
  persistence = target;
  let raw: unknown;
  try {
    raw = target.load();
  } catch (error) {
    console.error("[pluginLaunchedAgents] Failed to load the plugin launch ledger:", error);
    raw = undefined;
  }
  const entries = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const now = Date.now();
  let pruned = false;
  for (const [terminalId, value] of Object.entries(entries as Record<string, unknown>)) {
    const record = readStoredRecord(terminalId, value, now);
    if (record === null) pruned = true;
    else stored.set(terminalId, record);
  }
  if (capStored() || pruned) persist();
}

/**
 * Stop writing to disk and forget its copy, leaving what is there for the next
 * run. Called by the service's teardown before anything it unloads forgets.
 */
export function detachPluginLaunchPersistence(): void {
  persistence = null;
  stored.clear();
}

/**
 * Bring back the stored records of the panes main's hydrate is handing to
 * restore. A record comes back only under the saved id it was launched with,
 * and only while the saved pane still names the plugin it holds: a pane under
 * that id that names another, or none, means the id now belongs to someone
 * else, and the record goes.
 */
export function admitRestoredPluginLaunches(
  panes: ReadonlyArray<{ id?: unknown; launchedByPluginId?: unknown }>
): void {
  if (stored.size === 0) return;
  const now = Date.now();
  let changed = false;
  for (const pane of panes) {
    if (typeof pane.id !== "string") continue;
    const record = stored.get(pane.id);
    if (record === undefined) continue;
    changed = true;
    if (pane.launchedByPluginId !== record.pluginId) {
      stored.delete(pane.id);
      if (launches.get(pane.id)?.pluginId === record.pluginId) launches.delete(pane.id);
      continue;
    }
    launches.set(pane.id, { pluginId: record.pluginId, projectId: record.projectId });
    stored.set(pane.id, { ...record, seenAt: now });
  }
  if (changed) persist();
}

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
  if (persistence === null) return;
  stored.set(terminalId, { pluginId, projectId, seenAt: Date.now() });
  capStored();
  persist();
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

/**
 * Drop every agent the matching plugin instances launched, on disk as well, so
 * they reach none of them after a restart either. A stored record restore
 * hasn't handed back yet goes too, whether or not its plugin is loaded.
 */
export function forgetPluginLaunchesWhere(matches: (pluginId: string) => boolean): void {
  for (const [terminalId, record] of launches) {
    if (matches(record.pluginId)) launches.delete(terminalId);
  }
  let changed = false;
  for (const [terminalId, record] of stored) {
    if (!matches(record.pluginId)) continue;
    stored.delete(terminalId);
    changed = true;
  }
  if (changed) persist();
}

export function forgetPluginLaunches(pluginId: string): void {
  forgetPluginLaunchesWhere((id) => id === pluginId);
}

export function _resetPluginLaunchesForTests(): void {
  launches.clear();
  detachPluginLaunchPersistence();
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
 * Shell drives the project, so each write is held to the plugin's own drive
 * lease through {@link AdmitWrite} instead. The eligibility rules are the
 * shipped actions', from the same shared helpers.
 */
export type LaunchedAgentPty = Pick<
  PtyClient,
  "getTerminalAsync" | "getSerializedStateAsync" | "write" | "submit" | "batchDoubleEscape"
>;

/**
 * Whether the call may still write, asked right before each write and after
 * every await: an unload, a lost record or another screen taking control
 * stops a call partway rather than letting a paced key sequence finish.
 * Rejects `DRIVEN_ELSEWHERE` for a takeover; resolves false for the rest.
 */
export type AdmitWrite = () => Promise<boolean>;

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
  admitWrite: AdmitWrite
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
  if (!(await admitWrite())) return UNAVAILABLE;
  pty.batchDoubleEscape([terminalId]);
  return { status: "sent", cancelKey: assessment.support };
}

export async function sendKeysToLaunchedAgent(
  pty: LaunchedAgentPty,
  terminalId: string,
  input: LaunchedAgentKeys,
  admitWrite: AdmitWrite,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<PluginAgentKeysResult> {
  const record = await pty.getTerminalAsync(terminalId);
  if (record === null) return UNAVAILABLE;
  // A closed pane's process lives on through the trash's recovery grace, still
  // showing whatever prompt it stopped at, where no one can see it answered.
  if (record.isTrashed === true) {
    return refused(`Terminal ${terminalId} is in the trash. Nothing was pressed.`);
  }
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
    if (!(await admitWrite())) {
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
  admitWrite: AdmitWrite
): Promise<PluginAgentInputResult> {
  const record = await pty.getTerminalAsync(terminalId);
  if (record === null) return UNAVAILABLE;
  if (record.isTrashed === true) {
    return refused(`Terminal ${terminalId} is in the trash. Nothing was sent.`);
  }
  if (!hasLiveProcess(record)) {
    return refused(`Terminal ${terminalId} has no running process. Nothing was sent.`);
  }
  if (!(await admitWrite())) return UNAVAILABLE;
  pty.submit(terminalId, text);
  return { status: "sent" };
}
