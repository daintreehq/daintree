import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import type { AgentId } from "../../../shared/types/agent.js";
import type { DriveLeaseHolder, HostPlatform } from "../../../shared/types/remoteHosts.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import { projectStore } from "../../services/ProjectStore.js";
import { scratchStore } from "../../services/ScratchStore.js";
import { classifyRun, computeProjectAgentCounts } from "../../services/projectAgentCounts.js";
import {
  getAgentVersionService,
  getCliAvailabilityServiceRef,
  getPtyClient,
  getResourceProfileService,
  getWorkspaceClientRef,
} from "../../window/serviceRefs.js";
import type { HostSampleSources, ObservedAgents } from "./sampler.js";

const COMMAND_TIMEOUT_MS = 2_000;
const WORKTREE_COUNT_TTL_MS = 30_000;
const AGENT_CLIS_TTL_MS = 10 * 60_000;

function runCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? null : String(stdout))
    );
  });
}

async function readText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

/** Projects with a live workspace on this host: what "open" means here. */
export function openProjects() {
  return projectStore
    .getAllProjects()
    .filter((project) => project.status === "active" || project.status === "background");
}

/**
 * What this host's agents are doing, as its FSM observed them: the same
 * per-project tallies the project switcher shows, summed across projects.
 * Idle counts agent runs that are neither working nor waiting.
 */
export async function observeAgents(): Promise<ObservedAgents> {
  const pty = getPtyClient();
  if (!pty) return { working: 0, waiting: 0, idle: 0 };
  const projectIds = [
    ...projectStore.getAllProjects().map((p) => p.id),
    ...scratchStore.getAllScratches().map((s) => s.id),
  ];
  const terminals = await pty.getAllTerminalsAsync();
  const counts = computeProjectAgentCounts(
    projectIds,
    terminals,
    undefined,
    undefined,
    (id) => helpSessionService.isPanelVisible(id),
    (terminalId) => helpSessionService.getSlotForTerminal(terminalId)
  );
  let working = 0;
  let waiting = 0;
  for (const entry of counts.values()) {
    working += entry.active;
    waiting += entry.waiting;
  }
  const availability = getAgentAvailabilityStore();
  let idle = 0;
  const known = new Set(projectIds);
  for (const terminal of terminals) {
    if (!terminal.projectId || !known.has(terminal.projectId)) continue;
    if (classifyRun(terminal, (id) => availability.isHelpTerminal(id)) !== null) continue;
    if (terminal.agentState === "idle" || terminal.agentState === "completed") idle += 1;
  }
  return { working, waiting, idle };
}

/** The most recent holder across this host's projects, when anyone drives one. */
function currentDriver(): DriveLeaseHolder | null {
  const lease = peekDriveLeaseService();
  if (!lease) return null;
  let latest: DriveLeaseHolder | null = null;
  for (const project of projectStore.getAllProjects()) {
    const holder = lease.getHolder(project.id);
    if (holder && (!latest || holder.acquiredAt > latest.acquiredAt)) latest = holder;
  }
  return latest;
}

/** The sources a real host samples from. Slow reads are cached so the 5 s tick stays cheap. */
export function createHostSampleSources(now: () => number = Date.now): HostSampleSources {
  let worktrees: { count: number; at: number } | null = null;
  let clis: { list: Array<{ agentId: string; version: string | null }>; at: number } | null = null;
  const platform: HostPlatform = process.platform === "darwin" ? "darwin" : "linux";

  return {
    platform,
    cpus: () => os.cpus().map((cpu) => cpu.times),
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    readText,
    run: runCommand,
    listDir,
    thermalState() {
      if (platform !== "darwin") return null;
      const state = getResourceProfileService()?.getSnapshot().thermalState;
      return state && state !== "unknown" ? state : null;
    },
    agents: observeAgents,
    async projects() {
      const open = openProjects();
      if (!worktrees || now() - worktrees.at > WORKTREE_COUNT_TTL_MS) {
        const client = getWorkspaceClientRef();
        const count = client ? (await client.getAllStatesAsync()).length : 0;
        worktrees = { count, at: now() };
      }
      return { projectCount: open.length, worktreeCount: worktrees.count };
    },
    driver: currentDriver,
    async agentClis() {
      if (clis && now() - clis.at < AGENT_CLIS_TTL_MS) return clis.list;
      const availability = getCliAvailabilityServiceRef()?.getAvailability();
      const versions = getAgentVersionService();
      if (!availability) return clis?.list ?? [];
      const installed = (Object.entries(availability) as Array<[AgentId, string]>)
        .filter(([, state]) => state !== "missing")
        .map(([agentId]) => agentId);
      const list = await Promise.all(
        installed.map(async (agentId) => {
          try {
            const info = await versions?.getVersion(agentId);
            return { agentId, version: info?.installedVersion ?? null };
          } catch {
            return { agentId, version: null };
          }
        })
      );
      clis = { list, at: now() };
      return list;
    },
    now,
  };
}
