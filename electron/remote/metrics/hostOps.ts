import { createHash } from "node:crypto";
import type {
  HostFleetTarget,
  HostFleetTargetList,
  HostWorktreeEntry,
  HostWorktreeObservation,
  HostWorktreeRun,
} from "../../../shared/types/ipc/hostMetrics.js";
import type { FleetRunRow } from "../../../shared/types/ipc/fleet.js";
import { FLEET_BANDS, bandForRun } from "../../../shared/utils/fleetBands.js";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { isSessionEndpoint } from "../../ipc/endpoint.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { projectStore } from "../../services/ProjectStore.js";
import { events } from "../../services/events.js";
import { classifyRun } from "../../services/projectAgentCounts.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  getFleetSnapshotServiceRef,
  getPtyClient,
  getWorkspaceClientRef,
} from "../../window/serviceRefs.js";
import { FLEET_SUBMIT_RETENTION_MS } from "../../../shared/config/fleetSubmitRetention.js";
import { openProjects } from "./hostSources.js";
import {
  MAX_FLEET_SUBMIT_CHARS,
  MAX_FLEET_TARGETS,
  MAX_HOST_WORKTREES,
  MAX_RESTART_IDS,
  MAX_RESTART_PROJECTS,
  MAX_WORKTREE_RUNS,
  normalizeFleetOpId,
} from "./linkMethods.js";
import type { LocalRestartTerminals } from "./hostMetricsHost.js";
import type { HostRestartProject } from "../../../shared/types/ipc/remoteHosts.js";
import { getOperationRegistry } from "../../services/operations/index.js";

/**
 * Who is asking to submit: a Shell attached over a link, known by the session
 * id this host issued it (a client id is only what its HELLO claimed), or this
 * machine's own screen.
 */
export type FleetCaller = { kind: "remote"; sessionId: string } | { kind: "local" };

/**
 * The most outcomes kept at once. A record is never dropped while its
 * retention runs, since the Shell's safe-retry window relies on it, so this
 * only bounds memory against a runaway caller: at the cap a new opId is
 * refused before anything is typed. Twenty broadcasts to a full fleet of
 * `MAX_FLEET_TARGETS` agents inside one retention window fit.
 */
export const FLEET_SUBMIT_MAX_RETAINED = 20 * MAX_FLEET_TARGETS;

interface LedgerEntry {
  terminalId: string;
  digest: string;
  /** When it succeeded; null while it is still running, and never evicted then. */
  settledAt: number | null;
  outcome: Promise<void>;
}

/**
 * Fleet submits this host has run, by the Shell's opId. A Shell whose answer
 * was lost resends the same opId; that resend joins the one in flight or gets
 * its success back instead of typing the prompt a second time. A refusal is
 * forgotten: nothing reached the terminal, so the resend may run it.
 */
export class FleetSubmitLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly retentionMs = FLEET_SUBMIT_RETENTION_MS,
    private readonly maxRetained = FLEET_SUBMIT_MAX_RETAINED
  ) {}

  run(opId: string, terminalId: string, text: string, work: () => Promise<void>): Promise<void> {
    this.prune();
    const digest = createHash("sha256").update(text).digest("hex");
    const existing = this.entries.get(opId);
    if (existing) {
      if (existing.terminalId !== terminalId || existing.digest !== digest) {
        return Promise.reject(
          refuse("VALIDATION", `Fleet opId ${opId} was already used for another submit`)
        );
      }
      return existing.outcome;
    }
    if (this.entries.size >= this.maxRetained) {
      return Promise.reject(
        refuse(
          "RATE_LIMITED",
          `Fleet submit ${opId} refused: ${this.entries.size} recent submits are still on record`,
          "Too many prompts were sent to this host in the last few minutes. Try again shortly."
        )
      );
    }
    const outcome = work();
    const entry: LedgerEntry = { terminalId, digest, settledAt: null, outcome };
    this.entries.set(opId, entry);
    outcome.then(
      () => {
        entry.settledAt = this.now();
      },
      () => {
        if (this.entries.get(opId) === entry) this.entries.delete(opId);
      }
    );
    return outcome;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Only a settled outcome whose retention has run out is dropped. Dropping one
   * still running, or one a Shell may still resend inside its safe-retry
   * window, would let that resend type the prompt twice.
   */
  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [opId, entry] of this.entries) {
      if (entry.settledAt !== null && entry.settledAt <= cutoff) this.entries.delete(opId);
    }
  }
}

const ledger = new FleetSubmitLedger();

/**
 * This host's agent runs, as fleet targets. Ids are this host's own terminal
 * ids. Incomplete when a pty-host shard didn't answer or the cap cut the list,
 * so a Shell never reads a missing target as gone.
 */
export async function listLocalFleetTargets(): Promise<HostFleetTargetList> {
  const pty = getPtyClient();
  if (!pty) return { targets: [], complete: false };
  const availability = getAgentAvailabilityStore();
  const { terminals, degraded } = await pty.getAllTerminalsWithCompletenessAsync();
  let complete = !degraded;
  const out: HostFleetTarget[] = [];
  for (const terminal of terminals) {
    if (classifyRun(terminal, (id) => availability.isHelpTerminal(id)) !== null) continue;
    if (terminal.agentState === "exited" || !terminal.projectId) continue;
    const agentId = terminal.detectedAgentId ?? terminal.launchAgentId ?? null;
    const project = terminal.projectId ? projectStore.getProjectById(terminal.projectId) : null;
    out.push({
      hostId: LOCAL_HOST_ID,
      terminalId: terminal.id,
      title:
        terminal.title?.trim() || (agentId ? (getAgentConfig(agentId)?.name ?? agentId) : "Agent"),
      projectId: terminal.projectId ?? null,
      projectName: project?.name ?? null,
      agentId,
      agentState: terminal.agentState ?? null,
    });
    if (out.length >= MAX_FLEET_TARGETS) {
      complete = false;
      break;
    }
  }
  return { targets: out, complete };
}

/**
 * Every terminal a restart of this host would end, by project, with the
 * agents observed working or waiting among them, and the long operations
 * still running. Incomplete when a pty-host shard didn't answer or a cap cut
 * the list, so a Shell never reads a missing terminal as none.
 */
export async function listLocalRestartTerminals(): Promise<LocalRestartTerminals> {
  const pty = getPtyClient();
  const operations = getOperationRegistry().runningCount();
  if (!pty) return { projects: [], complete: false, operations, terminalIds: [] };
  const { terminals, degraded } = await pty.getAllTerminalsWithCompletenessAsync();
  let complete = !degraded;
  const byProject = new Map<string | null, HostRestartProject>();
  const terminalIds: string[] = [];
  for (const terminal of terminals) {
    // The PTY's own life decides, never the agent's: a shell an agent exited from still runs.
    if (terminal.hasPty === false) continue;
    if (terminalIds.length >= MAX_RESTART_IDS) {
      complete = false;
      break;
    }
    const projectId = terminal.projectId ?? null;
    let entry = byProject.get(projectId);
    if (!entry) {
      if (byProject.size >= MAX_RESTART_PROJECTS) {
        complete = false;
        continue;
      }
      const project = projectId ? projectStore.getProjectById(projectId) : null;
      entry = { projectName: project?.name ?? null, terminals: 0, working: 0, waiting: 0 };
      byProject.set(projectId, entry);
    }
    terminalIds.push(terminal.id);
    entry.terminals++;
    if (terminal.agentState === "working" || terminal.agentState === "directing") entry.working++;
    else if (terminal.agentState === "waiting") entry.waiting++;
  }
  return { projects: [...byProject.values()], complete, operations, terminalIds };
}

function refuse(
  code: "NOT_FOUND" | "VALIDATION" | "DRIVEN_ELSEWHERE" | "RATE_LIMITED",
  message: string,
  userMessage?: string
): AppError {
  return new AppError({ code, message, ...(userMessage ? { userMessage } : {}) });
}

/**
 * Submit a fleet prompt to one of this host's agents. Only agent runs take
 * it, and only while nobody else drives their project: a prompt from a
 * Shell that doesn't hold the lease would land in someone else's session.
 * Errno tokens lead the messages so the Shell classifies dead PTYs as it does
 * for local ones.
 */
export function submitLocalFleet(
  terminalId: string,
  text: string,
  caller: FleetCaller,
  opId: string | null = null
): Promise<void> {
  const id = normalizeFleetOpId(opId);
  const work = () => submitNow(terminalId, text, caller);
  return id === null ? work() : ledger.run(id, terminalId, text, work);
}

/**
 * Whether `caller` may type into a project `holder` drives. A vacant lease
 * lets anyone; a held one only the holder: this machine's own window for a
 * local caller, or an endpoint bound to the caller's own session.
 */
export function callerDrives(
  holder: { endpointId: string; isHostLocal: boolean } | null,
  caller: FleetCaller
): boolean {
  if (holder === null) return true;
  return caller.kind === "local"
    ? holder.isHostLocal
    : isSessionEndpoint(caller.sessionId, holder.endpointId);
}

async function submitNow(terminalId: string, text: string, caller: FleetCaller): Promise<void> {
  if (text.length === 0 || text.length > MAX_FLEET_SUBMIT_CHARS) {
    throw refuse("VALIDATION", "Fleet prompt is empty or too large");
  }
  const pty = getPtyClient();
  const info = pty ? await pty.getTerminalAsync(terminalId) : null;
  if (!pty || !info) throw refuse("NOT_FOUND", `EBADF: terminal ${terminalId} not found`);
  if (info.hasPty === false) {
    throw refuse("NOT_FOUND", `EPIPE: terminal ${terminalId} has no live PTY (exited)`);
  }
  const availability = getAgentAvailabilityStore();
  if (classifyRun(info, (id) => availability.isHelpTerminal(id)) !== null) {
    // A non-agent answers as a missing one: fleets only ever reach agents.
    throw refuse("NOT_FOUND", `EBADF: terminal ${terminalId} not found`);
  }
  const projectId = info.projectId ?? null;
  // A terminal that belongs to no project has no lease to consult, so it is never a fleet target.
  if (!projectId) throw refuse("NOT_FOUND", `EBADF: terminal ${terminalId} not found`);
  const holder = peekDriveLeaseService()?.getHolder(projectId) ?? null;
  if (holder && !callerDrives(holder, caller)) {
    throw refuse(
      "DRIVEN_ELSEWHERE",
      `terminal ${terminalId} is driven from ${holder.clientName}`,
      `That project is being driven from ${holder.clientName}.`
    );
  }
  pty.submit(terminalId, text);
}

function observationOf(run: HostWorktreeRun | undefined): HostWorktreeObservation | null {
  return run ? { band: run.band, agentState: run.agentState } : null;
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}\n${worktreeId}`;
}

/**
 * Every agent in each worktree as this host's fleet placed it, most urgent
 * first, keyed by project and worktree. Canopy's reading is left out: another
 * machine is shown what this host observed, never an interpretation of it.
 * Equal bands settle on the lowest run id, so the order is stable.
 */
export function observeWorktreeRuns(runs: readonly FleetRunRow[]): Map<string, HostWorktreeRun[]> {
  const out = new Map<string, HostWorktreeRun[]>();
  for (const run of runs) {
    if (!run.worktreeId) continue;
    const { canopy: _canopy, ...observed } = run;
    const key = worktreeKey(run.workspaceId, run.worktreeId);
    const held = out.get(key) ?? [];
    held.push({
      terminalId: run.runId,
      band: bandForRun(observed),
      agentState: run.agentState ?? null,
    });
    out.set(key, held);
  }
  for (const held of out.values()) {
    held.sort(
      (a, b) =>
        FLEET_BANDS.indexOf(a.band) - FLEET_BANDS.indexOf(b.band) ||
        (a.terminalId < b.terminalId ? -1 : a.terminalId > b.terminalId ? 1 : 0)
    );
  }
  return out;
}

/**
 * Be told whenever this machine's worktree list may show something else: a
 * worktree came, went or moved, an agent's state changed, or the fleet placed
 * a run anew (parks, snoozes and hand-backs move bands with no state change).
 */
export function onLocalWorktreesMaybeChanged(listener: () => void): () => void {
  let offFleet: (() => void) | null = null;
  // The fleet service may start after this is installed, so it's followed once it exists.
  const followFleet = (): void => {
    offFleet ??= getFleetSnapshotServiceRef()?.subscribe(() => listener()) ?? null;
  };
  const heard = (): void => {
    followFleet();
    listener();
  };
  followFleet();
  const offs = [
    events.on("sys:worktree:update", heard),
    events.on("sys:worktree:remove", heard),
    events.on("agent:state-changed", heard),
  ];
  return () => {
    for (const off of offs) off();
    offFleet?.();
  };
}

/**
 * Be told whenever which projects this machine has may have changed: one was
 * added or removed, or moved, renamed or changed its git backing. The only
 * thing that changes which of them another machine's project matches here.
 */
export function onLocalProjectsChanged(listener: () => void): () => void {
  return projectStore.onProjectRegistryChanged(listener);
}

/** Every worktree of this host's open projects. */
export async function listLocalWorktrees(): Promise<HostWorktreeEntry[]> {
  const client = getWorkspaceClientRef();
  if (!client) return [];
  const runs = getFleetSnapshotServiceRef()?.getLastBroadcast()?.runs ?? [];
  const observed = observeWorktreeRuns(runs);
  const out: HostWorktreeEntry[] = [];
  for (const project of openProjects()) {
    let states;
    try {
      states = await client.getAllStatesForProjectAsync(project.path, project.id);
    } catch {
      continue;
    }
    for (const state of states) {
      const held = observed.get(worktreeKey(project.id, state.id)) ?? [];
      out.push({
        hostId: LOCAL_HOST_ID,
        projectId: project.id,
        projectName: project.name,
        worktreeId: state.id,
        name: state.name,
        branch: state.branch ?? null,
        path: state.path,
        isMainWorktree: state.isMainWorktree === true,
        modifiedCount: typeof state.modifiedCount === "number" ? state.modifiedCount : null,
        lastActivityAt:
          typeof state.lastActivityTimestamp === "number" ? state.lastActivityTimestamp : null,
        observed: observationOf(held[0]),
        runs: held.slice(0, MAX_WORKTREE_RUNS),
      });
      if (out.length >= MAX_HOST_WORKTREES) return out;
    }
  }
  return out;
}
