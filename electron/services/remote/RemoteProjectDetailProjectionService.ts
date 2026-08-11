import { createHash } from "node:crypto";
import type { FleetRunRow, FleetSnapshot } from "../../../shared/types/ipc/fleet.js";
import type { Project } from "../../../shared/types/project.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import {
  RemoteProjectSnapshotSchema,
  type RemoteAgentRun,
  type RemoteProjectSnapshot,
  type RemoteProjectSummary,
  type RemoteWorktreeSummary,
} from "../../../shared/types/remote/index.js";

export type RendererProjectionStatus = "available" | "loading" | "evicted" | "unavailable";

export interface RendererAgentPanel {
  panelId: string;
  worktreeSourceId: string;
  agentId: string;
  launchGeneration?: number;
  placement?: "grid" | "dock";
  displayName: string;
  title: string;
  spawnedAt?: number;
  spawnedRemotely: boolean;
  resumable: boolean;
  connectionState?: "live" | "starting" | "restored" | "exited";
}

export interface RendererPanelProjection {
  projectId: string;
  rendererGeneration: number;
  revision: number;
  status: RendererProjectionStatus;
  panels: RendererAgentPanel[];
}

export interface RemoteDetailProjectSource {
  getProjectById(projectId: string): Project | null;
}

export interface RemoteDetailWorkspaceSource {
  getAllStatesForProjectAsync(
    projectPath: string,
    expectedProjectId: string
  ): Promise<WorktreeSnapshot[]>;
}

export interface RemoteDetailFleetSource {
  getLastBroadcast(): FleetSnapshot | null;
}

export interface RemoteRendererPanelSource {
  get(projectId: string): RendererPanelProjection | null;
}

export interface RemoteGenerationSource {
  currentGeneration(panelId: string): number | undefined;
}

export interface RemoteRunBinding {
  projectId: string;
  worktreeId: string;
  panelId: string;
  launchGeneration: number;
  projectionRevision: number;
}

export type RemoteBindingVerdict =
  | { ok: true }
  | {
      ok: false;
      code:
        | "PROJECT_NOT_FOUND"
        | "WORKTREE_NOT_FOUND"
        | "RUN_NOT_FOUND"
        | "RUN_GENERATION_CHANGED"
        | "PROJECTION_STALE";
    };

interface CachedProjection {
  fingerprint: string;
  snapshot: RemoteProjectSnapshot;
}

const MAX_WORKTREES = 500;
const MAX_AGENTS = 1_000;

function safeText(value: string, max: number, fallback: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[\p{C}]/gu, "")
    .trim();
  return [...normalized].slice(0, max).join("") || fallback;
}

function safeTitle(value: string, fallback: string, max = 512): string {
  const normalized = safeText(value, max, fallback);
  if (
    /(^|\s)\/(?:[^\s/]+\/)+[^\s]*/u.test(normalized) ||
    /(^|\s)[A-Za-z]:\\/u.test(normalized) ||
    normalized.startsWith("\\\\")
  ) {
    return fallback;
  }
  return normalized;
}

function opaqueWorktreeId(projectId: string, sourceId: string): string {
  const digest = createHash("sha256")
    .update("daintree-remote-worktree\0")
    .update(projectId)
    .update("\0")
    .update(sourceId)
    .digest("base64url");
  return `wt:${digest.slice(0, 32)}`;
}

function projectSummary(project: Project, runs: readonly FleetRunRow[]): RemoteProjectSummary {
  const emoji = project.emoji?.trim().normalize("NFC");
  const safeIcon = emoji && [...emoji].length <= 8 && !/[<>&\p{C}]/u.test(emoji) ? emoji : null;
  return {
    id: project.id,
    name: safeTitle(project.name, "Untitled project", 256),
    ...(safeIcon ? { icon: { kind: "emoji" as const, value: safeIcon } } : {}),
    status: project.status ?? "closed",
    attention: {
      waiting: runs.filter((run) => run.agentState === "waiting").length,
      working: runs.filter((run) => run.agentState === "working" || run.agentState === "directing")
        .length,
      completed: runs.filter((run) => run.agentState === "completed").length,
    },
    order: 0,
  };
}

function mapFleetState(run: FleetRunRow): RemoteAgentRun["state"] {
  if (run.agentState === "working" || run.agentState === "directing") return "working";
  if (run.agentState === "waiting") return "waiting";
  if (run.agentState === "completed") return "completed";
  if (run.agentState === "exited") return "exited";
  return "starting";
}

export class RemoteProjectDetailProjectionService {
  private revision = 0;
  private readonly cache = new Map<string, CachedProjection>();
  private readonly worktreeSources = new Map<string, Map<string, string>>();

  constructor(
    private readonly projects: RemoteDetailProjectSource,
    private readonly workspaces: RemoteDetailWorkspaceSource,
    private readonly fleet: RemoteDetailFleetSource,
    private readonly rendererPanels: RemoteRendererPanelSource,
    private readonly generations: RemoteGenerationSource
  ) {}

  currentGeneration(panelId: string): number | undefined {
    return this.generations.currentGeneration(panelId);
  }

  async resolveWorktreeSource(projectId: string, worktreeId: string): Promise<string | null> {
    const snapshot = await this.snapshot(projectId);
    const worktree = snapshot.worktrees.find((candidate) => candidate.id === worktreeId);
    if (!worktree || worktree.availability !== "available") return null;
    return this.worktreeSources.get(projectId)?.get(worktreeId) ?? null;
  }

  async snapshot(projectId: string): Promise<RemoteProjectSnapshot> {
    const project = this.projects.getProjectById(projectId);
    if (!project) throw new Error("PROJECT_NOT_FOUND");

    const retained = this.cache.get(projectId)?.snapshot;
    const livePanelProjection = this.rendererPanels.get(projectId);
    if (!livePanelProjection && retained) {
      const fingerprint = JSON.stringify({
        project: retained.project,
        worktrees: retained.worktrees,
        agents: retained.agents.map((agent) => ({
          ...agent,
          state: "unavailable",
          connectionState: "unavailable",
          continuityState: "unavailable",
        })),
        projectionState: "evicted",
        degraded: true,
        lastSuccessfulAt: retained.lastSuccessfulAt,
      });
      const previous = this.cache.get(projectId)!;
      if (previous.fingerprint === fingerprint) return previous.snapshot;
      this.revision += 1;
      const snapshot = RemoteProjectSnapshotSchema.parse({
        ...JSON.parse(fingerprint),
        revision: this.revision,
      });
      this.cache.set(projectId, { fingerprint, snapshot });
      return snapshot;
    }
    const panelProjection = livePanelProjection ?? {
      projectId,
      rendererGeneration: 0,
      revision: 0,
      status: "evicted" as const,
      panels: [],
    };

    let sourceWorktrees: WorktreeSnapshot[] = [];
    let workspaceAvailable = true;
    try {
      sourceWorktrees = (
        await this.workspaces.getAllStatesForProjectAsync(project.path, project.id)
      ).slice(0, MAX_WORKTREES);
      if (sourceWorktrees.length === 0) workspaceAvailable = false;
    } catch {
      workspaceAvailable = false;
    }

    const sourceToRemote = new Map<string, string>();
    const remoteToSource = new Map<string, string>();
    const worktrees: RemoteWorktreeSummary[] = sourceWorktrees.map((worktree) => {
      const sourceId = worktree.worktreeId || worktree.id;
      const remoteId = opaqueWorktreeId(projectId, sourceId);
      const branch = worktree.branch ? safeTitle(worktree.branch, "") : "";
      sourceToRemote.set(worktree.id, remoteId);
      sourceToRemote.set(worktree.worktreeId, remoteId);
      remoteToSource.set(remoteId, sourceId);
      return {
        id: remoteId,
        name: safeTitle(worktree.name, "Unnamed worktree", 256),
        ...(branch ? { branch } : {}),
        isMain: worktree.isMainWorktree === true,
        isCurrent: worktree.isCurrent,
        availability: workspaceAvailable ? "available" : "unknown",
      };
    });
    this.worktreeSources.set(projectId, remoteToSource);

    const fleetSnapshot = this.fleet.getLastBroadcast();
    const projectRuns = (fleetSnapshot?.runs ?? []).filter((run) => run.workspaceId === projectId);
    const fleetByPanel = new Map(projectRuns.map((run) => [run.runId, run]));
    const agents: RemoteAgentRun[] = [];
    for (const panel of panelProjection.panels.slice(0, MAX_AGENTS)) {
      let remoteWorktreeId = sourceToRemote.get(panel.worktreeSourceId);
      if (!remoteWorktreeId) {
        remoteWorktreeId = opaqueWorktreeId(projectId, panel.worktreeSourceId);
        sourceToRemote.set(panel.worktreeSourceId, remoteWorktreeId);
        worktrees.push({
          id: remoteWorktreeId,
          name: "Unavailable worktree",
          isMain: false,
          isCurrent: false,
          availability: workspaceAvailable ? "missing" : "unknown",
        });
      }
      const live = fleetByPanel.get(panel.panelId);
      const generation = this.currentGeneration(panel.panelId) ?? panel.launchGeneration ?? 0;
      const projectionUnavailable = panelProjection.status !== "available";
      const state = !workspaceAvailable
        ? "unavailable"
        : projectionUnavailable
          ? panelProjection.status === "loading"
            ? "starting"
            : "unavailable"
          : live
            ? mapFleetState(live)
            : panel.connectionState === "exited"
              ? "exited"
              : panel.connectionState === "starting" || panel.connectionState === "live"
                ? "starting"
                : "restored";
      const connectionState: RemoteAgentRun["connectionState"] = !workspaceAvailable
        ? "unavailable"
        : projectionUnavailable
          ? panelProjection.status === "loading"
            ? "starting"
            : "unavailable"
          : live || panel.connectionState === "live"
            ? "live"
            : panel.connectionState === "starting"
              ? "starting"
              : panel.connectionState === "exited"
                ? "exited"
                : "restored";
      const continuityState: RemoteAgentRun["continuityState"] =
        connectionState === "restored"
          ? "restored-screen"
          : connectionState === "starting"
            ? "starting"
            : connectionState;
      agents.push({
        panelId: panel.panelId,
        launchGeneration: generation,
        projectId,
        worktreeId: remoteWorktreeId,
        agentId: panel.agentId,
        displayName: safeTitle(panel.displayName, "Agent", 256),
        title: safeTitle(panel.title, safeTitle(panel.displayName, "Agent", 256)),
        state,
        connectionState,
        continuityState,
        resumeState: panel.resumable ? "resumable-by-cli" : "not-resumable",
        ...(live?.waitingReason ? { waitingReason: live.waitingReason } : {}),
        ...(live?.since !== undefined ? { stateSince: live.since } : {}),
        ...(panel.spawnedAt !== undefined ? { spawnedAt: panel.spawnedAt } : {}),
        spawnedRemotely: panel.spawnedRemotely,
        resumable: panel.resumable,
      });
    }
    if (worktrees.length === 0) {
      worktrees.push({
        id: opaqueWorktreeId(projectId, project.path),
        name: safeTitle(project.name, "Unavailable worktree", 256),
        isMain: true,
        isCurrent: false,
        availability: "unknown",
      });
    }

    const degraded =
      !workspaceAvailable ||
      panelProjection.status !== "available" ||
      fleetSnapshot === null ||
      fleetSnapshot.degraded;
    const material = {
      project: projectSummary(project, projectRuns),
      worktrees,
      agents,
      projectionState: panelProjection.status,
      degraded,
      lastSuccessfulAt: degraded ? (fleetSnapshot?.lastSuccessfulAt ?? null) : Date.now(),
    };
    const fingerprint = JSON.stringify({
      ...material,
      lastSuccessfulAt: degraded ? material.lastSuccessfulAt : null,
    });
    const previous = this.cache.get(projectId);
    if (previous?.fingerprint === fingerprint) return previous.snapshot;
    this.revision += 1;
    const snapshot = RemoteProjectSnapshotSchema.parse({ ...material, revision: this.revision });
    this.cache.set(projectId, { fingerprint, snapshot });
    return snapshot;
  }

  validateBinding(binding: RemoteRunBinding): RemoteBindingVerdict {
    const snapshot = this.cache.get(binding.projectId)?.snapshot;
    if (!snapshot) return { ok: false, code: "PROJECT_NOT_FOUND" };
    if (snapshot.revision !== binding.projectionRevision) {
      return { ok: false, code: "PROJECTION_STALE" };
    }
    if (!snapshot.worktrees.some((worktree) => worktree.id === binding.worktreeId)) {
      return { ok: false, code: "WORKTREE_NOT_FOUND" };
    }
    const run = snapshot.agents.find(
      (agent) => agent.panelId === binding.panelId && agent.worktreeId === binding.worktreeId
    );
    if (!run) return { ok: false, code: "RUN_NOT_FOUND" };
    if (
      run.launchGeneration !== binding.launchGeneration ||
      this.currentGeneration(binding.panelId) !== binding.launchGeneration
    ) {
      return { ok: false, code: "RUN_GENERATION_CHANGED" };
    }
    return { ok: true };
  }
}
