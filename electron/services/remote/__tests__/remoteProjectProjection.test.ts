import { describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../shared/types/project.js";
import type { FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import {
  RemoteProjectProjectionService,
  type RemoteProjectProjectionUpdate,
} from "../RemoteProjectProjectionService.js";

function project(id: string, name: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    path: `/private/repositories/${id}`,
    name,
    emoji: "🌲",
    lastOpened: 1,
    status: "closed",
    color: "secret-theme-value",
    ...overrides,
  };
}

function fleet(overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    runs: [],
    changedAt: 1_000,
    degraded: false,
    lastSuccessfulAt: 1_000,
    ...overrides,
  };
}

describe("RemoteProjectProjectionService", () => {
  it("preserves ProjectStore ordering and projects recognizable redacted identity and attention", () => {
    const projects = [
      project("project-hot", "Hot project", { status: "active", emoji: "🔥" }),
      project("project-recent", "Recent project", { status: "background", emoji: "🚀" }),
      project("project-old", "Old project", { status: "missing", emoji: "<svg>secret</svg>" }),
    ];
    const snapshot = fleet({
      runs: [
        {
          runId: "run-waiting",
          workspaceId: "project-hot",
          agentState: "waiting",
          spawnedAt: 1,
          cwd: "/private/worktree/waiting",
          title: "private terminal title",
        },
        {
          runId: "run-working",
          workspaceId: "project-hot",
          agentState: "working",
          spawnedAt: 1,
          cwd: "/private/worktree/working",
        },
        {
          runId: "run-completed",
          workspaceId: "project-recent",
          agentState: "completed",
          spawnedAt: 1,
          cwd: "/private/worktree/completed",
        },
      ],
    });
    const service = new RemoteProjectProjectionService(
      { getAllProjects: () => projects },
      { getLastBroadcast: () => snapshot }
    );

    const result = service.snapshot();
    expect(result.projects.map(({ id }) => id)).toEqual([
      "project-hot",
      "project-recent",
      "project-old",
    ]);
    expect(result.projects[0]).toMatchObject({
      name: "Hot project",
      icon: { kind: "emoji", value: "🔥" },
      status: "active",
      attention: { waiting: 1, working: 1, completed: 0 },
      order: 0,
    });
    expect(result.projects[1]?.attention).toEqual({ waiting: 0, working: 0, completed: 1 });
    expect(result.projects[2]).not.toHaveProperty("icon");
    const serialized = JSON.stringify(result);
    for (const canary of [
      "/private/repositories",
      "/private/worktree",
      "secret-theme-value",
      "private terminal title",
      "frecencyScore",
      "lastOpened",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("emits coherent add, remove, rename, order, attention, and stale deltas", () => {
    let projects = [project("project-a", "Alpha"), project("project-b", "Beta")];
    let snapshot = fleet();
    const service = new RemoteProjectProjectionService(
      { getAllProjects: () => projects },
      { getLastBroadcast: () => snapshot }
    );
    const updates: RemoteProjectProjectionUpdate[] = [];
    service.subscribe((update) => updates.push(update));
    service.refresh();
    projects = [project("project-c", "Gamma"), project("project-a", "Alpha renamed")];
    snapshot = fleet({
      degraded: true,
      lastSuccessfulAt: 1_000,
      runs: [
        {
          runId: "run-a",
          workspaceId: "project-a",
          agentState: "waiting",
          spawnedAt: 1,
          cwd: "/not-exported",
        },
      ],
    });
    service.refresh();

    expect(updates[0]).toMatchObject({ kind: "snapshot", value: { revision: 1 } });
    expect(updates[1]).toMatchObject({
      kind: "delta",
      value: {
        baseRevision: 1,
        revision: 2,
        removedIds: ["project-b"],
        resyncRequired: false,
        degraded: true,
      },
    });
    if (updates[1]?.kind !== "delta") throw new Error("Expected delta");
    expect(updates[1].value.upserted.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "project-c", order: 0 },
      { id: "project-a", order: 1 },
    ]);
    expect(updates[1].value.upserted[1]?.attention.waiting).toBe(1);
  });

  it("bounds large changes with a resync signal instead of an oversized delta", () => {
    let projects = Array.from({ length: 101 }, (_, index) =>
      project(`project-${index}`, `Project ${index}`)
    );
    const service = new RemoteProjectProjectionService(
      { getAllProjects: () => projects },
      { getLastBroadcast: () => fleet() }
    );
    const listener = vi.fn();
    service.subscribe(listener);
    service.refresh();
    projects = projects.map((item) => ({ ...item, name: `${item.name} renamed` }));
    service.refresh();

    expect(listener).toHaveBeenLastCalledWith({
      kind: "delta",
      value: expect.objectContaining({
        upserted: [],
        removedIds: [],
        resyncRequired: true,
      }),
    });
  });
});
