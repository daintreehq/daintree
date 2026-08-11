// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteRendererLaunchAgentRequest } from "@shared/types/ipc/remoteRendererBridge";
import type { PtyPanelData } from "@shared/types/panel";
import { agentLifecycleLedger } from "@/services/terminal/lifecycleLedger";
import { RemoteProjectDetailProjectionService } from "../../../electron/services/remote/RemoteProjectDetailProjectionService";
import { buildRemoteAgentLaunchDispatch } from "../useRemoteRendererBridge";
import { buildRemotePanelProjectionFromPanels } from "../useRemotePanelProjection";

describe("remote launch to desktop convergence", () => {
  afterEach(() => agentLifecycleLedger.clear());

  it("uses one persistent panel identity and generation from remote dispatch through desktop and Portal", async () => {
    const request: RemoteRendererLaunchAgentRequest = {
      requestId: "request-1",
      projectId: "project-1",
      webContentsId: 17,
      rendererGeneration: 4,
      method: "remote:launchAgent",
      worktreeId: "worktree-main",
      agentId: "codex",
      requestedPanelId: "remote-panel-1",
      prompt: "Continue the implementation",
      source: "remote",
      persistent: true,
      focusPolicy: "preserve",
    };
    const dispatch = buildRemoteAgentLaunchDispatch(request);
    const desktopPanel: PtyPanelData = {
      id: dispatch.args.requestedId,
      kind: "terminal",
      title: "Remote implementation",
      titleMode: "user",
      location: "grid",
      worktreeId: dispatch.args.worktreeId,
      cwd: "/private/worktrees/main",
      cols: 80,
      rows: 24,
      launchAgentId: dispatch.args.agentId,
      spawnedBy: dispatch.args.spawnedBy,
      excludeFromPersistence: dispatch.args.excludeFromPersistence,
      removeOnExit: dispatch.args.removeOnExit,
      focusPolicy: dispatch.args.focusPolicy,
      hasPty: true,
      agentSessionId: "cli-session-1",
      startedAt: 1_700_000_000_000,
    };
    const generation = agentLifecycleLedger.recordLaunch(
      desktopPanel.id,
      {
        launchAgentId: desktopPanel.launchAgentId,
        worktreeId: desktopPanel.worktreeId,
        spawnedBy: desktopPanel.spawnedBy,
      },
      { generation: 7 }
    );
    const rendererProjection = buildRemotePanelProjectionFromPanels("project-1", [desktopPanel]);
    const details = new RemoteProjectDetailProjectionService(
      {
        getProjectById: () => ({
          id: "project-1",
          path: "/private/project",
          name: "Project",
          emoji: "🌲",
          status: "background",
          lastOpened: 1,
        }),
      },
      {
        getAllStatesForProjectAsync: async () => [
          {
            id: "worktree-main",
            worktreeId: "worktree-main",
            path: "/private/worktrees/main",
            name: "main",
            branch: "develop",
            isCurrent: false,
            isMainWorktree: true,
          },
        ],
      },
      {
        getLastBroadcast: () => ({
          runs: [
            {
              runId: desktopPanel.id,
              workspaceId: "project-1",
              worktreeId: "worktree-main",
              agentId: "codex",
              agentState: "working",
              since: 1_700_000_000_001,
              spawnedAt: desktopPanel.startedAt!,
              cwd: desktopPanel.cwd,
            },
          ],
          changedAt: 1_700_000_000_001,
          degraded: false,
          lastSuccessfulAt: 1_700_000_000_001,
        }),
      },
      {
        get: () => ({
          ...rendererProjection,
          rendererGeneration: 4,
          revision: 1,
        }),
      },
      { currentGeneration: () => generation }
    );

    const portal = await details.snapshot("project-1");
    expect(desktopPanel).toMatchObject({
      id: request.requestedPanelId,
      spawnedBy: "remote",
      excludeFromPersistence: false,
      hasPty: true,
    });
    expect(portal.agents[0]).toMatchObject({
      panelId: desktopPanel.id,
      launchGeneration: generation,
      agentId: desktopPanel.launchAgentId,
      spawnedRemotely: true,
      continuityState: "live",
      resumeState: "resumable-by-cli",
    });
    expect(JSON.stringify(portal)).not.toContain(desktopPanel.agentSessionId);
  });
});
