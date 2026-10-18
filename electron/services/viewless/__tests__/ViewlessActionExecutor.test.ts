import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../../ipc/channels.js";
import { MAX_ECHOED_COMMAND_CHARS } from "../../../../shared/utils/terminalSendCommandResult.js";
import {
  executeViewlessAction,
  hasViewlessImplementation,
  type ViewlessDeps,
  type ViewlessPtyReader,
} from "../ViewlessActionExecutor.js";
import { makeDeps, makeHosts, makeStateStore, PROJECT, request } from "./viewlessTestDeps.js";

describe("viewless actions", () => {
  it("covers exactly the agent-facing actions", () => {
    expect(hasViewlessImplementation("terminal.new")).toBe(true);
    expect(hasViewlessImplementation("terminal.sendCommand")).toBe(true);
    expect(hasViewlessImplementation("worktree.create")).toBe(true);
    // Opens a palette: inherently a frontend's job.
    expect(hasViewlessImplementation("terminal.sendToAgent")).toBe(false);
    expect(hasViewlessImplementation("terminal.moveToDock")).toBe(false);
  });

  it("covers the loop an orchestrator drives with no window open", () => {
    for (const id of [
      "agent.launch",
      "agent.listAvailable",
      "terminal.list",
      "terminal.getOutput",
      "terminal.getStatus",
      "terminal.close",
      "terminal.interrupt",
      "terminal.sendKeys",
      "worktree.list",
      "worktree.waitUntilReady",
      "worktree.delete",
      "project.getAll",
      "project.detectRunners",
    ]) {
      expect(hasViewlessImplementation(id)).toBe(true);
    }
    // A composite with recipe terminals and preference reads stays a view's.
    expect(hasViewlessImplementation("worktree.createWithRecipe")).toBe(false);
  });

  it("refuses an argument that raises a safe action to confirmation, unapproved", async () => {
    const { deps, invoke } = makeDeps({ getWorkspaceHosts: () => makeHosts() });

    const result = await executeViewlessAction(
      request("worktree.create", { worktreeId: "/repo", options: {}, recipeId: "r-1" }),
      deps
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED", details: { confirmationChannel: "unavailable" } },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks the caller's write check before a write, and never before a read", async () => {
    const { deps, invoke } = makeDeps();
    const assertCanWrite = vi.fn(async () => ({
      ok: false as const,
      error: { code: "EXECUTION_ERROR" as const, message: "Driven elsewhere" },
    }));

    const write = await executeViewlessAction(
      { ...request("terminal.new", {}), assertCanWrite },
      deps
    );
    const read = await executeViewlessAction(
      { ...request("project.getAll", undefined), assertCanWrite },
      deps
    );

    expect(write).toMatchObject({ ok: false, error: { message: "Driven elsewhere" } });
    expect(assertCanWrite).toHaveBeenCalledTimes(1);
    expect(assertCanWrite).toHaveBeenCalledWith(PROJECT.id, "terminal.new");
    expect(read).toMatchObject({ ok: true });
    expect(invoke).not.toHaveBeenCalledWith(PROJECT.id, CHANNELS.TERMINAL_SPAWN, expect.anything());
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
      // No configured variables: the spawn keeps the process environment.
      expect(invoke.mock.calls[0][2][0]).not.toHaveProperty("env");
      // What an attaching frontend reads back.
      const hydrated = await deps.getProjectState(PROJECT.id);
      expect(hydrated?.terminals).toEqual([
        expect.objectContaining({
          id: terminalId,
          kind: "terminal",
          location: "grid",
          cwd: "/repo",
          spawnedBy: "mcp",
        }),
      ]);
      expect(store.read()?.projectId).toBe(PROJECT.id);
    });

    it("launches with the global and project environment, as a window's launch does", async () => {
      const { deps, invoke } = makeDeps({
        getLaunchEnvLayers: async () => ({
          global: { PATH_EXTRA: "/g", SHARED: "global" },
          project: { SHARED: "project" },
        }),
      });

      await executeViewlessAction(request("terminal.new", {}), deps);

      expect(invoke.mock.calls[0][2][0]).toMatchObject({
        env: { PATH_EXTRA: "/g", SHARED: "project" },
      });
    });

    it("still launches when the environment cannot be read", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { deps, invoke } = makeDeps({
        getLaunchEnvLayers: () => Promise.reject(new Error("settings unreadable")),
      });

      const result = await executeViewlessAction(request("terminal.new", {}), deps);

      expect(result?.ok).toBe(true);
      expect(invoke.mock.calls[0][2][0]).not.toHaveProperty("env");
    });

    it("stamps provenance from the dispatching session, never the caller's claim", async () => {
      const { deps, store } = makeDeps();

      await executeViewlessAction(
        {
          ...request("terminal.new", { spawnedBy: "assistant" }),
          sessionOrigin: "external" as const,
        },
        deps
      );
      await executeViewlessAction(
        { ...request("terminal.new", {}), sessionOrigin: "help" as const },
        deps
      );

      expect(store.read()?.terminals.map((t) => t.spawnedBy)).toEqual(["mcp", "assistant"]);
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
        getTerminalsForProjectAsync: vi.fn(async () => []),
        getSerializedStateAsync: vi.fn(async () => null),
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

    it.each([
      ["notify", "true"],
      ["replyLines", -1],
      ["waitForReply", "yes"],
      ["waitSeconds", 0],
    ])("refuses a malformed %s rather than submitting without it", async (key, value) => {
      const { deps, invoke } = makeDeps({ getPtyReader: () => pty });

      const result = await executeViewlessAction(
        request("terminal.sendCommand", { terminalId: "t-1", command: "ls", [key]: value }),
        deps
      );

      expect(result?.ok).toBe(false);
      expect(result && !result.ok ? result.error.code : null).toBe("VALIDATION_ERROR");
      expect(invoke).not.toHaveBeenCalled();
    });

    it("accepts well-formed completion options", async () => {
      const { deps, invoke } = makeDeps({ getPtyReader: () => pty });

      const result = await executeViewlessAction(
        request("terminal.sendCommand", {
          terminalId: "t-1",
          command: "ls",
          notify: true,
          replyLines: 10,
          waitForReply: true,
          waitSeconds: 60,
        }),
        deps
      );

      expect(result?.ok).toBe(true);
      expect(invoke).toHaveBeenCalled();
    });
  });

  describe("worktree.create", () => {
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
