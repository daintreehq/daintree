import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DriveLeaseHolder } from "../../../../shared/types/remoteHosts.js";

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

const profile = vi.hoisted(() => ({
  service: null as null | { getSnapshot: () => { thermalState: string } },
}));

const runs = vi.hoisted(() => ({
  handBacks: null as null | {
    getRecord: (id: string) => { stoppedAt: number; seenAt?: number } | undefined;
    getWait: (id: string) => { stoppedAt: number; seenAt?: number } | undefined;
  },
  attention: null as null | {
    getActiveSnoozes: () => Map<string, { snoozedUntil?: number }>;
    getAll: () => Map<string, unknown>;
  },
}));

vi.mock("../../../window/serviceRefs.js", () => ({
  getPtyClient: () => pty.client,
  getAgentVersionService: () => null,
  getCliAvailabilityServiceRef: () => cli.service,
  getResourceProfileService: () => profile.service,
  getRunAttentionServiceRef: () => runs.attention,
  getRunHandBackServiceRef: () => runs.handBacks,
  getWorkspaceClientRef: () => workspace.client,
}));
const store = vi.hoisted(() => ({
  projects: [] as Array<{ id: string; path: string; status: string; name?: string }>,
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
  holders: null as null | Record<string, DriveLeaseHolder>,
  away: new Set<string>(),
}));
function holder(acquiredAt: number, clientId = `c${acquiredAt}`): DriveLeaseHolder {
  return {
    leaseId: acquiredAt,
    endpointId: `s${acquiredAt}:e1`,
    clientId,
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt,
  };
}
vi.mock("../../../services/DriveLeaseService.js", () => ({
  peekDriveLeaseService: () =>
    lease.holders
      ? {
          getHolder: (id: string) => lease.holders?.[id] ?? null,
          snapshotLeases: () =>
            Object.entries(lease.holders ?? {}).map(([projectId, holder]) => ({
              projectId,
              holder,
              state: lease.away.has(projectId) ? "away" : "live",
              awayUntil: lease.away.has(projectId) ? 99 : null,
            })),
        }
      : null,
}));
// The real tallies, watched: a host's summary is only as right as the counts
// the switcher reads, so they are never stood in for here.
vi.mock("../../../services/projectAgentCounts.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../services/projectAgentCounts.js")>();
  return { ...real, computeProjectAgentCounts: vi.fn(real.computeProjectAgentCounts) };
});

import { createHostSampleSources, observeAgents } from "../hostSources.js";
import { computeProjectAgentCounts } from "../../../services/projectAgentCounts.js";
import { setCanopyRefinementSource } from "../../../services/canopy/canopyRefinementSource.js";

const WORKING = {
  id: "t1",
  projectId: "p1",
  kind: "terminal",
  detectedAgentId: "claude",
  agentState: "working",
  spawnedAt: 1,
};
const NOTHING_ASKED = { waiting: 0, blocked: 0, idle: 0 };

beforeEach(() => {
  store.projects = DEFAULT_PROJECTS;
  getAllProjects.mockReset();
  getAllProjects.mockImplementation(() => store.projects);
  lease.holders = null;
  lease.away.clear();
  scratches.list = [];
  vi.mocked(computeProjectAgentCounts).mockClear();
  runs.handBacks = null;
  runs.attention = null;
  setCanopyRefinementSource(null);
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
    await expect(observeAgents()).resolves.toEqual({
      working: 1,
      waiting: 0,
      idle: 0,
      attention: NOTHING_ASKED,
    });
  });

  it("bands its runs as its own panes do, beside what its FSM observed (#16058)", async () => {
    const run = (id: string, over: object) => ({
      id,
      projectId: "p1",
      kind: "terminal",
      detectedAgentId: "claude",
      spawnedAt: 1,
      ...over,
    });
    const terminals = [
      // At its prompt, no reading: observed waiting, asking nothing.
      run("prompt", { agentState: "waiting", waitingReason: "prompt" }),
      // A question Canopy read as an ask the user hasn't seen.
      run("asked", { agentState: "waiting", waitingReason: "question" }),
      // The same ask, seen.
      run("seen", { agentState: "waiting", waitingReason: "question" }),
      // An approval the patterns saw, already looked at.
      run("approval", { agentState: "waiting", waitingReason: "approval" }),
      run("error", { agentState: "waiting", waitingReason: "error" }),
      // Parked while Canopy reads an ask: the park wins.
      run("parked", { agentState: "waiting", waitingReason: "question" }),
      run("done", { agentState: "completed" }),
      WORKING,
    ];
    pty.client!.getAllTerminalsWithCompletenessAsync.mockResolvedValue({
      terminals,
      degraded: false,
      shardsTotal: 1,
      shardsFailed: 0,
    });
    setCanopyRefinementSource((id) =>
      id === "asked" || id === "seen" || id === "parked"
        ? { kind: "asked", quote: "Ship it?", readAt: 2, seen: id === "seen" }
        : undefined
    );
    runs.handBacks = {
      getRecord: () => undefined,
      getWait: (id) => (id === "approval" ? { stoppedAt: 2, seenAt: 3 } : undefined),
    };
    runs.attention = { getActiveSnoozes: () => new Map(), getAll: () => new Map([["parked", {}]]) };

    await expect(observeAgents()).resolves.toEqual({
      working: 1,
      waiting: 6,
      idle: 1,
      attention: { waiting: 1, blocked: 1, idle: 5 },
    });
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
  describe("platform", () => {
    const realPlatform = process.platform;
    const stub = (value: NodeJS.Platform) =>
      Object.defineProperty(process, "platform", { value, configurable: true });
    afterEach(() => {
      stub(realPlatform);
      profile.service = null;
    });

    it("names the machine it runs on, a Windows one as its own", () => {
      for (const [os, sampled] of [
        ["darwin", "darwin"],
        ["linux", "linux"],
        ["freebsd", "linux"],
        ["win32", "win32"],
      ] as const) {
        stub(os);
        expect(createHostSampleSources().platform).toBe(sampled);
      }
    });

    it("reads the macOS thermal state there and nowhere else", () => {
      profile.service = { getSnapshot: () => ({ thermalState: "fair" }) };
      for (const [os, thermal] of [
        ["darwin", "fair"],
        ["linux", null],
        ["win32", null],
      ] as const) {
        stub(os);
        expect(createHostSampleSources().thermalState()).toBe(thermal);
      }
    });
  });

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

  it("counts the project's own worktrees when Daintree inherited a GIT_DIR", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rh-wt-"));
    try {
      const git = (repo: string, ...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
      const repo = path.join(root, "repo");
      const other = path.join(root, "other");
      for (const dir of [repo, other]) {
        fs.mkdirSync(dir);
        git(dir, "init", "-q");
        git(
          dir,
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "i"
        );
      }
      git(repo, "worktree", "add", "-q", path.join(root, "wt"));
      vi.stubEnv("GIT_DIR", path.join(other, ".git"));
      store.projects = [{ id: "unloaded", path: repo, status: "background" }];
      workspace.client = {
        getAllStatesForProjectResultAsync: vi.fn(async () => ({
          status: "unavailable",
          reason: "project-unavailable",
        })),
      };
      await expect(createHostSampleSources().projects()).resolves.toEqual({
        projectCount: 1,
        worktreeCount: 2,
      });
    } finally {
      vi.unstubAllEnvs();
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
    lease.holders = { p2: holder(5), p3: holder(9) };
    await expect(sampleOnce()).resolves.toEqual({
      agents: { working: 1, waiting: 0, idle: 0, attention: NOTHING_ASKED },
      projects: { projectCount: 2, worktreeCount: null },
      // A closed project's lease still counts, as it did when each reader listed its own.
      driver: holder(9),
    });
    expect(getAllProjects).toHaveBeenCalledTimes(1);
    // Every registered project and scratch, not only the open ones.
    expect(vi.mocked(computeProjectAgentCounts).mock.calls[0]![0]).toEqual([
      "p1",
      "p2",
      "p3",
      "s1",
    ]);
  });

  it("names every driven project it lists, newest control first, away holders included", async () => {
    store.projects = [
      { id: "p1", path: "/p1", status: "active", name: "daintree" },
      { id: "p2", path: "/p2", status: "background", name: "site" },
    ];
    // A reservation for a project since removed isn't this host's to report.
    lease.holders = { p1: holder(5), p2: holder(9), gone: holder(12) };
    lease.away.add("p1");
    const readers = createHostSampleSources().beginSample!();
    expect(readers.drivers!()).toEqual([
      { projectId: "p2", projectName: "site", holder: holder(9), state: "live", awayUntil: null },
      { projectId: "p1", projectName: "daintree", holder: holder(5), state: "away", awayUntil: 99 },
    ]);
    expect(readers.driver()).toEqual(holder(9));
    expect(getAllProjects).toHaveBeenCalledTimes(1);
  });

  it("passes over a holder the link couldn't carry, rather than losing the whole summary", async () => {
    const restored = holder(12, "c".repeat(256));
    restored.endpointId = `restored:${restored.clientId}`;
    lease.holders = { p1: holder(5), p2: restored };
    const readers = createHostSampleSources().beginSample!();
    expect(readers.driver()).toEqual(holder(5));
    expect(readers.drivers!().map((driver) => driver.projectId)).toEqual(["p1"]);
  });

  it("lists them again next sample, so a change shows", async () => {
    const sources = createHostSampleSources();
    await sampleOnce(sources);
    store.projects = [DEFAULT_PROJECTS[0]!];
    await expect(sampleOnce(sources)).resolves.toMatchObject({
      projects: { projectCount: 1 },
    });
    expect(getAllProjects).toHaveBeenCalledTimes(2);
    expect(vi.mocked(computeProjectAgentCounts).mock.calls[1]![0]).toEqual(["p1"]);
  });

  it("is unknown everywhere the list was needed when the store fails, and asks once", async () => {
    lease.holders = { p1: holder(1) };
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
    await expect(observeAgents()).resolves.toMatchObject({ working: 1, waiting: 0, idle: 0 });
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
