import { describe, expect, it, vi } from "vitest";
import type { FleetSnapshot } from "../../../../shared/types/ipc/fleet.js";
import type { Project } from "../../../../shared/types/project.js";
import type { WorktreeSnapshot } from "../../../../shared/types/workspace-host.js";
import {
  RemoteProjectDetailProjectionService,
  type RendererPanelProjection,
} from "../RemoteProjectDetailProjectionService.js";
import { RemoteProjectDetailSubscriptionService } from "../RemoteProjectDetailSubscriptionService.js";
import type { RemoteSession } from "../RemoteSessionRegistry.js";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    path: "/private/repos/secret-project",
    name: "Portal",
    emoji: "🌲",
    status: "background",
    lastOpened: 1,
    ...overrides,
  };
}

function worktree(id: string, overrides: Partial<WorktreeSnapshot> = {}): WorktreeSnapshot {
  return {
    id,
    path: `/private/worktrees/${id}`,
    name: id === "main" ? "Portal" : id,
    branch: id === "main" ? "develop" : `feature/${id}`,
    isCurrent: id === "main",
    isMainWorktree: id === "main",
    worktreeId: id,
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

function panels(overrides: Partial<RendererPanelProjection> = {}): RendererPanelProjection {
  return {
    projectId: "project-1",
    rendererGeneration: 3,
    revision: 7,
    status: "available",
    panels: [],
    ...overrides,
  };
}

function service(
  options: {
    worktrees?: WorktreeSnapshot[] | Error;
    fleet?: FleetSnapshot | null;
    panels?: RendererPanelProjection | null;
    generations?: Record<string, number | undefined>;
  } = {}
) {
  const sourceProject = project();
  return new RemoteProjectDetailProjectionService(
    {
      getProjectById: (id) => (id === sourceProject.id ? sourceProject : null),
    },
    {
      getAllStatesForProjectAsync: async () => {
        if (options.worktrees instanceof Error) throw options.worktrees;
        return options.worktrees ?? [worktree("main"), worktree("feature-a")];
      },
    },
    { getLastBroadcast: () => options.fleet ?? fleet() },
    { get: () => options.panels ?? panels() },
    { currentGeneration: (id) => options.generations?.[id] }
  );
}

describe("RemoteProjectDetailProjectionService", () => {
  it("projects multiple worktrees and eligible persistent agents with stable opaque bindings", async () => {
    const projection = panels({
      panels: [
        {
          panelId: "panel-live",
          worktreeSourceId: "main",
          agentId: "claude",
          displayName: "Claude",
          title: "Fix authentication",
          spawnedAt: 900,
          spawnedRemotely: true,
          resumable: true,
        },
        {
          panelId: "panel-restored",
          worktreeSourceId: "feature-a",
          agentId: "codex",
          displayName: "Codex",
          title: "Review changes",
          spawnedAt: 800,
          spawnedRemotely: false,
          resumable: true,
        },
      ],
    });
    const result = await service({
      panels: projection,
      generations: { "panel-live": 4 },
      fleet: fleet({
        runs: [
          {
            runId: "panel-live",
            workspaceId: "project-1",
            worktreeId: "main",
            agentId: "claude",
            agentState: "waiting",
            waitingReason: "prompt",
            since: 950,
            spawnedAt: 900,
            cwd: "/private/live-cwd",
            title: "raw private title",
          },
        ],
      }),
    }).snapshot("project-1");

    expect(result.project.id).toBe("project-1");
    expect(result.worktrees).toHaveLength(2);
    expect(result.worktrees.map(({ id }) => id)).not.toContain("main");
    expect(result.worktrees[0]).toMatchObject({
      name: "Portal",
      branch: "develop",
      isMain: true,
      isCurrent: true,
      availability: "available",
    });
    expect(result.agents).toEqual([
      expect.objectContaining({
        panelId: "panel-live",
        launchGeneration: 4,
        projectId: "project-1",
        worktreeId: result.worktrees[0]?.id,
        agentId: "claude",
        state: "waiting",
        connectionState: "live",
        continuityState: "live",
        resumeState: "resumable-by-cli",
        waitingReason: "prompt",
        spawnedRemotely: true,
        resumable: true,
      }),
      expect.objectContaining({
        panelId: "panel-restored",
        launchGeneration: 0,
        worktreeId: result.worktrees[1]?.id,
        state: "restored",
        continuityState: "restored-screen",
        resumeState: "resumable-by-cli",
      }),
    ]);
    expect(result.revision).toBeGreaterThan(0);
    expect(result.degraded).toBe(false);

    const serialized = JSON.stringify(result);
    for (const secret of [
      "/private/repos",
      "/private/worktrees",
      "/private/live-cwd",
      "raw private title",
      "worktreeSourceId",
      "rendererGeneration",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("excludes mixed non-agent, ephemeral, trashed, and unsupported panels at the renderer boundary", async () => {
    const result = await service({
      panels: panels({
        panels: [
          {
            panelId: "eligible",
            worktreeSourceId: "main",
            agentId: "claude",
            displayName: "Claude",
            title: "Eligible",
            spawnedRemotely: false,
            resumable: false,
          },
        ],
      }),
      generations: { eligible: 1 },
    }).snapshot("project-1");

    expect(result.agents.map(({ panelId }) => panelId)).toEqual(["eligible"]);
    expect(JSON.stringify(result)).not.toContain("browser");
  });

  it("retains persisted panels on workspace failure and marks their worktrees unavailable", async () => {
    const result = await service({
      worktrees: new Error("workspace host crashed at /private/repos/secret-project"),
      panels: panels({
        panels: [
          {
            panelId: "persisted-panel",
            worktreeSourceId: "missing-worktree",
            agentId: "codex",
            displayName: "Codex",
            title: "/private/repos/secret-project/persisted-run",
            spawnedRemotely: false,
            resumable: true,
          },
        ],
      }),
    }).snapshot("project-1");

    expect(result.degraded).toBe(true);
    expect(result.worktrees).toEqual([
      expect.objectContaining({ availability: "unknown", name: "Unavailable worktree" }),
    ]);
    expect(result.agents[0]).toMatchObject({
      state: "unavailable",
      connectionState: "unavailable",
      continuityState: "unavailable",
      resumeState: "resumable-by-cli",
      launchGeneration: 0,
    });
    expect(result.agents[0]?.title).toBe("Codex");
    expect(JSON.stringify(result)).not.toContain("workspace host crashed");
  });

  it.each([
    ["loading", "loading"],
    ["evicted", "unavailable"],
    ["unavailable", "unavailable"],
  ] as const)("represents a %s renderer projection explicitly", async (status, agentState) => {
    const result = await service({
      panels: panels({
        status,
        panels: [
          {
            panelId: "retained",
            worktreeSourceId: "main",
            agentId: "claude",
            displayName: "Claude",
            title: "Retained",
            spawnedRemotely: false,
            resumable: true,
          },
        ],
      }),
    }).snapshot("project-1");

    expect(result.degraded).toBe(true);
    expect(result.projectionState).toBe(status);
    expect(result.agents[0]?.state).toBe(agentState === "loading" ? "starting" : agentState);
  });

  it("fails closed when the live PTY generation changes after a snapshot", async () => {
    let generation = 5;
    const detail = service({
      panels: panels({
        panels: [
          {
            panelId: "panel-live",
            worktreeSourceId: "main",
            agentId: "claude",
            displayName: "Claude",
            title: "Live",
            spawnedRemotely: false,
            resumable: false,
          },
        ],
      }),
      generations: {},
    });
    vi.spyOn(detail, "currentGeneration").mockImplementation(() => generation);
    const result = await detail.snapshot("project-1");

    expect(
      detail.validateBinding({
        projectId: "project-1",
        worktreeId: result.worktrees[0]!.id,
        panelId: "panel-live",
        launchGeneration: 5,
        projectionRevision: result.revision,
      })
    ).toEqual({ ok: true });
    generation = 6;
    expect(
      detail.validateBinding({
        projectId: "project-1",
        worktreeId: result.worktrees[0]!.id,
        panelId: "panel-live",
        launchGeneration: 5,
        projectionRevision: result.revision,
      })
    ).toEqual({ ok: false, code: "RUN_GENERATION_CHANGED" });
  });

  it("retains the last rendered hierarchy as unavailable when the renderer cache is evicted", async () => {
    let projection: RendererPanelProjection | null = panels({
      panels: [
        {
          panelId: "panel-live",
          worktreeSourceId: "main",
          agentId: "claude",
          displayName: "Claude",
          title: "Live",
          spawnedRemotely: false,
          resumable: false,
        },
      ],
    });
    const detail = new RemoteProjectDetailProjectionService(
      { getProjectById: () => project() },
      { getAllStatesForProjectAsync: async () => [worktree("main")] },
      { getLastBroadcast: () => fleet() },
      { get: () => projection },
      { currentGeneration: () => 2 }
    );
    const available = await detail.snapshot("project-1");
    projection = null;
    const evicted = await detail.snapshot("project-1");

    expect(evicted.revision).toBeGreaterThan(available.revision);
    expect(evicted.worktrees).toEqual(available.worktrees);
    expect(evicted.agents[0]).toMatchObject({
      panelId: "panel-live",
      worktreeId: available.agents[0]?.worktreeId,
      state: "unavailable",
      connectionState: "unavailable",
      continuityState: "unavailable",
      resumeState: "not-resumable",
    });
    expect(evicted).toMatchObject({ projectionState: "evicted", degraded: true });
  });

  it("reports restored screen, resumable CLI state, process exit, and host loss without claiming process survival", async () => {
    let panelProjection: RendererPanelProjection | null = panels({
      panels: [
        {
          panelId: "remote-panel",
          worktreeSourceId: "main",
          agentId: "claude",
          displayName: "Claude",
          title: "Continue remotely",
          spawnedRemotely: true,
          resumable: true,
          connectionState: "live",
        },
      ],
    });
    let fleetSnapshot: FleetSnapshot | null = fleet({
      runs: [
        {
          runId: "remote-panel",
          workspaceId: "project-1",
          worktreeId: "main",
          agentId: "claude",
          agentState: "working",
          since: 1_100,
          spawnedAt: 1_000,
          cwd: "/private/worktrees/main",
        },
      ],
    });
    let mainGeneration: number | undefined = 6;
    const detail = new RemoteProjectDetailProjectionService(
      { getProjectById: () => project() },
      { getAllStatesForProjectAsync: async () => [worktree("main")] },
      { getLastBroadcast: () => fleetSnapshot },
      { get: () => panelProjection },
      { currentGeneration: () => mainGeneration }
    );

    const live = await detail.snapshot("project-1");
    expect(live.agents[0]).toMatchObject({
      panelId: "remote-panel",
      launchGeneration: 6,
      spawnedRemotely: true,
      continuityState: "live",
      resumeState: "resumable-by-cli",
    });

    fleetSnapshot = fleet();
    mainGeneration = undefined;
    panelProjection = panels({
      revision: 8,
      panels: [
        {
          ...panelProjection.panels[0]!,
          launchGeneration: 6,
          connectionState: "restored",
        },
      ],
    });
    const restored = await detail.snapshot("project-1");
    expect(restored.agents[0]).toMatchObject({
      panelId: live.agents[0]?.panelId,
      worktreeId: live.agents[0]?.worktreeId,
      launchGeneration: live.agents[0]?.launchGeneration,
      continuityState: "restored-screen",
      resumeState: "resumable-by-cli",
    });
    expect(restored.agents[0]).not.toHaveProperty("processSurvivesRestart");
    expect(restored.agents[0]).not.toHaveProperty("transcript");

    panelProjection = panels({
      revision: 9,
      panels: [
        {
          ...panelProjection.panels[0]!,
          resumable: false,
          connectionState: "exited",
        },
      ],
    });
    const exited = await detail.snapshot("project-1");
    expect(exited.agents[0]).toMatchObject({
      continuityState: "exited",
      resumeState: "not-resumable",
    });

    panelProjection = null;
    const unavailable = await detail.snapshot("project-1");
    expect(unavailable.agents[0]).toMatchObject({
      panelId: "remote-panel",
      continuityState: "unavailable",
      resumeState: "not-resumable",
    });
  });

  it("emits bounded revision notifications for selected-project lifecycle changes", async () => {
    const snapshots = [
      await service().snapshot("project-1"),
      {
        ...(await service({ panels: panels({ status: "evicted" }) }).snapshot("project-1")),
        revision: 9,
      },
    ];
    const session = {
      id: "session-1",
      capabilities: ["observe-projects"],
      connection: { id: "connection-1" },
    } as RemoteSession;
    const sendUpdate = vi.fn();
    const subscriptions = new RemoteProjectDetailSubscriptionService(
      { snapshot: vi.fn(async () => snapshots.shift()!) },
      { readySessions: () => [session] },
      sendUpdate
    );
    subscriptions.select(session.id, "project-1", 1);

    await subscriptions.pollNow();
    expect(sendUpdate).not.toHaveBeenCalled();
    await subscriptions.pollNow();
    expect(sendUpdate).toHaveBeenCalledWith(session, {
      projectId: "project-1",
      baseRevision: 1,
      revision: 9,
    });
  });
});
