import { createHash } from "node:crypto";
import type { HostFleetTarget, HostWorktreeEntry } from "../../../shared/types/ipc/hostMetrics.js";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { projectStore } from "../../services/ProjectStore.js";
import { classifyRun } from "../../services/projectAgentCounts.js";
import { AppError } from "../../utils/errorTypes.js";
import { isSessionEndpoint } from "../projects/hostInstall.js";
import { getPtyClient, getWorkspaceClientRef } from "../../window/serviceRefs.js";
import { openProjects } from "./hostSources.js";
import {
  MAX_FLEET_SUBMIT_CHARS,
  MAX_FLEET_TARGETS,
  MAX_HOST_WORKTREES,
  normalizeFleetOpId,
} from "./linkMethods.js";

/**
 * Who is asking to submit: a Shell attached over a link, known by the session
 * id this host issued it (a client id is only what its HELLO claimed), or this
 * machine's own screen.
 */
export type FleetCaller = { kind: "remote"; sessionId: string } | { kind: "local" };

/** How long a submit's outcome answers a resend of its opId, and how many are kept. */
export const FLEET_SUBMIT_RETENTION_MS = 10 * 60_000;
export const FLEET_SUBMIT_MAX_RETAINED = 512;

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
    const outcome = work();
    const entry: LedgerEntry = { terminalId, digest, settledAt: null, outcome };
    this.entries.set(opId, entry);
    outcome.then(
      () => {
        entry.settledAt = this.now();
        this.evictOverCap();
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

  /** Only settled outcomes expire or give way: dropping one still running would let a resend run it twice. */
  private prune(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [opId, entry] of this.entries) {
      if (entry.settledAt !== null && entry.settledAt <= cutoff) this.entries.delete(opId);
    }
  }

  private evictOverCap(): void {
    for (const [opId, entry] of this.entries) {
      if (this.entries.size <= this.maxRetained) return;
      if (entry.settledAt !== null) this.entries.delete(opId);
    }
  }
}

const ledger = new FleetSubmitLedger();

/** This host's agent runs, as fleet targets. Ids are this host's own terminal ids. */
export async function listLocalFleetTargets(): Promise<HostFleetTarget[]> {
  const pty = getPtyClient();
  if (!pty) return [];
  const availability = getAgentAvailabilityStore();
  const terminals = await pty.getAllTerminalsAsync();
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
    if (out.length >= MAX_FLEET_TARGETS) break;
  }
  return out;
}

function refuse(
  code: "NOT_FOUND" | "VALIDATION" | "DRIVEN_ELSEWHERE",
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

/** Every worktree of this host's open projects. */
export async function listLocalWorktrees(): Promise<HostWorktreeEntry[]> {
  const client = getWorkspaceClientRef();
  if (!client) return [];
  const out: HostWorktreeEntry[] = [];
  for (const project of openProjects()) {
    let states;
    try {
      states = await client.getAllStatesForProjectAsync(project.path, project.id);
    } catch {
      continue;
    }
    for (const state of states) {
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
      });
      if (out.length >= MAX_HOST_WORKTREES) return out;
    }
  }
  return out;
}
