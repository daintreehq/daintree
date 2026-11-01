import { describe, expect, it } from "vitest";
import type { PaneIdentity } from "@daintreehq/decisions-client";
import {
  createPaneAccess,
  type PaneAccessSources,
  type PaneBearer,
  type PaneTerminalInfo,
} from "../paneAccess.js";

const TOKEN = "pane-token";

interface World {
  bearers: Map<string, PaneBearer>;
  principals: Map<string, string>;
  generations: Map<string, number>;
  records: Map<string, PaneTerminalInfo>;
  hostId: string | null;
  /** Runs while the record is being read. */
  duringRead?: () => void;
  readFails?: boolean;
  noClient?: boolean;
}

function world(info: Partial<PaneTerminalInfo> = {}): World {
  return {
    bearers: new Map([[TOKEN, { paneId: "pane-1", principal: "principal-1", workspaceId: "p1" }]]),
    principals: new Map([["pane-1", "principal-1"]]),
    generations: new Map([["pane-1", 7]]),
    records: new Map([
      [
        "pane-1",
        {
          projectId: "p1",
          worktreeId: "wt-1",
          cwd: "/repo/wt-1",
          launchAgentId: "codex",
          agentIncarnation: 2,
          launchGeneration: 7,
          hasPty: true,
          ...info,
        },
      ],
    ]),
    hostId: "host_a",
  };
}

function sources(w: World): PaneAccessSources {
  return {
    bearerFor: (token) => w.bearers.get(token) ?? null,
    principalFor: (paneId) => w.principals.get(paneId) ?? null,
    hostId: () => w.hostId,
    getPtyClient: () =>
      w.noClient
        ? null
        : {
            getLiveGeneration: (id) => w.generations.get(id) ?? null,
            isLiveGeneration: (id, generation) => w.generations.get(id) === generation,
            getTerminalAsync: async (id) => {
              w.duringRead?.();
              if (w.readFails) throw new Error("TIMEOUT");
              return w.records.get(id) ?? null;
            },
          },
  };
}

describe("createPaneAccess", () => {
  it("builds the origin from the bearer and the pane's record alone", async () => {
    const w = world({ detectedAgentId: "claude", agentSessionId: "sess-9" });
    const result = await createPaneAccess(sources(w)).authenticator.authenticate(TOKEN);
    expect(result?.origin).toEqual({
      host_id: "host_a",
      pane_id: "pane-1",
      terminal_generation: 7,
      ownership_principal: "principal-1",
      agent_incarnation: "2",
      agent_kind: "claude",
      agent_session_id: "sess-9",
      project_id: "p1",
      worktree_id: "wt-1",
      worktree_root: "/repo/wt-1",
      workflow_gate_id: null,
    });
  });

  it("names the launched agent while none has been detected, and no session while none is known", async () => {
    const result = await createPaneAccess(sources(world())).authenticator.authenticate(TOKEN);
    expect(result?.origin).toMatchObject({ agent_kind: "codex", agent_session_id: null });
  });

  it("refuses tokens that aren't a live pane bearer", async () => {
    const access = createPaneAccess(sources(world()));
    for (const token of ["", "api-key", "help-token", "plugin-grant"]) {
      expect(await access.authenticator.authenticate(token), token).toBeNull();
    }
  });

  it.each<[string, Partial<PaneTerminalInfo>]>([
    ["has exited", { isExited: true }],
    ["has no process", { hasPty: false }],
    ["is in the trash", { isTrashed: true }],
    ["is the Assistant", { isAssistantTerminal: true }],
    ["is another launch's record", { launchGeneration: 6 }],
    ["has no agent incarnation", { agentIncarnation: undefined }],
    ["names no agent", { launchAgentId: undefined }],
    ["has no project", { projectId: undefined }],
    ["has no worktree", { worktreeId: undefined }],
    ["is in another project than its launch bound", { projectId: "p2" }],
  ])("refuses a pane that %s", async (_label, info) => {
    const access = createPaneAccess(sources(world(info)));
    expect(await access.authenticator.authenticate(TOKEN)).toBeNull();
  });

  it("refuses everything before a relay identity gives this machine a host id", async () => {
    const w = world();
    w.hostId = null;
    expect(await createPaneAccess(sources(w)).authenticator.authenticate(TOKEN)).toBeNull();
  });

  it("refuses a pane whose run changed while its record was read", async () => {
    for (const change of [
      (w: World) => w.bearers.delete(TOKEN),
      (w: World) => w.generations.set("pane-1", 8),
      (w: World) => w.principals.set("pane-1", "principal-2"),
    ]) {
      const w = world();
      w.duringRead = () => change(w);
      expect(await createPaneAccess(sources(w)).authenticator.authenticate(TOKEN)).toBeNull();
    }
  });

  it("throws rather than refuses when the pane can't be read, so a slow host isn't a bad credential", async () => {
    const slow = world();
    slow.readFails = true;
    await expect(
      createPaneAccess(sources(slow)).authenticator.authenticate(TOKEN)
    ).rejects.toThrow();
    const none = world();
    none.noClient = true;
    await expect(
      createPaneAccess(sources(none)).authenticator.authenticate(TOKEN)
    ).rejects.toThrow();
  });

  it("holds a pane current only while host, principal and generation are still the ones it asked with", async () => {
    const w = world();
    const access = createPaneAccess(sources(w));
    const origin = (await access.authenticator.authenticate(TOKEN))!.origin;
    const pane: PaneIdentity = {
      host_id: origin.host_id,
      pane_id: origin.pane_id,
      terminal_generation: origin.terminal_generation,
      ownership_principal: origin.ownership_principal,
      agent_incarnation: origin.agent_incarnation,
      agent_session_id: origin.agent_session_id,
      worktree_id: origin.worktree_id,
    };
    expect(access.isCurrent(pane)).toBe(true);

    w.principals.delete("pane-1");
    expect(access.isCurrent(pane)).toBe(false);
    w.principals.set("pane-1", "principal-1");
    w.generations.set("pane-1", 8);
    expect(access.isCurrent(pane)).toBe(false);
    w.generations.set("pane-1", 7);
    w.hostId = "host_b";
    expect(access.isCurrent(pane)).toBe(false);
  });
});
