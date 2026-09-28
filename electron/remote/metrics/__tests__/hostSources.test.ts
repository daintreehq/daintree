import { beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  client: null as null | { getAllStatesForProjectResultAsync: ReturnType<typeof vi.fn> },
}));

const pty = vi.hoisted(() => ({
  client: null as null | {
    getAllTerminalsWithCompletenessAsync: ReturnType<typeof vi.fn>;
    getAllTerminalsAsync: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => pty.client,
  getAgentVersionService: () => null,
  getCliAvailabilityServiceRef: () => null,
  getResourceProfileService: () => null,
  getWorkspaceClientRef: () => workspace.client,
}));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: () => [
      { id: "p1", path: "/p1", status: "active" },
      { id: "p2", path: "/p2", status: "background" },
    ],
  },
}));
vi.mock("../../../services/ScratchStore.js", () => ({
  scratchStore: { getAllScratches: () => [] },
}));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: { isPanelVisible: () => false, getSlotForTerminal: () => null },
}));
vi.mock("../../../services/AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () => null,
}));
vi.mock("../../../services/projectAgentCounts.js", () => ({
  classifyRun: () => null,
  computeProjectAgentCounts: (_ids: string[], terminals: Array<{ agentState?: string }>) =>
    new Map([
      [
        "p1",
        {
          active: terminals.filter((t) => t.agentState === "working").length,
          waiting: terminals.filter((t) => t.agentState === "waiting").length,
        },
      ],
    ]),
}));

import { createHostSampleSources, observeAgents } from "../hostSources.js";

const WORKING = { id: "t1", projectId: "p1", agentState: "working" };

beforeEach(() => {
  workspace.client = null;
  pty.client = {
    getAllTerminalsWithCompletenessAsync: vi.fn(async () => ({
      terminals: [WORKING],
      degraded: false,
      shardsTotal: 2,
      shardsFailed: 0,
    })),
    getAllTerminalsAsync: vi.fn(async () => [WORKING]),
  };
});

describe("observeAgents", () => {
  it("counts what every shard reported", async () => {
    await expect(observeAgents()).resolves.toEqual({ working: 1, waiting: 0, idle: 0 });
  });

  it("is unknown when a shard didn't answer, rather than a partial count", async () => {
    // The shard that failed may hold the working agents; zero would let an update restart the host.
    pty.client!.getAllTerminalsWithCompletenessAsync.mockResolvedValue({
      terminals: [],
      degraded: true,
      shardsTotal: 2,
      shardsFailed: 1,
    });
    await expect(observeAgents()).resolves.toBeNull();
    expect(pty.client!.getAllTerminalsAsync).not.toHaveBeenCalled();
  });

  it("is unknown with no PTY client to ask", async () => {
    pty.client = null;
    await expect(observeAgents()).resolves.toBeNull();
  });
});

describe("createHostSampleSources", () => {
  it("reports worktrees as unknown when no workspace client can count them", async () => {
    await expect(createHostSampleSources().projects()).resolves.toEqual({
      projectCount: 2,
      worktreeCount: null,
    });
  });

  it("sums every open project's worktrees", async () => {
    workspace.client = {
      getAllStatesForProjectResultAsync: vi.fn(async (path: string) => ({
        status: "ok",
        projectId: path.slice(1),
        states: path === "/p1" ? [{}, {}] : [{}],
      })),
    };
    await expect(createHostSampleSources().projects()).resolves.toEqual({
      projectCount: 2,
      worktreeCount: 3,
    });
  });

  it("reports worktrees as unknown when one project's workspace can't answer", async () => {
    workspace.client = {
      getAllStatesForProjectResultAsync: vi.fn(async (path: string) =>
        path === "/p1"
          ? { status: "ok", projectId: "p1", states: [{}, {}] }
          : { status: "unavailable", reason: "workspace-unavailable" }
      ),
    };
    await expect(createHostSampleSources().projects()).resolves.toEqual({
      projectCount: 2,
      worktreeCount: null,
    });
    workspace.client.getAllStatesForProjectResultAsync.mockRejectedValue(new Error("host died"));
    await expect(createHostSampleSources().projects()).resolves.toEqual({
      projectCount: 2,
      worktreeCount: null,
    });
  });
});
