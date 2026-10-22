import { isDevPreviewKind } from "../../shared/types/panel.js";
import type { HostProcessInventory } from "../../shared/types/processes.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import { evaluateWakeGate } from "../../shared/utils/terminalWakeGate.js";
import type { PtyClient } from "./PtyClient.js";
import type { GitSleepSafety } from "../utils/gitSleepSafety.js";
import { isPlainShellName } from "./pty/agentProcessTree.js";

/** One entry of the live terminal snapshot PtyClient serves. */
export type SleepGateTerminal = Awaited<ReturnType<PtyClient["getAllTerminalsAsync"]>>[number];

/** Why a project with terminals was not put to sleep. */
export type IdleShellSkipReason =
  | "remote-host"
  | "workspace-unknown"
  | "lifecycle-busy"
  | "resource-configured"
  | "resource-unknown"
  | "git-busy"
  | "git-unknown"
  | "census-unavailable"
  | "census-stale"
  | "agent-terminal"
  | "agent-not-at-prompt"
  | "agent-input-pending"
  | "agent-resume-unproven"
  | "terminal-unknown"
  | "terminal-busy"
  | "terminal-activity"
  | "panel-unrecoverable"
  | "panel-unknown";

export type GateResult<T> = { ok: true; value: T } | { ok: false; reason: IdleShellSkipReason };

/**
 * How old the census may be. The process-tree cache backs off to one sweep
 * every 15 s while a terminal is subscribed, so two missed sweeps is a census
 * that has stopped, and a reading that old says nothing about what a shell
 * started since.
 */
export const CENSUS_MAX_AGE_MS = 30_000;

/** A terminal the sleep would kill: it still holds a PTY. */
export function isLiveTerminal(terminal: SleepGateTerminal): boolean {
  return terminal.hasPty !== false;
}

/** Any sign an agent runs or ran here sends a terminal through the agent gates. */
export function isAgentTerminal(terminal: SleepGateTerminal): boolean {
  return Boolean(terminal.launchAgentId || terminal.detectedAgentId || terminal.everDetectedAgent);
}

/** The terminals a project's gates vouched for, as they read when they did. */
export type VettedTerminals = ReadonlyMap<string, SleepGateTerminal>;

/**
 * The gates an agent's own record answers (#13854), asked at the screen and
 * again against the kill's snapshot. Null when it passes.
 *
 * Only the agent Daintree launched, still the one detected and still read by a
 * live mirror, can be held to its own session. It has to be waiting at a plain
 * prompt (the wake gate's reading: an approval, question or error, a turn, the
 * boot window and no reading all fail) with nothing typed since it settled
 * there, nothing queued to submit, and no input or visible change for the
 * whole threshold. The visible-change stamp ignores spinner and status
 * redraws; without one there is no reading, since raw output would count those
 * redraws and nothing else is quiet proof.
 */
function agentRecordBlock(
  terminal: SleepGateTerminal,
  now: number,
  thresholdMs: number,
  awakeSince: (timestamp: number) => number
): IdleShellSkipReason | null {
  if (!terminal.launchAgentId || terminal.detectedAgentId !== terminal.launchAgentId) {
    return "agent-resume-unproven";
  }
  // With no mirror reading its output, the agent's state and visible-change
  // stamp are frozen at whatever they last were.
  if (terminal.analysisLive !== true) return "terminal-unknown";
  const prompt = evaluateWakeGate(terminal);
  if (prompt.kind === "hold" && prompt.reason === "typing") return "agent-input-pending";
  if (prompt.kind !== "ready") return "agent-not-at-prompt";
  if (terminal.hasPendingSubmission !== false) return "agent-input-pending";
  const { lastInputTime, lastOutputChangeAt } = terminal;
  if (!Number.isFinite(lastInputTime) || !Number.isFinite(lastOutputChangeAt)) {
    return "terminal-unknown";
  }
  const lastActivity = Math.max(
    terminal.spawnedAt,
    lastInputTime!,
    terminal.lastTypedInputAt ?? 0,
    lastOutputChangeAt!
  );
  if (lastActivity > now || awakeSince(lastActivity) < thresholdMs) return "terminal-activity";
  return null;
}

/** The same launch, the same session, the same observed incarnation. */
function sameAgentSession(before: SleepGateTerminal, now: SleepGateTerminal): boolean {
  return (
    before.launchAgentId === now.launchAgentId &&
    before.detectedAgentId === now.detectedAgentId &&
    before.agentSessionId === now.agentSessionId &&
    before.agentIncarnation === now.agentIncarnation
  );
}

function shellActivityBlock(
  terminal: SleepGateTerminal,
  now: number,
  thresholdMs: number,
  awakeSince: (timestamp: number) => number
): IdleShellSkipReason | null {
  const { lastInputTime, lastOutputTime } = terminal;
  if (!Number.isFinite(lastInputTime) || !Number.isFinite(lastOutputTime)) {
    return "terminal-unknown";
  }
  const lastIo = Math.max(terminal.spawnedAt, lastInputTime!, lastOutputTime!);
  if (lastIo > now || awakeSince(lastIo) < thresholdMs) return "terminal-activity";
  return null;
}

/**
 * Lifecycle and resource state from the project's workspace host. An absent
 * host answers `gitBacked: null`, which is no answer at all, so it blocks.
 * Resource-configured worktrees are kept out entirely: `resourceStatus` is the
 * last manual check, so it can't prove there is no box a teardown would orphan.
 */
export function evaluateWorkspace(
  read: { states: WorktreeSnapshot[]; gitBacked: boolean | null } | null
): GateResult<string[]> {
  if (!read || read.gitBacked === null) return { ok: false, reason: "workspace-unknown" };
  if (!read.gitBacked) return { ok: true, value: [] };
  if (read.states.length === 0) return { ok: false, reason: "workspace-unknown" };
  for (const state of read.states) {
    if (state.hasResourceConfig || state.resourceStatus) {
      return { ok: false, reason: "resource-configured" };
    }
    const lifecycle = state.lifecycleStatus?.state;
    if (lifecycle === "running") return { ok: false, reason: "lifecycle-busy" };
    const setup = state.setupStatus?.state;
    if (setup === "pending" || setup === "running") {
      return { ok: false, reason: "lifecycle-busy" };
    }
  }
  return { ok: true, value: read.states.map((state) => state.path) };
}

export function evaluateGit(result: GitSleepSafety): IdleShellSkipReason | null {
  if (result.state === "busy") return "git-busy";
  if (result.state !== "clear") return "git-unknown";
  return null;
}

export interface ProcessInventoryRead {
  inventories: HostProcessInventory[];
  shardsFailed: number;
}

/**
 * Every live terminal in the project is a plain shell with nothing running in
 * it, or an agent at rest (#13854), with nothing typed into or happening in it
 * for the whole threshold.
 *
 * The process tree is the witness for both. A shell's root must be a known
 * shell and the census must see it alone (`processCount` counts the root and
 * every descendant, so a foreground job, a `&` job or a stopped one all make
 * it more than one). An agent's tree is classified by the host from every
 * process in it: the launch shell, the agent alone under it and no shell under
 * the agent, so a tool call, background shell or Monitor it started holds it.
 * An agent is also held to its own record ({@link agentRecordBlock}); whether
 * it resumes its conversation needs a transcript read, which the caller makes.
 * Any terminal the census and the registry disagree about blocks, as does any
 * missing reading or a census that is failing or old.
 *
 * Returns the terminals it vouched for, so the kill's own snapshot can be held
 * to exactly that set as it read here.
 */
export function evaluateShellTerminals(
  projectId: string,
  terminals: readonly SleepGateTerminal[],
  census: ProcessInventoryRead | null,
  now: number,
  thresholdMs: number,
  awakeSince: (timestamp: number) => number
): GateResult<Map<string, SleepGateTerminal>> {
  if (!census || census.shardsFailed > 0) return { ok: false, reason: "census-unavailable" };
  // Only the shards holding this project's terminals have to be current: a
  // shard with nothing subscribed stops sweeping, and its idle census says
  // nothing about these shells either way.
  const sampled = new Map<string, HostProcessInventory["terminals"][number]>();
  for (const inventory of census.inventories) {
    const own = inventory.terminals.filter((terminal) => terminal.projectId === projectId);
    if (own.length === 0) continue;
    if (!inventory.available) return { ok: false, reason: "census-unavailable" };
    if (!(inventory.sampledAt > 0) || now - inventory.sampledAt > CENSUS_MAX_AGE_MS) {
      return { ok: false, reason: "census-stale" };
    }
    for (const terminal of own) sampled.set(terminal.id, terminal);
  }

  const live = terminals.filter((t) => t.projectId === projectId && isLiveTerminal(t));
  const vetted = new Map(live.map((t) => [t.id, t] as const));
  // A PTY the census lists that the registry read didn't is one spawned in
  // between; it has not been vetted.
  for (const id of sampled.keys()) {
    if (!vetted.has(id)) return { ok: false, reason: "terminal-unknown" };
  }

  for (const terminal of live) {
    // A dev preview's PTY is its server; the assistant has its own floor.
    if (isDevPreviewKind(terminal.kind) || terminal.isAssistantTerminal) {
      return { ok: false, reason: "agent-terminal" };
    }
    const entry = sampled.get(terminal.id);
    if (isAgentTerminal(terminal)) {
      const block = agentRecordBlock(terminal, now, thresholdMs, awakeSince);
      if (block) return { ok: false, reason: block };
      if (!entry || entry.rootPid === null || !entry.sample) {
        return { ok: false, reason: "terminal-unknown" };
      }
      if (entry.agentTree === "other") return { ok: false, reason: "terminal-busy" };
      if (entry.agentTree !== "runtime-and-servers") {
        return { ok: false, reason: "terminal-unknown" };
      }
      continue;
    }
    const block = shellActivityBlock(terminal, now, thresholdMs, awakeSince);
    if (block) return { ok: false, reason: block };
    if (!entry || entry.rootPid === null || !entry.sample) {
      return { ok: false, reason: "terminal-unknown" };
    }
    const root = entry.sample.members.find((member) => member.pid === entry.rootPid);
    if (entry.sample.processCount !== 1 || !root || !isPlainShellName(root.comm)) {
      return { ok: false, reason: "terminal-busy" };
    }
  }
  return { ok: true, value: vetted };
}

/**
 * What the census says these terminals hold, in KB: each one's whole process
 * tree, counted once however many shards list it. Resident memory summed per
 * process counts shared pages repeatedly, so this is an estimate of what a
 * sleep frees, not a measurement.
 */
export function censusMemoryKb(
  census: ProcessInventoryRead | null,
  projectId: string,
  terminalIds: Pick<ReadonlySet<string>, "has">
): number {
  if (!census) return 0;
  const byTerminal = new Map<string, number>();
  for (const inventory of census.inventories) {
    for (const terminal of inventory.terminals) {
      if (terminal.projectId !== projectId || !terminalIds.has(terminal.id)) continue;
      const kb = terminal.sample?.memoryKb;
      if (typeof kb === "number" && Number.isFinite(kb) && kb > 0) byTerminal.set(terminal.id, kb);
    }
  }
  let total = 0;
  for (const kb of byTerminal.values()) total += kb;
  return total;
}

/**
 * The kill's own snapshot, held to what the sweep vouched for: no terminal it
 * didn't vet, none of the vetted ones touched since, no shell turned agent,
 * and every agent still the same session at rest. The census and the
 * transcript can't be read again here; the kill follows this synchronously.
 */
export function terminalsStillVetted(
  projectId: string,
  terminals: readonly SleepGateTerminal[],
  vetted: VettedTerminals,
  now: number,
  thresholdMs: number,
  awakeSince: (timestamp: number) => number
): boolean {
  for (const terminal of terminals) {
    if (terminal.projectId !== projectId || !isLiveTerminal(terminal)) continue;
    const before = vetted.get(terminal.id);
    if (!before) return false;
    if (isAgentTerminal(terminal) !== isAgentTerminal(before)) return false;
    if (isAgentTerminal(terminal)) {
      if (!sameAgentSession(before, terminal)) return false;
      if (agentRecordBlock(terminal, now, thresholdMs, awakeSince)) return false;
      continue;
    }
    if (shellActivityBlock(terminal, now, thresholdMs, awakeSince)) return false;
  }
  return true;
}
