import type { HostFleetTarget, HostWorktreeEntry } from "../../../shared/types/ipc/hostMetrics.js";
import { getAgentConfig } from "../../../shared/config/agentRegistry.js";
import { LOCAL_HOST_ID } from "../../../shared/types/remoteHosts.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { projectStore } from "../../services/ProjectStore.js";
import { classifyRun } from "../../services/projectAgentCounts.js";
import { AppError } from "../../utils/errorTypes.js";
import { getPtyClient, getWorkspaceClientRef } from "../../window/serviceRefs.js";
import { openProjects } from "./hostSources.js";
import { MAX_FLEET_SUBMIT_CHARS, MAX_FLEET_TARGETS, MAX_HOST_WORKTREES } from "./linkMethods.js";

/**
 * Who is asking to submit: a Shell attached over a link (by its client id),
 * or this machine's own screen.
 */
export type FleetCaller = { kind: "remote"; clientId: string } | { kind: "local" };

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
export async function submitLocalFleet(
  terminalId: string,
  text: string,
  caller: FleetCaller
): Promise<void> {
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
  if (holder) {
    const drivesIt =
      caller.kind === "local" ? holder.isHostLocal : holder.clientId === caller.clientId;
    if (!drivesIt) {
      throw refuse(
        "DRIVEN_ELSEWHERE",
        `terminal ${terminalId} is driven from ${holder.clientName}`,
        `That project is being driven from ${holder.clientName}.`
      );
    }
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
