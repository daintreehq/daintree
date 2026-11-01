import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import type { AgentId } from "../../../shared/types/agent.js";
import type { DriveLeaseHolder, HostDriverObservation } from "../../../shared/types/remoteHosts.js";
import { getAgentAvailabilityStore } from "../../services/AgentAvailabilityStore.js";
import { peekDriveLeaseService } from "../../services/DriveLeaseService.js";
import { helpSessionService } from "../../services/HelpSessionService.js";
import { projectStore } from "../../services/ProjectStore.js";
import { scratchStore } from "../../services/ScratchStore.js";
import type { PtyClient } from "../../services/PtyClient.js";
import { getSharedTerminalSnapshot } from "../../services/sharedTerminalSnapshot.js";
import { classifyRun, computeProjectAgentCounts } from "../../services/projectAgentCounts.js";
import {
  getAgentVersionService,
  getCliAvailabilityServiceRef,
  getPtyClient,
  getResourceProfileService,
  getWorkspaceClientRef,
} from "../../window/serviceRefs.js";
import { executableForSpawn } from "../../utils/windowsExecutable.js";
import { readSystemMemorySnapshot } from "../../utils/systemMemory.js";
import { getSanitizedProcessEnv } from "../../utils/gitEnv.js";
import { createForgeObserver } from "./hostForges.js";
import { nameLeases } from "./driverObservations.js";
import { DriveLeaseHolderSchema } from "../link/schemas.js";
import type { HostSampleSources, ObservedAgents, SampleReaders } from "./sampler.js";

type ProjectInventory = ReturnType<typeof projectStore.getAllProjects>;

const COMMAND_TIMEOUT_MS = 2_000;
const WORKTREE_COUNT_TTL_MS = 30_000;
const AGENT_CLIS_TTL_MS = 10 * 60_000;

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true, env },
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
export function openProjects(projects: ProjectInventory = projectStore.getAllProjects()) {
  return projects.filter(
    (project) => project.status === "active" || project.status === "background"
  );
}

/**
 * What this host's agents are doing, as its FSM observed them: the same
 * per-project tallies the project switcher shows, summed across projects.
 * Idle counts agent runs that are neither working nor waiting.
 *
 * Null when the terminals can't all be seen — no PTY client, or a shard that
 * didn't answer. The updater's restart guard reads these counts, and a tally
 * missing a shard would read a busy host as idle.
 *
 * With no options it reads everything fresh, as that guard needs. The summary
 * passes the sample's project list and the pollers' shared terminal read.
 */
export async function observeAgents(
  options: {
    projectIds?: readonly string[];
    readTerminals?: (
      pty: PtyClient
    ) => ReturnType<PtyClient["getAllTerminalsWithCompletenessAsync"]>;
  } = {}
): Promise<ObservedAgents | null> {
  const pty = getPtyClient();
  if (!pty) return null;
  const projectIds = [
    ...(options.projectIds ?? projectStore.getAllProjects().map((p) => p.id)),
    ...scratchStore.getAllScratches().map((s) => s.id),
  ];
  const { terminals, degraded } = await (options.readTerminals
    ? options.readTerminals(pty)
    : pty.getAllTerminalsWithCompletenessAsync());
  if (degraded) return null;
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

/**
 * Worktrees across the open projects, or null when any project's workspace
 * couldn't answer: a partial sum would read as fewer worktrees than there are.
 */
/** Working trees git lists for the repository at `path`, its main one included; null when git can't say. */
async function gitWorktreeCount(path: string): Promise<number | null> {
  const git = executableForSpawn("git");
  // An inherited GIT_DIR would override -C and count another repository.
  const out = await runCommand(
    git,
    ["-C", path, "worktree", "list", "--porcelain"],
    getSanitizedProcessEnv()
  );
  if (out === null) return null;
  const entries = out.split("\n\n").filter((entry) => entry.startsWith("worktree "));
  // A bare main repository has no working tree of its own.
  return entries.filter((entry) => !/^bare$/m.test(entry)).length;
}

async function countWorktrees(
  projects: ReadonlyArray<{ id: string; path: string }>
): Promise<number | null> {
  const client = getWorkspaceClientRef();
  if (!client) return null;
  try {
    const results = await Promise.all(
      projects.map((project) => client.getAllStatesForProjectResultAsync(project.path, project.id))
    );
    let count = 0;
    for (const [index, result] of results.entries()) {
      if (result.status === "ok") {
        count += result.states.length;
        continue;
      }
      // A project nobody has opened since the host started has no workspace
      // to ask (a windowless host's usual case): git itself can count it.
      if (result.reason !== "project-unavailable") return null;
      const listed = await gitWorktreeCount(projects[index]!.path);
      if (listed === null) return null;
      count += listed;
    }
    return count;
  } catch {
    return null;
  }
}

/**
 * Each of this host's projects someone drives, newest control first, and
 * whether its holder is there. Read without settling any lease, so it adds no
 * moves or grace to what {@link currentDriver}'s reads already do.
 */
function currentDrivers(
  projects: () => ProjectInventory = () => projectStore.getAllProjects()
): HostDriverObservation[] {
  const lease = peekDriveLeaseService();
  if (!lease) return [];
  const names = new Map(projects().map((project) => [project.id, project.name]));
  return nameLeases(
    lease.snapshotLeases().filter((observation) => names.has(observation.projectId)),
    (projectId) => names.get(projectId) ?? null
  );
}

/**
 * The most recent holder across this host's projects, when anyone drives one.
 * One a Shell's schema would refuse (an id from a reservation file longer than
 * the link carries) is passed over, or the whole summary would be.
 */
function currentDriver(
  projects: () => ProjectInventory = () => projectStore.getAllProjects()
): DriveLeaseHolder | null {
  const lease = peekDriveLeaseService();
  if (!lease) return null;
  let latest: DriveLeaseHolder | null = null;
  for (const project of projects()) {
    const holder = lease.getHolder(project.id);
    if (!holder || !DriveLeaseHolderSchema.safeParse(holder).success) continue;
    if (!latest || holder.acquiredAt > latest.acquiredAt) latest = holder;
  }
  return latest;
}

/** The sources a real host samples from. Slow reads are cached so the 5 s tick stays cheap. */
export function createHostSampleSources(now: () => number = Date.now): HostSampleSources {
  let worktrees: { count: number; at: number } | null = null;
  let clis: { list: Array<{ agentId: string; version: string | null }>; at: number } | null = null;
  const forges = createForgeObserver(now);
  const platform: HostSampleSources["platform"] =
    process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";

  async function projectsSample(open: ProjectInventory) {
    if (!worktrees || now() - worktrees.at > WORKTREE_COUNT_TTL_MS) {
      const count = await countWorktrees(open);
      // An incomplete count is unknown, and isn't cached: the next sample asks again.
      if (count === null) return { projectCount: open.length, worktreeCount: null };
      worktrees = { count, at: now() };
    }
    return { projectCount: open.length, worktreeCount: worktrees.count };
  }

  return {
    platform,
    cpus: () => os.cpus().map((cpu) => cpu.times),
    totalmem: () => os.totalmem(),
    systemMemorySnapshot: () => readSystemMemorySnapshot(),
    loadavg: () => os.loadavg(),
    readText,
    run: runCommand,
    listDir,
    thermalState() {
      if (platform !== "darwin") return null;
      const state = getResourceProfileService()?.getSnapshot().thermalState;
      return state && state !== "unknown" ? state : null;
    },
    agents: () => observeAgents({ readTerminals: getSharedTerminalSnapshot }),
    projects: () => projectsSample(openProjects()),
    driver: () => currentDriver(),
    drivers: () => currentDrivers(),
    beginSample(): SampleReaders {
      // One project list per sample, failure included: a store that threw for
      // one reader is unknown to all three, and the next sample asks again.
      let read: { projects: ProjectInventory } | { error: unknown } | null = null;
      const inventory = (): ProjectInventory => {
        if (!read) {
          try {
            read = { projects: projectStore.getAllProjects() };
          } catch (error) {
            read = { error };
          }
        }
        if ("error" in read) throw read.error;
        return read.projects;
      };
      return {
        agents: async () =>
          observeAgents({
            projectIds: inventory().map((p) => p.id),
            readTerminals: getSharedTerminalSnapshot,
          }),
        projects: async () => projectsSample(openProjects(inventory())),
        driver: () => currentDriver(inventory),
        drivers: () => currentDrivers(inventory),
      };
    },
    async agentClis() {
      if (clis && now() - clis.at < AGENT_CLIS_TTL_MS) return clis.list;
      const service = getCliAvailabilityServiceRef();
      const availability = service?.getAvailability();
      const versions = getAgentVersionService();
      if (!availability) {
        // Nothing has checked yet: a windowless host has no view to ask, so
        // this asks, and the next sample lists what it found.
        void service?.checkAvailability().catch(() => {});
        return clis?.list ?? [];
      }
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
    forges,
    now,
  };
}
