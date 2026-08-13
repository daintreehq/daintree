import { describe, expect, it, vi } from "vitest";
import type { RemoteRendererRequest } from "@shared/types/ipc/remoteRendererBridge";
import {
  buildRemoteAgentLaunchDispatch,
  createRemoteRendererRequestHandler,
} from "../useRemoteRendererBridge";

const base = {
  requestId: "request-1",
  projectId: "project-1",
  webContentsId: 41,
  rendererGeneration: 3,
};

const launch = {
  ...base,
  method: "remote:launchAgent" as const,
  worktreeId: "worktree-1",
  agentId: "claude",
  requestedPanelId: "panel-request-1",
  prompt: "Review the change",
  source: "remote" as const,
  persistent: true as const,
  focusPolicy: "preserve" as const,
};

function fixture() {
  const dispatchAgentLaunch = vi.fn(async () => ({
    ok: true as const,
    result: {
      launched: true,
      terminalId: "panel-actual-1",
      worktreeId: "worktree-1",
      location: "grid" as const,
      spawnStatus: null,
    },
  }));
  const deps = {
    getProjectId: vi.fn(() => "project-1"),
    hasWorktree: vi.fn(() => true),
    getPanelProjection: vi.fn((projectId: string) => ({
      projectId,
      status: "available" as const,
      panels: [],
    })),
    getLaunchableAgents: vi.fn((projectId: string, worktreeId: string) => ({
      projectId,
      worktreeId,
      agents: [],
    })),
    getLaunchGeneration: vi.fn(() => 7),
    closeAgent: vi.fn(async () => true),
    dispatchAgentLaunch,
  };
  return { deps, dispatchAgentLaunch, handle: createRemoteRendererRequestHandler(deps) };
}

describe("remote renderer request handler", () => {
  it("returns the requested project panel projection without exposing a generic action", async () => {
    const f = fixture();
    const response = await f.handle({ ...base, method: "remote:getPanelProjection" });

    expect(response).toMatchObject({
      ok: true,
      method: "remote:getPanelProjection",
      projectId: "project-1",
      rendererGeneration: 3,
      result: { projectId: "project-1", status: "available" },
    });
    expect(f.dispatchAgentLaunch).not.toHaveBeenCalled();
  });

  it("routes only the narrow launch request and echoes the actual persistent panel identity", async () => {
    const f = fixture();
    const response = await f.handle(launch);

    expect(f.dispatchAgentLaunch).toHaveBeenCalledWith(launch);
    expect(response).toMatchObject({
      ok: true,
      method: "remote:launchAgent",
      result: {
        requestedPanelId: "panel-request-1",
        panelId: "panel-actual-1",
        launchGeneration: 7,
        placement: "grid",
        spawnStatus: "starting",
        source: "remote",
        persistent: true,
        focusPolicy: "preserve",
      },
    });
  });

  it("fails closed before dispatch when project or worktree ownership changed", async () => {
    const wrongProject = fixture();
    wrongProject.deps.getProjectId.mockReturnValue("project-2");
    await expect(wrongProject.handle(launch)).resolves.toMatchObject({
      ok: false,
      error: { code: "PROJECT_CONTEXT_MISMATCH" },
    });

    const missingWorktree = fixture();
    missingWorktree.deps.hasWorktree.mockReturnValue(false);
    await expect(missingWorktree.handle(launch)).resolves.toMatchObject({
      ok: false,
      error: { code: "WORKTREE_NOT_FOUND" },
    });
    expect(wrongProject.dispatchAgentLaunch).not.toHaveBeenCalled();
    expect(missingWorktree.dispatchAgentLaunch).not.toHaveBeenCalled();
  });

  it("closes only the requested current pane generation", async () => {
    const f = fixture();
    const close = {
      ...base,
      method: "remote:closeAgent" as const,
      worktreeId: "worktree-1",
      panelId: "panel-1",
      launchGeneration: 7,
    };

    await expect(f.handle(close)).resolves.toMatchObject({
      ok: true,
      method: "remote:closeAgent",
      result: { panelId: "panel-1", launchGeneration: 7, closed: true },
    });
    expect(f.deps.closeAgent).toHaveBeenCalledWith("panel-1", "project-1", "worktree-1");

    f.deps.getLaunchGeneration.mockReturnValue(8);
    await expect(f.handle(close)).resolves.toMatchObject({
      ok: false,
      error: { code: "ACTION_FAILED" },
    });
    expect(f.deps.closeAgent).toHaveBeenCalledOnce();
  });

  it("returns an immediate typed failure when pane close throws", async () => {
    const f = fixture();
    f.deps.closeAgent.mockRejectedValueOnce(new TypeError("invalid panel registry"));

    await expect(
      f.handle({
        ...base,
        method: "remote:closeAgent",
        worktreeId: "worktree-1",
        panelId: "panel-1",
        launchGeneration: 7,
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "ACTION_FAILED", message: "Agent panel close failed" },
    });
  });

  it("rejects invalid payloads before any renderer operation", async () => {
    const f = fixture();
    await expect(f.handle({ ...launch, source: "mcp" })).rejects.toThrow(
      "INVALID_REMOTE_RENDERER_REQUEST"
    );
    expect(f.dispatchAgentLaunch).not.toHaveBeenCalled();
  });
});

describe("remote agent launch dispatch", () => {
  it("reuses agent.launch while stamping non-overridable provenance, persistence, and focus", () => {
    const dispatch = buildRemoteAgentLaunchDispatch(
      launch as RemoteRendererRequest & typeof launch
    );

    expect(dispatch).toEqual({
      actionId: "agent.launch",
      args: {
        agentId: "claude",
        worktreeId: "worktree-1",
        requestedId: "panel-request-1",
        prompt: "Review the change",
        presetId: undefined,
        model: undefined,
        name: undefined,
        spawnedBy: "remote",
        excludeFromPersistence: false,
        removeOnExit: false,
        activateDockOnCreate: false,
        focusPolicy: "preserve",
      },
      options: {
        source: "agent",
        contextOverride: {
          projectId: "project-1",
          activeWorktreeId: "worktree-1",
          focusedWorktreeId: "worktree-1",
        },
      },
    });
  });
});
