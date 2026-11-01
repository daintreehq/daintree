import { afterEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { AgentSessionRecord } from "../../../../shared/types/ipc/agentSessionHistory.js";
import type { PanelSnapshot, ProjectState } from "../../../../shared/types/project.js";
import type { AgentSettings } from "../../../../shared/types/agentSettings.js";
import type { ViewlessTerminalRecord } from "../ViewlessActionExecutor.js";
import {
  _resetHostStartedTerminalsForTesting,
  hostStartedTerminals,
  noteHostStartedTerminal,
} from "../hostStartedTerminals.js";
import {
  resumeAgentSessionAsPane,
  type AgentSessionPaneRequest,
  type AgentSessionPaneRuntime,
} from "../viewlessAgentResume.js";
import { makeDeps, makeHosts, makePty, makeWorktree, PROJECT } from "./viewlessTestDeps.js";

const WORKTREE = makeWorktree({
  id: "/repo-wt/feature",
  worktreeId: "/repo-wt/feature",
  path: "/repo-wt/feature",
  branch: "feature",
  gitDir: "/repo/.git/worktrees/feature",
  isMainWorktree: false,
  isCurrent: false,
});

const SESSION = "6f1c2a9e-0000-4000-8000-000000000001";

const REQUEST: AgentSessionPaneRequest = {
  projectId: PROJECT.id,
  worktreeId: WORKTREE.id,
  agentId: "claude",
  sessionId: SESSION,
};

function resumeDeps(
  options: {
    terminals?: Record<string, ViewlessTerminalRecord>;
    sessions?: AgentSessionRecord[];
    state?: ProjectState | null;
    settings?: AgentSettings | null;
    degraded?: boolean;
  } = {}
) {
  const pty = {
    ...makePty(options.terminals ?? {}),
    getAllTerminalsWithCompletenessAsync: vi.fn(async () => ({
      terminals: Object.entries(options.terminals ?? {}).map(([id, record]) => ({
        projectId: PROJECT.id,
        ...record,
        id,
      })),
      degraded: options.degraded ?? false,
    })),
  };
  const made = makeDeps(
    { getPtyReader: () => pty, getWorkspaceHosts: () => makeHosts() },
    { worktrees: [makeWorktree(), WORKTREE], state: options.state ?? null }
  );
  made.deps.agents.getSettings = async () => options.settings ?? null;
  const base = made.invoke.getMockImplementation()!;
  made.invoke.mockImplementation(async (projectId, channel, args) =>
    channel === CHANNELS.AGENT_SESSION_LIST
      ? (options.sessions ?? [])
      : base(projectId, channel, args)
  );
  return { ...made, pty };
}

function makeRuntime(overrides: Partial<AgentSessionPaneRuntime> = {}) {
  return {
    isDirectory: vi.fn(async (_path: string) => true),
    confirmSpawn: vi.fn(async (_terminalId: string, spawn: () => Promise<void>) => {
      await spawn();
      return true;
    }),
    ...overrides,
  };
}

function spawns(invoke: ReturnType<typeof makeDeps>["invoke"]) {
  return invoke.mock.calls
    .filter(([, channel]) => channel === CHANNELS.TERMINAL_SPAWN)
    .map(([, , args]) => args[0] as Record<string, unknown> & { id: string; command: string });
}

function savedPane(state: ProjectState | null, id: string): PanelSnapshot | undefined {
  return state?.terminals.find((terminal) => terminal.id === id);
}

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: SESSION,
    agentId: "claude",
    worktreeId: WORKTREE.id,
    title: "Claude",
    projectId: PROJECT.id,
    savedAt: 1,
    ...overrides,
  };
}

afterEach(() => {
  _resetHostStartedTerminalsForTesting();
});

describe("resumeAgentSessionAsPane", () => {
  it("spawns the resumed session in its worktree and records it in the saved layout", async () => {
    const { deps, invoke, store } = resumeDeps();
    const runtime = makeRuntime();

    const result = await resumeAgentSessionAsPane(REQUEST, deps, runtime);

    expect(result).toMatchObject({
      status: "launched",
      projectId: PROJECT.id,
      worktreeId: WORKTREE.id,
      cwd: WORKTREE.path,
      savedInLayout: true,
    });
    const terminalId = (result as { terminalId: string }).terminalId;
    const [payload] = spawns(invoke);
    expect(payload).toMatchObject({
      id: terminalId,
      kind: "terminal",
      projectId: PROJECT.id,
      cwd: WORKTREE.path,
      worktreeId: WORKTREE.id,
      launchAgentId: "claude",
      agentSessionId: SESSION,
      actionContext: { projectId: PROJECT.id, focusedTerminalId: terminalId },
    });
    // The CLI found by the probe, reopening exactly this conversation.
    expect(payload!.command).toMatch(/^\/usr\/local\/bin\/claude\b/);
    expect(payload!.command).toContain(`--resume ${SESSION}`);
    expect(runtime.confirmSpawn).toHaveBeenCalledWith(terminalId, expect.any(Function));

    expect(savedPane(store.read(), terminalId)).toMatchObject({
      kind: "terminal",
      location: "grid",
      worktreeId: WORKTREE.id,
      worktreeGitDir: WORKTREE.gitDir,
      launchAgentId: "claude",
      agentSessionId: SESSION,
      cwd: WORKTREE.path,
    });
    expect(savedPane(store.read(), terminalId)?.command).toContain(`--resume ${SESSION}`);
    expect(hostStartedTerminals(PROJECT.id).map((terminal) => terminal.id)).toEqual([terminalId]);
  });

  it("resumes in the journaled directory with its flags reconciled against the settings", async () => {
    const { deps, invoke, store } = resumeDeps({
      sessions: [
        record({
          cwd: "/repo-wt/feature/packages/app",
          agentLaunchFlags: ["--model", "opus", "--dangerously-skip-permissions"],
        }),
      ],
      settings: { agents: {}, globalSkipPermissions: false } as AgentSettings,
    });

    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());

    expect(result).toMatchObject({ status: "launched", cwd: "/repo-wt/feature/packages/app" });
    const [payload] = spawns(invoke);
    expect(payload!.cwd).toBe("/repo-wt/feature/packages/app");
    expect(payload!.command).toMatch(/--model '?opus'? --resume /);
    expect(payload!.command).not.toContain("--dangerously-skip-permissions");
    expect(payload!.agentLaunchFlags).toEqual(["--model", "opus"]);
    expect(savedPane(store.read(), payload!.id)?.agentLaunchFlags).toEqual(["--model", "opus"]);
  });

  it("drops a retired model from the journaled launch, as a view's resume does", async () => {
    const { deps, invoke, store } = resumeDeps({
      sessions: [record({ agentId: "copilot", agentLaunchFlags: ["--model", "gpt-5.4"] })],
    });

    const result = await resumeAgentSessionAsPane(
      { ...REQUEST, agentId: "copilot" },
      deps,
      makeRuntime()
    );

    expect(result).toMatchObject({ status: "launched" });
    const [payload] = spawns(invoke);
    expect(payload!.command).toContain(`--resume=${SESSION}`);
    expect(payload!.command).not.toContain("gpt-5.4");
    expect(savedPane(store.read(), payload!.id)?.command).not.toContain("gpt-5.4");
  });

  it("keeps no launch flags for a session the journal holds none for", async () => {
    const { deps, invoke, store } = resumeDeps({
      settings: { agents: {}, globalSkipPermissions: true } as AgentSettings,
    });

    await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());

    const [payload] = spawns(invoke);
    expect(payload!.command).toContain("--dangerously-skip-permissions");
    expect(payload!.agentLaunchFlags).toBeUndefined();
    expect(savedPane(store.read(), payload!.id)?.agentLaunchFlags).toBeUndefined();
  });

  it.each([
    ["absent", undefined],
    ["blank", "   "],
  ])("refuses with no session id (%s)", async (_label, sessionId) => {
    const { deps, invoke } = resumeDeps();
    const result = await resumeAgentSessionAsPane({ ...REQUEST, sessionId }, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "no-session-id" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([["--last"], ["latest"], ["LAST"], ["two words"], ["../x"]])(
    "refuses %s, which isn't an exact session",
    async (sessionId) => {
      const { deps, invoke } = resumeDeps();
      const result = await resumeAgentSessionAsPane({ ...REQUEST, sessionId }, deps, makeRuntime());
      expect(result).toMatchObject({ status: "refused", reason: "no-session-id" });
      expect(invoke).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["aider", "no-resume-support"],
    ["crush", "no-resume-support"],
    ["not-an-agent", "unknown-agent"],
  ])("refuses %s, which can't reopen a session by id", async (agentId, reason) => {
    const { deps, invoke } = resumeDeps();
    const result = await resumeAgentSessionAsPane({ ...REQUEST, agentId }, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses a project it doesn't know", async () => {
    const { deps } = resumeDeps();
    const result = await resumeAgentSessionAsPane(
      { ...REQUEST, projectId: "elsewhere" },
      deps,
      makeRuntime()
    );
    expect(result).toMatchObject({ status: "refused", reason: "unknown-project" });
  });

  it("refuses when the worktree is no longer listed", async () => {
    const { deps, invoke } = resumeDeps();
    const result = await resumeAgentSessionAsPane(
      { ...REQUEST, worktreeId: "/repo-wt/deleted" },
      deps,
      makeRuntime()
    );
    expect(result).toMatchObject({ status: "refused", reason: "worktree-gone" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it.each([
    ["missing", async () => false],
    ["unreadable", async (): Promise<boolean> => Promise.reject(new Error("ENOENT"))],
  ])("refuses when the session's directory is %s", async (_label, isDirectory) => {
    const { deps, invoke } = resumeDeps();
    const runtime = makeRuntime({ isDirectory: vi.fn(isDirectory) });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, runtime);
    expect(result).toMatchObject({ status: "refused", reason: "worktree-gone" });
    expect(runtime.isDirectory).toHaveBeenCalledWith(WORKTREE.path);
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses when no workspace host can list the worktrees", async () => {
    const { deps } = resumeDeps();
    deps.getWorkspaceHosts = () => null;
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "worktrees-unavailable" });
  });

  it("refuses when listing the worktrees fails", async () => {
    const { deps, invoke } = resumeDeps();
    const hosts = makeHosts();
    hosts.waitForReady.mockRejectedValue(new Error("host crashed"));
    deps.getWorkspaceHosts = () => hosts;
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "worktrees-unavailable" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses when the session history can't be read", async () => {
    const { deps, invoke } = resumeDeps();
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (projectId, channel, args) => {
      if (channel === CHANNELS.AGENT_SESSION_LIST) throw new Error("history unreadable");
      return base(projectId, channel, args);
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "history-unavailable" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it.each([
    ["the journal places it in another worktree", { sessions: [record({ worktreeId: "/repo" })] }],
    [
      "its journaled directory is outside the worktree",
      { sessions: [record({ worktreeId: null, cwd: "/repo/src" })] },
    ],
    [
      "its directory walks out of the worktree",
      { sessions: [record({ cwd: "/repo-wt/feature/child/../app" })] },
    ],
  ])("refuses to relaunch a session elsewhere when %s", async (_label, options) => {
    const { deps, invoke } = resumeDeps(options);
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "other-worktree" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("resumes in the caller's directory when the journal holds none", async () => {
    const { deps, invoke } = resumeDeps();
    const result = await resumeAgentSessionAsPane(
      { ...REQUEST, cwd: "/repo-wt/feature/packages/web" },
      deps,
      makeRuntime()
    );
    expect(result).toMatchObject({ status: "launched", cwd: "/repo-wt/feature/packages/web" });
    expect(spawns(invoke)[0]!.cwd).toBe("/repo-wt/feature/packages/web");
  });

  it("prefers the journaled directory to the caller's", async () => {
    const { deps, invoke } = resumeDeps({
      sessions: [record({ cwd: "/repo-wt/feature/packages/app" })],
    });
    await resumeAgentSessionAsPane(
      { ...REQUEST, cwd: "/repo-wt/feature/packages/web" },
      deps,
      makeRuntime()
    );
    expect(spawns(invoke)[0]!.cwd).toBe("/repo-wt/feature/packages/app");
  });

  it("refuses a journaled directory outside the worktree whatever the caller passes", async () => {
    const { deps, invoke } = resumeDeps({
      sessions: [record({ worktreeId: null, cwd: "/other/repo" })],
    });
    const result = await resumeAgentSessionAsPane(
      { ...REQUEST, cwd: WORKTREE.path },
      deps,
      makeRuntime()
    );
    expect(result).toMatchObject({ status: "refused", reason: "other-worktree" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses a caller's directory outside the worktree", async () => {
    const { deps } = resumeDeps();
    const result = await resumeAgentSessionAsPane(
      { ...REQUEST, cwd: "/somewhere/else" },
      deps,
      makeRuntime()
    );
    expect(result).toMatchObject({ status: "refused", reason: "other-worktree" });
  });

  it("returns the pane already holding the session instead of launching another", async () => {
    const { deps, invoke } = resumeDeps({
      terminals: {
        "pane-1": { agentSessionId: SESSION, worktreeId: WORKTREE.id, hasPty: true },
      },
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: [{ id: "pane-1", kind: "terminal", location: "background" } as PanelSnapshot],
      },
    });

    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());

    expect(result).toEqual({
      status: "existing",
      projectId: PROJECT.id,
      worktreeId: WORKTREE.id,
      terminalId: "pane-1",
    });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses rather than guess when only a pane's saved record names the session", async () => {
    const { deps, invoke } = resumeDeps({
      terminals: {
        "pane-1": {
          launchAgentId: "claude",
          agentSessionId: "the-launched-run",
          agentIncarnation: 1,
          detectedAgentId: "claude",
          worktreeId: WORKTREE.id,
        },
      },
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: [
          {
            id: "pane-1",
            kind: "terminal",
            location: "grid",
            agentSessionId: SESSION,
          } as PanelSnapshot,
        ],
      },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "terminals-unavailable" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("launches when the only pane naming the session is in the trash", async () => {
    const { deps, invoke } = resumeDeps({
      terminals: {
        "pane-1": { launchAgentId: "claude", agentIncarnation: 1, worktreeId: WORKTREE.id },
      },
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: [
          {
            id: "pane-1",
            kind: "terminal",
            location: "trash",
            agentSessionId: SESSION,
          } as PanelSnapshot,
        ],
      },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "launched" });
    expect(spawns(invoke)).toHaveLength(1);
  });

  it("returns a pane main started that no layout save has placed yet", async () => {
    noteHostStartedTerminal(PROJECT.id, "pane-1", { location: "grid", worktreeId: WORKTREE.id });
    const { deps } = resumeDeps({
      terminals: { "pane-1": { agentSessionId: SESSION, worktreeId: WORKTREE.id } },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "existing", terminalId: "pane-1" });
  });

  it.each([
    ["trashed", { isTrashed: true }],
    ["exited", { isExited: true }],
    ["back at its shell", { agentState: "exited" }],
    ["an assistant", { isAssistantTerminal: true }],
    ["in another worktree", { worktreeId: "/repo" }],
    ["taken over by a later agent", { agentIncarnation: 1 }],
    ["running another agent now", { launchAgentId: "claude", detectedAgentId: "codex" }],
    ["holding another session", { agentSessionId: "another" }],
  ])("launches beside a terminal that is %s", async (_label, overrides) => {
    const { deps, invoke } = resumeDeps({
      terminals: {
        "pane-1": { agentSessionId: SESSION, worktreeId: WORKTREE.id, ...overrides },
      },
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: [{ id: "pane-1", kind: "terminal", location: "grid" } as PanelSnapshot],
      },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "launched" });
    expect(spawns(invoke)).toHaveLength(1);
  });

  it("launches beside a holder the saved layout keeps in the trash", async () => {
    const { deps } = resumeDeps({
      terminals: { "pane-1": { agentSessionId: SESSION, worktreeId: WORKTREE.id } },
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: [{ id: "pane-1", kind: "terminal", location: "trash" } as PanelSnapshot],
      },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "launched" });
  });

  it("launches beside a holder the saved layout shows as a dialog", async () => {
    const { deps } = resumeDeps({
      terminals: { "pane-1": { agentSessionId: SESSION, worktreeId: WORKTREE.id } },
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: [{ id: "pane-1", kind: "terminal", location: "dialog" } as PanelSnapshot],
      },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "launched" });
  });

  it("returns an existing pane even at the panel limit", async () => {
    const { deps, invoke } = resumeDeps({
      terminals: { "pane-1": { agentSessionId: SESSION, worktreeId: WORKTREE.id } },
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: Array.from({ length: 400 }, (_, index) => ({
          id: index === 0 ? "pane-1" : `other-${index}`,
          kind: "terminal",
          location: "grid",
        })) as PanelSnapshot[],
      },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "existing", terminalId: "pane-1" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses a new pane at the panel limit", async () => {
    const { deps, invoke } = resumeDeps({
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: Array.from({ length: 400 }, (_, index) => ({
          id: `other-${index}`,
          kind: "terminal",
          location: "grid",
        })) as PanelSnapshot[],
      },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "panel-limit" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("returns a pane that started holding the session while the launch was being prepared", async () => {
    const terminals: Record<string, ViewlessTerminalRecord> = {};
    const { deps, invoke } = resumeDeps({
      terminals,
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: [{ id: "pane-1", kind: "terminal", location: "grid" } as PanelSnapshot],
      },
    });
    deps.agents.getSettings = async () => {
      terminals["pane-1"] = { agentSessionId: SESSION, worktreeId: WORKTREE.id };
      return null;
    };
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "existing", terminalId: "pane-1" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("returns an existing pane even when the CLI can no longer launch", async () => {
    const { deps } = resumeDeps({
      terminals: { "pane-1": { agentSessionId: SESSION, worktreeId: WORKTREE.id } },
      state: {
        projectId: PROJECT.id,
        sidebarWidth: 350,
        terminals: [{ id: "pane-1", kind: "terminal", location: "grid" } as PanelSnapshot],
      },
    });
    deps.agents.getCliDetail = async () => ({ state: "missing", via: "which" }) as never;
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "existing", terminalId: "pane-1" });
  });

  it("refuses rather than duplicate a holder nothing places", async () => {
    const { deps, invoke } = resumeDeps({
      terminals: { "pane-1": { agentSessionId: SESSION, worktreeId: WORKTREE.id } },
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "terminals-unavailable" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses when the saved layout can't be read", async () => {
    const { deps, invoke, store } = resumeDeps();
    store.getProjectState.mockRejectedValue(new Error("state unreadable"));
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "terminals-unavailable" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses when not every terminal host answered", async () => {
    const { deps, invoke } = resumeDeps({ degraded: true });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "terminals-unavailable" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("refuses a CLI that can't launch", async () => {
    const { deps, invoke } = resumeDeps();
    deps.agents.getCliDetail = async () => ({ state: "missing", via: "which" }) as never;
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "missing-cli" });
    expect(spawns(invoke)).toHaveLength(0);
  });

  it("records nothing when the pty-host reports the spawn failed", async () => {
    const { deps, store } = resumeDeps();
    const runtime = makeRuntime({
      confirmSpawn: vi.fn(async (_id: string, spawn: () => Promise<void>) => {
        await spawn();
        return false;
      }),
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, runtime);
    expect(result).toMatchObject({ status: "refused", reason: "spawn-failed" });
    expect(store.read()?.terminals ?? []).toHaveLength(0);
  });

  it("refuses when the spawn handler rejects", async () => {
    const { deps, invoke, store } = resumeDeps();
    const base = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (projectId, channel, args) => {
      if (channel === CHANNELS.TERMINAL_SPAWN) throw new Error("spawn queue full");
      return base(projectId, channel, args);
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "refused", reason: "spawn-failed" });
    expect(store.read()?.terminals ?? []).toHaveLength(0);
  });

  it("reports a running pane the layout couldn't take", async () => {
    const { deps, store } = resumeDeps();
    store.enqueueProjectStateUpdate.mockRejectedValueOnce(new Error("disk full"));
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "launched", savedInLayout: false });
  });

  it("launches once for two concurrent calls, and both get that pane", async () => {
    const { deps, invoke } = resumeDeps();
    const runtime = makeRuntime();

    const [first, second] = await Promise.all([
      resumeAgentSessionAsPane(REQUEST, deps, runtime),
      resumeAgentSessionAsPane(REQUEST, deps, runtime),
    ]);

    expect(spawns(invoke)).toHaveLength(1);
    expect(first).toMatchObject({ status: "launched" });
    expect(second).toEqual(first);
  });

  it("launches again after an earlier call for the session threw", async () => {
    const { deps, invoke } = resumeDeps();
    const getCliDetail = deps.agents.getCliDetail;
    deps.agents.getCliDetail = () => {
      throw new Error("probe crashed");
    };
    await expect(resumeAgentSessionAsPane(REQUEST, deps, makeRuntime())).rejects.toThrow(
      "probe crashed"
    );
    deps.agents.getCliDetail = getCliDetail;
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "launched" });
    expect(spawns(invoke)).toHaveLength(1);
  });

  it("launches again once an earlier call for the session has settled", async () => {
    const { deps, invoke } = resumeDeps();
    const failing = makeRuntime({ isDirectory: vi.fn(async () => false) });
    await expect(resumeAgentSessionAsPane(REQUEST, deps, failing)).resolves.toMatchObject({
      status: "refused",
      reason: "worktree-gone",
    });
    const result = await resumeAgentSessionAsPane(REQUEST, deps, makeRuntime());
    expect(result).toMatchObject({ status: "launched" });
    expect(spawns(invoke)).toHaveLength(1);
  });
});
