import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import type { Project, ProjectState } from "../../../../shared/types/project.js";
import { MAX_ECHOED_COMMAND_CHARS } from "../../../../shared/utils/terminalSendCommandResult.js";
import {
  executeViewlessAction,
  hasViewlessImplementation,
  type ViewlessDeps,
  type ViewlessPtyReader,
  type ViewlessWorkspaceHosts,
} from "../ViewlessActionExecutor.js";

const PROJECT: Project = {
  id: "proj-1",
  path: "/repo",
  name: "Repo",
  emoji: "tree",
  lastOpened: 0,
} as Project;

/**
 * An in-memory project state store that queues updates the way the real one
 * does, so "the next hydrate sees it" is a read of what was written.
 */
function makeStateStore(initial: ProjectState | null = null) {
  let state = initial;
  return {
    read: () => state,
    getProjectState: vi.fn(async () => state),
    enqueueProjectStateUpdate: vi.fn(
      async (
        _projectId: string,
        updater: (
          existing: ProjectState | null
        ) => ProjectState | null | Promise<ProjectState | null>
      ) => {
        const next = await updater(state);
        if (next !== null) state = next;
      }
    ),
  };
}

function makeDeps(overrides: Partial<ViewlessDeps> = {}) {
  const store = makeStateStore();
  const invoke = vi.fn(async (_projectId: string, channel: string, args: unknown[]) => {
    if (channel === CHANNELS.TERMINAL_SPAWN) return (args[0] as { id: string }).id;
    if (channel === CHANNELS.WORKTREE_CREATE) {
      return { worktreeId: "/repo-wt/feature", branch: "feature", setupState: "pending" };
    }
    return undefined;
  });
  const deps: ViewlessDeps = {
    getProject: (id) => (id === PROJECT.id ? PROJECT : null),
    getProjectState: store.getProjectState,
    stateWriter: store,
    getPtyReader: () => null,
    getWorkspaceHosts: () => null,
    invoke: invoke as ViewlessDeps["invoke"],
    ...overrides,
  };
  return { deps, store, invoke };
}

function request(actionId: string, args: unknown, extra: { confirmed?: boolean } = {}) {
  return { workspaceId: PROJECT.id, actionId, args, confirmed: extra.confirmed ?? false };
}

describe("viewless actions", () => {
  it("covers exactly the agent-facing actions", () => {
    expect(hasViewlessImplementation("terminal.new")).toBe(true);
    expect(hasViewlessImplementation("terminal.sendCommand")).toBe(true);
    expect(hasViewlessImplementation("worktree.create")).toBe(true);
    // Opens a palette: inherently a frontend's job.
    expect(hasViewlessImplementation("terminal.sendToAgent")).toBe(false);
    expect(hasViewlessImplementation("terminal.moveToDock")).toBe(false);
  });

  it("answers null for a workspace that is not a registered project", async () => {
    const { deps, invoke } = makeDeps();
    const result = await executeViewlessAction(
      { ...request("terminal.new", {}), workspaceId: "scratch-9" },
      deps
    );
    expect(result).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  describe("terminal.new", () => {
    it("spawns a PTY through the host's spawn handler and records it for the next hydrate", async () => {
      const { deps, store, invoke } = makeDeps();

      const result = await executeViewlessAction(request("terminal.new", undefined), deps);

      expect(result?.ok).toBe(true);
      const terminalId = (result as { result: { terminalId: string } }).result.terminalId;
      expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.TERMINAL_SPAWN, [
        expect.objectContaining({
          id: terminalId,
          kind: "terminal",
          projectId: PROJECT.id,
          cwd: "/repo",
          cols: 80,
          rows: 24,
        }),
      ]);
      // What an attaching frontend reads back.
      const hydrated = await deps.getProjectState(PROJECT.id);
      expect(hydrated?.terminals).toEqual([
        expect.objectContaining({
          id: terminalId,
          kind: "terminal",
          location: "grid",
          cwd: "/repo",
        }),
      ]);
      expect(store.read()?.projectId).toBe(PROJECT.id);
    });

    it("opens in the pane's own worktree, then the project's active one", async () => {
      const store = makeStateStore({
        projectId: PROJECT.id,
        sidebarWidth: 300,
        terminals: [],
        activeWorktreeId: "/repo-wt/active",
      });
      const { deps, invoke } = makeDeps({
        getProjectState: store.getProjectState,
        stateWriter: store,
      });

      await executeViewlessAction(request("terminal.new", {}), deps);
      expect(invoke.mock.calls[0][2][0]).toMatchObject({
        cwd: "/repo-wt/active",
        worktreeId: "/repo-wt/active",
      });

      await executeViewlessAction(
        {
          ...request("terminal.new", {}),
          context: {
            projectId: PROJECT.id,
            activeWorktreeId: "/repo-wt/pane",
            activeWorktreePath: "/repo-wt/pane",
          },
        },
        deps
      );
      expect(invoke.mock.calls[1][2][0]).toMatchObject({
        cwd: "/repo-wt/pane",
        worktreeId: "/repo-wt/pane",
      });
      // Both land in the persisted layout, in order, without replacing the
      // sidebar width a renderer saved.
      expect(store.read()?.terminals).toHaveLength(2);
      expect(store.read()?.sidebarWidth).toBe(300);
    });

    it("ignores a context that describes another project", async () => {
      const { deps, invoke } = makeDeps();
      await executeViewlessAction(
        {
          ...request("terminal.new", {}),
          context: { projectId: "other", activeWorktreePath: "/elsewhere" },
        },
        deps
      );
      expect(invoke.mock.calls[0][2][0]).toMatchObject({ cwd: "/repo" });
    });

    it("refuses a command or cwd without an approval, since nobody can be asked", async () => {
      const { deps, invoke } = makeDeps();

      const result = await executeViewlessAction(
        request("terminal.new", { command: "npm test" }),
        deps
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "CONFIRMATION_REQUIRED", details: { confirmationChannel: "unavailable" } },
      });
      expect(invoke).not.toHaveBeenCalled();
    });

    it("runs an approved command, and leaves it off the persisted snapshot", async () => {
      const { deps, store, invoke } = makeDeps();

      const result = await executeViewlessAction(
        request("terminal.new", { command: "npm test", cwd: "/repo/pkg" }, { confirmed: true }),
        deps
      );

      expect(result?.ok).toBe(true);
      expect(invoke.mock.calls[0][2][0]).toMatchObject({ command: "npm test", cwd: "/repo/pkg" });
      expect(store.read()?.terminals[0]).not.toHaveProperty("command");
    });

    it("reports a spawn the host refused, and records nothing", async () => {
      const { deps, store } = makeDeps({
        invoke: vi.fn().mockRejectedValue(new Error("rate limited")) as ViewlessDeps["invoke"],
      });

      const result = await executeViewlessAction(request("terminal.new", {}), deps);

      expect(result).toMatchObject({ ok: false, error: { code: "EXECUTION_ERROR" } });
      expect(store.read()).toBeNull();
    });

    it("still reports the terminal when recording it fails", async () => {
      const { deps } = makeDeps({
        stateWriter: {
          enqueueProjectStateUpdate: vi.fn().mockRejectedValue(new Error("disk full")),
        },
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await executeViewlessAction(request("terminal.new", {}), deps);

      expect(result?.ok).toBe(true);
      warn.mockRestore();
    });
  });

  describe("terminal.sendCommand", () => {
    let pty: ViewlessPtyReader & {
      getTerminalProjectId: ReturnType<typeof vi.fn>;
      getTerminalAsync: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      pty = {
        getTerminalProjectId: vi.fn(() => PROJECT.id),
        getTerminalAsync: vi.fn(async () => ({ kind: "terminal", hasPty: true })),
      };
    });

    it("submits through the host's submit handler with no view", async () => {
      const { deps, invoke } = makeDeps({ getPtyReader: () => pty });

      const result = await executeViewlessAction(
        request("terminal.sendCommand", { terminalId: "t-1", command: "ls" }),
        deps
      );

      expect(result?.ok).toBe(true);
      const receipt = (result as { result: { submissionToken: string; sent: boolean } }).result;
      expect(receipt.sent).toBe(true);
      expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.TERMINAL_SUBMIT, [
        "t-1",
        "ls",
        receipt.submissionToken,
      ]);
    });

    it("bounds the echoed command exactly as the renderer does", async () => {
      const { deps } = makeDeps({ getPtyReader: () => pty });
      const command = "x".repeat(MAX_ECHOED_COMMAND_CHARS + 50);

      const result = await executeViewlessAction(
        request("terminal.sendCommand", { terminalId: "t-1", command }),
        deps
      );

      expect((result as { result: { command: string } }).result.command).toHaveLength(
        MAX_ECHOED_COMMAND_CHARS
      );
    });

    it("treats another project's terminal as one that does not exist", async () => {
      pty.getTerminalProjectId.mockReturnValue("other-project");
      const { deps, invoke } = makeDeps({ getPtyReader: () => pty });

      const result = await executeViewlessAction(
        request("terminal.sendCommand", { terminalId: "t-1", command: "ls" }),
        deps
      );

      expect(result).toMatchObject({ ok: false, error: { message: "Terminal not found" } });
      expect(pty.getTerminalAsync).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a handback to a plain shell", async () => {
      const { deps, invoke } = makeDeps({ getPtyReader: () => pty });

      const result = await executeViewlessAction(
        request("terminal.sendCommand", { terminalId: "t-1", command: "ls", handback: true }),
        deps
      );

      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      expect(invoke).not.toHaveBeenCalled();
    });

    it("asks an agent pane for a handback with a fresh code", async () => {
      pty.getTerminalAsync.mockResolvedValue({
        kind: "terminal",
        hasPty: true,
        detectedAgentId: "claude",
      });
      const { deps, invoke } = makeDeps({ getPtyReader: () => pty });

      const result = await executeViewlessAction(
        request("terminal.sendCommand", { terminalId: "t-1", command: "go", handback: true }),
        deps
      );

      expect(result?.ok).toBe(true);
      const [, , submitArgs] = invoke.mock.calls[0];
      expect(submitArgs[1]).toMatch(/^go\n\n/);
      expect(submitArgs[3]).toMatch(/^[a-z0-9]{6}$/);
    });

    it("refuses an exited or trashed terminal", async () => {
      pty.getTerminalAsync.mockResolvedValueOnce({ kind: "terminal", hasPty: false });
      pty.getTerminalAsync.mockResolvedValueOnce({ kind: "terminal", isTrashed: true });
      const { deps, invoke } = makeDeps({ getPtyReader: () => pty });

      const exited = await executeViewlessAction(
        request("terminal.sendCommand", { terminalId: "t-1", command: "ls" }),
        deps
      );
      const trashed = await executeViewlessAction(
        request("terminal.sendCommand", { terminalId: "t-1", command: "ls" }),
        deps
      );

      expect(exited?.ok).toBe(false);
      expect(trashed?.ok).toBe(false);
      expect(invoke).not.toHaveBeenCalled();
    });
  });

  describe("worktree.create", () => {
    function makeHosts(loaded: boolean) {
      return {
        getHostForProject: vi.fn((_path: string): unknown => (loaded ? {} : undefined)),
        prewarmProject: vi.fn((_path: string) => {}),
        waitForReady: vi.fn(async () => {}),
        isWorktreeOwnedByProject: vi.fn(
          async (_id: string, _path: string, _projectId: string): Promise<boolean | null> => true
        ),
      } satisfies ViewlessWorkspaceHosts;
    }

    const OPTIONS = { baseBranch: "main", newBranch: "feature", path: "/repo-wt/feature" };

    it("loads the project into a workspace host with no window, then creates", async () => {
      const hosts = makeHosts(false);
      const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => hosts });

      const result = await executeViewlessAction(
        request("worktree.create", { worktreePath: "/repo", options: OPTIONS }),
        deps
      );

      expect(hosts.prewarmProject).toHaveBeenCalledWith("/repo");
      expect(hosts.waitForReady).toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledWith(PROJECT.id, CHANNELS.WORKTREE_CREATE, [
        { rootPath: "/repo", options: OPTIONS },
      ]);
      expect(result).toMatchObject({
        ok: true,
        result: { worktreeId: "/repo-wt/feature", branch: "feature" },
      });
    });

    it("reuses a host that is already loaded", async () => {
      const hosts = makeHosts(true);
      const { deps } = makeDeps({ getWorkspaceHosts: () => hosts });

      await executeViewlessAction(
        request("worktree.create", { rootPath: "/repo", options: OPTIONS }),
        deps
      );

      expect(hosts.prewarmProject).not.toHaveBeenCalled();
    });

    it("refuses to create from a worktree another project owns", async () => {
      const hosts = makeHosts(true);
      hosts.isWorktreeOwnedByProject.mockResolvedValue(false);
      const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => hosts });

      const result = await executeViewlessAction(
        request("worktree.create", { worktreeId: "/other/repo", options: OPTIONS }),
        deps
      );

      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      expect(invoke).not.toHaveBeenCalled();
    });

    it("refuses a worktree whose owner cannot be established", async () => {
      const hosts = makeHosts(true);
      hosts.isWorktreeOwnedByProject.mockResolvedValue(null);
      const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => hosts });

      const result = await executeViewlessAction(
        request("worktree.create", { worktreeId: "/unknown/repo", options: OPTIONS }),
        deps
      );

      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      expect(invoke).not.toHaveBeenCalled();
    });

    it("requires a location, as the renderer's schema does", async () => {
      const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => makeHosts(true) });

      const result = await executeViewlessAction(
        request("worktree.create", { options: OPTIONS }),
        deps
      );

      expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } });
      expect(invoke).not.toHaveBeenCalled();
    });
  });
});
