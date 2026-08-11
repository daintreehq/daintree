import { describe, expect, it } from "vitest";
import {
  RemoteRendererLaunchAgentRequestSchema,
  RemoteRendererRequestSchema,
  RemoteRendererResponseSchema,
} from "../remoteRendererBridge.js";

const launch = {
  requestId: "request-1",
  projectId: "project-1",
  webContentsId: 41,
  rendererGeneration: 3,
  method: "remote:launchAgent" as const,
  worktreeId: "worktree-1",
  agentId: "claude",
  requestedPanelId: "panel-request-1",
  source: "remote" as const,
  persistent: true as const,
  focusPolicy: "preserve" as const,
};

describe("remote renderer bridge schemas", () => {
  it("accepts the complete generation-bound persistent remote launch contract", () => {
    expect(RemoteRendererLaunchAgentRequestSchema.parse(launch)).toEqual(launch);
  });

  it.each([
    { source: "mcp" },
    { persistent: false },
    { focusPolicy: "take" },
    { rendererGeneration: 0 },
    { webContentsId: -1 },
    { actionId: "terminal.kill" },
  ])("rejects authority or generic-action widening: %o", (mutation) => {
    expect(RemoteRendererRequestSchema.safeParse({ ...launch, ...mutation }).success).toBe(false);
  });

  it("rejects a response whose binding generation or result provenance is malformed", () => {
    const response = {
      requestId: launch.requestId,
      projectId: launch.projectId,
      webContentsId: launch.webContentsId,
      rendererGeneration: launch.rendererGeneration,
      method: launch.method,
      ok: true,
      result: {
        projectId: launch.projectId,
        worktreeId: launch.worktreeId,
        requestedPanelId: launch.requestedPanelId,
        panelId: "panel-actual-1",
        launchGeneration: 7,
        placement: "grid",
        spawnStatus: "starting",
        source: "remote",
        persistent: true,
        focusPolicy: "take",
      },
    };

    expect(RemoteRendererResponseSchema.safeParse(response).success).toBe(false);
  });
});
