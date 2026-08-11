import { describe, expect, it } from "vitest";
import type { PanelInstance, PtyPanelData } from "@shared/types/panel";
import { buildRemotePanelProjectionFromPanels } from "../useRemotePanelProjection";

function terminal(id: string, overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id,
    kind: "terminal",
    title: "Claude",
    titleMode: "user",
    location: "grid",
    worktreeId: "/private/worktrees/main",
    cwd: "/private/worktrees/main",
    cols: 80,
    rows: 24,
    launchAgentId: "claude",
    hasPty: true,
    ...overrides,
  };
}

describe("buildRemotePanelProjectionFromPanels", () => {
  it("includes persistent user-visible agents and excludes mixed private panel kinds", () => {
    const panels: PanelInstance[] = [
      terminal("eligible", { agentSessionId: "private-session-id" }),
      terminal("ephemeral", { excludeFromPersistence: true }),
      terminal("trashed", { location: "trash" }),
      terminal("assistant", { launchAgentId: "daintree-assistant" }),
      terminal("unsupported-plugin", { launchAgentId: "private-plugin-agent" }),
      {
        id: "browser",
        kind: "browser",
        title: "Private browser",
        location: "grid",
        worktreeId: "/private/worktrees/main",
        browserUrl: "https://secret.example",
      },
      {
        id: "review",
        kind: "review",
        title: "Private review",
        location: "grid",
        worktreeId: "/private/worktrees/main",
      },
    ];

    const result = buildRemotePanelProjectionFromPanels("project-1", panels);

    expect(result.panels.map(({ panelId }) => panelId)).toEqual(["eligible"]);
    expect(result.panels[0]).toMatchObject({
      agentId: "claude",
      displayName: "Claude",
      title: "Claude",
      connectionState: "live",
      resumable: true,
    });
    const serialized = JSON.stringify(result);
    for (const secret of ["private-session-id", "secret.example", "Private review", "cwd"])
      expect(serialized).not.toContain(secret);
  });

  it("keeps persistent exited panels as explicit historical runs", () => {
    const result = buildRemotePanelProjectionFromPanels("project-1", [
      terminal("exited", {
        hasPty: false,
        runtimeStatus: "exited",
        agentState: "exited",
        exitCode: 0,
      }),
    ]);

    expect(result.panels[0]).toMatchObject({ panelId: "exited", connectionState: "exited" });
  });

  it("projects a remote-created panel through live, restored, and exited desktop lifecycle states", () => {
    const identity = {
      id: "remote-panel",
      spawnedBy: "remote" as const,
      agentSessionId: "cli-session",
      startedAt: 1_700_000_000_000,
    };
    const live = buildRemotePanelProjectionFromPanels("project-1", [
      terminal(identity.id, identity),
    ]);
    const restored = buildRemotePanelProjectionFromPanels("project-1", [
      terminal(identity.id, { ...identity, hasPty: false }),
    ]);
    const exited = buildRemotePanelProjectionFromPanels("project-1", [
      terminal(identity.id, {
        ...identity,
        hasPty: false,
        runtimeStatus: "exited",
        agentState: "exited",
        exitCode: 0,
      }),
    ]);

    for (const projection of [live, restored, exited]) {
      expect(projection.panels[0]).toMatchObject({
        panelId: identity.id,
        worktreeSourceId: "/private/worktrees/main",
        agentId: "claude",
        spawnedRemotely: true,
        resumable: true,
        spawnedAt: identity.startedAt,
      });
      expect(JSON.stringify(projection)).not.toContain(identity.agentSessionId);
    }
    expect([live, restored, exited].map((value) => value.panels[0]?.connectionState)).toEqual([
      "live",
      "restored",
      "exited",
    ]);
  });
});
