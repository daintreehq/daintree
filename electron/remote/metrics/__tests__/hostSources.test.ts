import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  client: null as null | { getAllStatesForProjectResultAsync: ReturnType<typeof vi.fn> },
}));

const cli = vi.hoisted(() => ({
  service: null as null | {
    getAvailability: ReturnType<typeof vi.fn>;
    checkAvailability: ReturnType<typeof vi.fn>;
  },
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
  getCliAvailabilityServiceRef: () => cli.service,
  getResourceProfileService: () => null,
  getWorkspaceClientRef: () => workspace.client,
}));
const store = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; path: string; status: string }>,
}));
const DEFAULT_PROJECTS = [
  { id: "p1", path: "/p1", status: "active" },
  { id: "p2", path: "/p2", status: "background" },
];
const getAllProjects = vi.hoisted(() => vi.fn(() => store.projects));
vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: { getAllProjects },
}));
const scratches = vi.hoisted(() => ({ list: [] as Array<{ id: string }> }));
vi.mock("../../../services/ScratchStore.js", () => ({
  scratchStore: { getAllScratches: () => scratches.list },
}));
vi.mock("../../../services/HelpSessionService.js", () => ({
  helpSessionService: { isPanelVisible: () => false, getSlotForTerminal: () => null },
}));
vi.mock("../../../services/AgentAvailabilityStore.js", () => ({
  getAgentAvailabilityStore: () => ({ isHelpTerminal: () => false }),
}));
const lease = vi.hoisted(() => ({
  holders: null as null | Record<string, { acquiredAt: number }>,
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () =>
    lease.holders ? { getHolder: (id: string) => lease.holders?.[id] ?? null } : null,
}));
const computeProjectAgentCounts = vi.hoisted(() =>
  vi.fn(
    (_ids: string[], terminals: Array<{ agentState?: string }>) =>
      new Map([
        [
          "p1",
          {
            active: terminals.filter((t) => t.agentState === "working").length,
            waiting: terminals.filter((t) => t.agentState === "waiting").length,
          },
        ],
      ])
  )
);
vi.mock("../../../services/projectAgentCounts.js", () => ({
  classifyRun: () => null,
  computeProjectAgentCounts,
}));

import { createHostSampleSources, observeAgents } from "../hostSources.js";

const WORKING = { id: "t1", projectId: "p1", agentState: "working" };

beforeEach(() => {
  store.projects = DEFAULT_PROJECTS;
  getAllProjects.mockReset();
  getAllProjects.mockImplementation(() => store.projects);
  lease.holders = null;
  scratches.list = [];
  computeProjectAgentCounts.mockClear();
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
  it("asks for agent CLIs itself when nothing has, so a windowless host lists them next sample", async () => {
    cli.service = {
      getAvailability: vi.fn(() => null),
      checkAvailability: vi.fn(async () => ({})),
    };
    const sources = createHostSampleSources();
    await expect(sources.agentClis()).resolves.toEqual([]);
    expect(cli.service.checkAvailability).toHaveBeenCalledTimes(1);
    cli.service = null;
  });

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

  it("counts a project no workspace has loaded yet from git's own worktree list", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-wt-"));
    try {
      const repo = path.join(root, "repo");
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
      fs.mkdirSync(repo);
      git("init", "-q");
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
      git("worktree", "add", "-q", path.join(root, "wt"));
      store.projects = [
        { id: "loaded", path: "/loaded", status: "active" },
        { id: "unloaded", path: repo, status: "background" },
      ];
      workspace.client = {
        getAllStatesForProjectResultAsync: vi.fn(async (projectPath: string) =>
          projectPath === "/loaded"
            ? { status: "ok", projectId: "loaded", states: [{}] }
            : { status: "unavailable", reason: "project-unavailable" }
        ),
      };
      await expect(createHostSampleSources().projects()).resolves.toEqual({
        projectCount: 2,
        worktreeCount: 3,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("one host-summary sample", () => {
  // The shared terminal read ages by the wall clock; a paused runner must not expire it mid-test.
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function sampleOnce(sources = createHostSampleSources()) {
    const readers = sources.beginSample!();
    const [agents, projects] = await Promise.all([readers.agents(), readers.projects()]);
    return { agents, projects, driver: readers.driver() };
  }

  it("lists the projects once for its agents, projects and driver", async () => {
    store.projects = [...DEFAULT_PROJECTS, { id: "p3", path: "/p3", status: "closed" }];
    scratches.list = [{ id: "s1" }];
    lease.holders = { p2: { acquiredAt: 5 }, p3: { acquiredAt: 9 } };
    await expect(sampleOnce()).resolves.toEqual({
      agents: { working: 1, waiting: 0, idle: 0 },
      projects: { projectCount: 2, worktreeCount: null },
      // A closed project's lease still counts, as it did when each reader listed its own.
      driver: { acquiredAt: 9 },
    });
    expect(getAllProjects).toHaveBeenCalledTimes(1);
    // Every registered project and scratch, not only the open ones.
    expect(computeProjectAgentCounts.mock.calls[0]![0]).toEqual(["p1", "p2", "p3", "s1"]);
  });

  it("lists them again next sample, so a change shows", async () => {
    const sources = createHostSampleSources();
    await sampleOnce(sources);
    store.projects = [DEFAULT_PROJECTS[0]!];
    await expect(sampleOnce(sources)).resolves.toMatchObject({
      projects: { projectCount: 1 },
    });
    expect(getAllProjects).toHaveBeenCalledTimes(2);
    expect(computeProjectAgentCounts.mock.calls[1]![0]).toEqual(["p1"]);
  });

  it("is unknown everywhere the list was needed when the store fails, and asks once", async () => {
    lease.holders = { p1: { acquiredAt: 1 } };
    getAllProjects.mockImplementationOnce(() => {
      throw new Error("db locked");
    });
    const readers = createHostSampleSources().beginSample!();
    await expect(readers.agents()).rejects.toThrow("db locked");
    await expect(readers.projects()).rejects.toThrow("db locked");
    expect(() => readers.driver()).toThrow("db locked");
    expect(getAllProjects).toHaveBeenCalledTimes(1);
  });

  it("shares the background pollers' terminal read", async () => {
    const sources = createHostSampleSources();
    await sampleOnce(sources);
    await sampleOnce(sources);
    expect(pty.client!.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(1);
  });

  it("never hands the restart guard the shared read", async () => {
    // The summary cached an idle host; an agent has started since.
    pty.client!.getAllTerminalsWithCompletenessAsync.mockResolvedValueOnce({
      terminals: [],
      degraded: false,
      shardsTotal: 2,
      shardsFailed: 0,
    });
    await expect(sampleOnce()).resolves.toMatchObject({
      agents: { working: 0, waiting: 0, idle: 0 },
    });
    await expect(observeAgents()).resolves.toEqual({ working: 1, waiting: 0, idle: 0 });
    expect(pty.client!.getAllTerminalsWithCompletenessAsync).toHaveBeenCalledTimes(2);

    pty.client!.getAllTerminalsWithCompletenessAsync.mockResolvedValueOnce({
      terminals: [],
      degraded: true,
      shardsTotal: 2,
      shardsFailed: 1,
    });
    await expect(observeAgents()).resolves.toBeNull();
  });
});
