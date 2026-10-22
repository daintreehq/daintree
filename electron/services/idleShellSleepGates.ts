import path from "path";
import { isDevPreviewKind } from "../../shared/types/panel.js";
import type { HostProcessInventory } from "../../shared/types/processes.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import type { PtyClient } from "./PtyClient.js";
import type { GitSleepSafety } from "../utils/gitSleepSafety.js";

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
  | "terminal-unknown"
  | "terminal-busy"
  | "terminal-activity";

export type GateResult<T> = { ok: true; value: T } | { ok: false; reason: IdleShellSkipReason };

/**
 * How old the census may be. The process-tree cache backs off to one sweep
 * every 15 s while a terminal is subscribed, so two missed sweeps is a census
 * that has stopped, and a reading that old says nothing about what a shell
 * started since.
 */
export const CENSUS_MAX_AGE_MS = 30_000;

/**
 * Interactive shells, by executable basename. A root process outside this set
 * is something the terminal was launched straight into (a REPL, `ssh`, a dev
 * server), which is running work even with no children.
 */
const PLAIN_SHELLS = new Set([
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "ksh",
  "mksh",
  "tcsh",
  "csh",
  "nu",
  "elvish",
  "xonsh",
  "pwsh",
  "powershell",
  "cmd",
]);

export function isPlainShellName(comm: string): boolean {
  let name = path.basename(comm.replace(/\\/g, "/")).toLowerCase();
  // A login shell's argv[0] is prefixed with `-` (`-zsh`).
  if (name.startsWith("-")) name = name.slice(1);
  if (name.endsWith(".exe")) name = name.slice(0, -4);
  return PLAIN_SHELLS.has(name);
}

/** A terminal the sleep would kill: it still holds a PTY. */
export function isLiveTerminal(terminal: SleepGateTerminal): boolean {
  return terminal.hasPty !== false;
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
 * it and nothing typed into or printed by it for the whole threshold.
 *
 * The process tree is the witness, never agent state: the root must be a known
 * shell and the census must see it alone (`processCount` counts the root and
 * every descendant, so a foreground job, a `&` job or a stopped one all make
 * it more than one). Any terminal the census and the registry disagree about
 * blocks, as does any missing timestamp or a census that is failing or old.
 *
 * Returns the ids it vouched for, so the kill's own snapshot can be held to
 * exactly that set.
 */
export function evaluateShellTerminals(
  projectId: string,
  terminals: readonly SleepGateTerminal[],
  census: ProcessInventoryRead | null,
  now: number,
  thresholdMs: number,
  awakeSince: (timestamp: number) => number
): GateResult<Set<string>> {
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
  const liveIds = new Set(live.map((t) => t.id));
  // A PTY the census lists that the registry read didn't is one spawned in
  // between; it has not been vetted.
  for (const id of sampled.keys()) {
    if (!liveIds.has(id)) return { ok: false, reason: "terminal-unknown" };
  }

  for (const terminal of live) {
    // A dev preview's PTY is its server.
    if (
      isDevPreviewKind(terminal.kind) ||
      terminal.isAssistantTerminal ||
      terminal.launchAgentId ||
      terminal.detectedAgentId ||
      terminal.everDetectedAgent
    ) {
      return { ok: false, reason: "agent-terminal" };
    }
    const { lastInputTime, lastOutputTime } = terminal;
    if (!Number.isFinite(lastInputTime) || !Number.isFinite(lastOutputTime)) {
      return { ok: false, reason: "terminal-unknown" };
    }
    const lastIo = Math.max(terminal.spawnedAt, lastInputTime!, lastOutputTime!);
    if (lastIo > now || awakeSince(lastIo) < thresholdMs) {
      return { ok: false, reason: "terminal-activity" };
    }
    const entry = sampled.get(terminal.id);
    if (!entry || entry.rootPid === null || !entry.sample) {
      return { ok: false, reason: "terminal-unknown" };
    }
    const root = entry.sample.members.find((member) => member.pid === entry.rootPid);
    if (entry.sample.processCount !== 1 || !root || !isPlainShellName(root.comm)) {
      return { ok: false, reason: "terminal-busy" };
    }
  }
  return { ok: true, value: liveIds };
}

/**
 * The kill's own snapshot, held to what the sweep vouched for: no terminal it
 * didn't vet, and none of the vetted ones touched since.
 */
export function terminalsStillVetted(
  projectId: string,
  terminals: readonly SleepGateTerminal[],
  vetted: ReadonlySet<string>,
  now: number,
  thresholdMs: number,
  awakeSince: (timestamp: number) => number
): boolean {
  for (const terminal of terminals) {
    if (terminal.projectId !== projectId || !isLiveTerminal(terminal)) continue;
    if (!vetted.has(terminal.id)) return false;
    const { lastInputTime, lastOutputTime } = terminal;
    if (!Number.isFinite(lastInputTime) || !Number.isFinite(lastOutputTime)) return false;
    const lastIo = Math.max(terminal.spawnedAt, lastInputTime!, lastOutputTime!);
    if (lastIo > now || awakeSince(lastIo) < thresholdMs) return false;
  }
  return true;
}
