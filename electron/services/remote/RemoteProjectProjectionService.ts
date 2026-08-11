import type { Project } from "../../../shared/types/project.js";
import {
  RemoteProjectsSnapshotSchema,
  RemoteProjectsUpdatedSchema,
  type RemoteProjectSummary,
  type RemoteProjectsSnapshot,
  type RemoteProjectsUpdated,
} from "../../../shared/types/remote/index.js";
import type { FleetSnapshot } from "../../../shared/types/ipc/fleet.js";

const PROJECT_POLL_MS = 5_000;
const MAX_PROJECTS = 500;
const MAX_DELTA_CHANGES = 100;

export interface RemoteProjectSource {
  getAllProjects(): Project[];
}

export interface RemoteFleetSource {
  getLastBroadcast(): FleetSnapshot | null;
}

export type RemoteProjectProjectionUpdate =
  | { kind: "snapshot"; value: RemoteProjectsSnapshot }
  | { kind: "delta"; value: RemoteProjectsUpdated };

function safeEmoji(value: string): string | null {
  const normalized = value.trim().normalize("NFC");
  const points = [...normalized];
  if (points.length === 0 || points.length > 8 || /[<>&\p{C}]/u.test(normalized)) return null;
  return normalized;
}

export class RemoteProjectProjectionService {
  private revision = 0;
  private current: RemoteProjectsSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<(update: RemoteProjectProjectionUpdate) => void>();

  constructor(
    private readonly projects: RemoteProjectSource,
    private readonly fleet: RemoteFleetSource
  ) {}

  start(): void {
    if (this.timer) return;
    this.refresh();
    this.timer = setInterval(() => this.refresh(), PROJECT_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.current = null;
    this.revision = 0;
  }

  snapshot(): RemoteProjectsSnapshot {
    this.refresh();
    return this.current!;
  }

  subscribe(listener: (update: RemoteProjectProjectionUpdate) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): void {
    const nextProjects = this.buildProjects();
    const fleet = this.fleet.getLastBroadcast();
    const degraded = fleet?.degraded ?? true;
    const lastSuccessfulAt = fleet?.lastSuccessfulAt ?? null;
    if (
      this.current &&
      JSON.stringify(this.current.projects) === JSON.stringify(nextProjects) &&
      this.current.degraded === degraded &&
      this.current.lastSuccessfulAt === lastSuccessfulAt
    ) {
      return;
    }

    const baseRevision = this.revision;
    this.revision += 1;
    const next = RemoteProjectsSnapshotSchema.parse({
      projects: nextProjects,
      revision: this.revision,
      degraded,
      lastSuccessfulAt,
    });
    if (!this.current) {
      this.current = next;
      this.emit({ kind: "snapshot", value: next });
      return;
    }

    const previousById = new Map(this.current.projects.map((project) => [project.id, project]));
    const nextIds = new Set(next.projects.map((project) => project.id));
    const upserted = next.projects.filter(
      (project) => JSON.stringify(previousById.get(project.id)) !== JSON.stringify(project)
    );
    const removedIds = this.current.projects
      .filter((project) => !nextIds.has(project.id))
      .map((project) => project.id);
    this.current = next;
    if (upserted.length + removedIds.length > MAX_DELTA_CHANGES) {
      this.emit({
        kind: "delta",
        value: RemoteProjectsUpdatedSchema.parse({
          baseRevision,
          revision: next.revision,
          upserted: [],
          removedIds: [],
          resyncRequired: true,
          degraded,
          lastSuccessfulAt,
        }),
      });
      return;
    }
    this.emit({
      kind: "delta",
      value: RemoteProjectsUpdatedSchema.parse({
        baseRevision,
        revision: next.revision,
        upserted,
        removedIds,
        resyncRequired: false,
        degraded,
        lastSuccessfulAt,
      }),
    });
  }

  private buildProjects(): RemoteProjectSummary[] {
    const source = this.projects.getAllProjects().slice(0, MAX_PROJECTS);
    const fleet = this.fleet.getLastBroadcast();
    const attention = new Map<string, RemoteProjectSummary["attention"]>();
    for (const run of fleet?.runs ?? []) {
      const current = attention.get(run.workspaceId) ?? { waiting: 0, working: 0, completed: 0 };
      if (run.agentState === "waiting") current.waiting += 1;
      if (run.agentState === "working") current.working += 1;
      if (run.agentState === "completed") current.completed += 1;
      attention.set(run.workspaceId, current);
    }
    return source.map((project, order) => {
      const icon = safeEmoji(project.emoji);
      return {
        id: project.id,
        name: [...project.name.normalize("NFC")].slice(0, 256).join(""),
        ...(icon ? { icon: { kind: "emoji" as const, value: icon } } : {}),
        status: project.status ?? "closed",
        attention: attention.get(project.id) ?? { waiting: 0, working: 0, completed: 0 },
        order,
      };
    });
  }

  private emit(update: RemoteProjectProjectionUpdate): void {
    for (const listener of this.listeners) listener(update);
  }
}
