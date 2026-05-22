import { describe, expect, it } from "vitest";

/**
 * Tests the per-window project binding logic from windowServices.ts (#5492).
 *
 * setupWindowServices cannot be imported directly (side effects, Electron deps),
 * so we replicate the decision logic: given initialProjectId and
 * initialProjectPath, what bootstrap actions occur?
 */

type Project = { id: string; name: string; path: string };

type Opts = {
  initialProjectId?: string;
  initialProjectPath?: string;
};

function simulateBootstrap(
  opts: Opts,
  projectStore: { getProjectById: (id: string) => Project | undefined }
) {
  const actions: { action: string; args?: Record<string, unknown> }[] = [];

  // Replicate the binding logic from windowServices.ts
  const restoreProject = opts.initialProjectId
    ? projectStore.getProjectById(opts.initialProjectId)
    : undefined;

  // PTY active project (explicit null for unbound windows)
  if (restoreProject) {
    actions.push({
      action: "ptySetActiveProject",
      args: { id: restoreProject.id, path: restoreProject.path },
    });
  } else {
    actions.push({ action: "ptySetActiveProject", args: { id: null } });
  }

  // Default terminal spawn (skip when restoreProject exists or explicit path)
  const skipDefaultSpawn = opts.initialProjectPath || restoreProject;
  if (!skipDefaultSpawn) {
    actions.push({ action: "spawnDefaultTerminal" });
  }

  // Initial view registration
  if (restoreProject) {
    actions.push({
      action: "registerInitialView",
      args: { id: restoreProject.id, path: restoreProject.path },
    });
  }

  // Worktree loading
  const projectPathForWorktrees = opts.initialProjectPath ?? restoreProject?.path;
  if (projectPathForWorktrees) {
    actions.push({ action: "loadWorktrees", args: { path: projectPathForWorktrees } });
  }

  // Task queue
  if (restoreProject && !opts.initialProjectPath) {
    actions.push({ action: "initializeTaskQueue", args: { id: restoreProject.id } });
  }

  return actions;
}

/**
 * Replicates the workspace-init ordering from windowServices.ts (#8828):
 * the workspace client is constructed and the project host prewarmed BEFORE
 * the PTY-ready await, so the two utility-process forks overlap. The IPC-visible
 * ref must still only be set AFTER PTY-ready.
 */
function simulateWorkspaceInit(
  opts: Opts,
  projectStore: { getProjectById: (id: string) => Project | undefined },
  prewarmThrows = false
) {
  const actions: { action: string; args?: Record<string, unknown> }[] = [];

  actions.push({ action: "getWorkspaceClient" });

  const prewarmPath =
    opts.initialProjectPath ??
    (opts.initialProjectId ? projectStore.getProjectById(opts.initialProjectId)?.path : undefined);
  if (prewarmPath) {
    try {
      if (prewarmThrows) throw new Error("synchronous prewarm failure");
      actions.push({ action: "prewarmProject", args: { path: prewarmPath } });
    } catch {
      actions.push({ action: "prewarmFailedSync" });
    }
  }

  actions.push({ action: "ptyWaitForReady" });
  actions.push({ action: "setWorkspaceClientRef" });

  return actions;
}

const PROJECT_A: Project = { id: "proj-a", name: "Project A", path: "/projects/a" };

const storeWithProjectA = {
  getProjectById: (id: string) => (id === PROJECT_A.id ? PROJECT_A : undefined),
};

const emptyStore = {
  getProjectById: () => undefined,
};

describe("windowServices project binding (#5492)", () => {
  describe("startup restore window (initialProjectId set)", () => {
    it("sets PTY active project, registers view, loads worktrees, inits task queue", () => {
      const actions = simulateBootstrap({ initialProjectId: "proj-a" }, storeWithProjectA);

      expect(actions).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: "proj-a", path: "/projects/a" },
      });
      expect(actions).toContainEqual({
        action: "registerInitialView",
        args: { id: "proj-a", path: "/projects/a" },
      });
      expect(actions).toContainEqual({
        action: "loadWorktrees",
        args: { path: "/projects/a" },
      });
      expect(actions).toContainEqual({
        action: "initializeTaskQueue",
        args: { id: "proj-a" },
      });
    });

    it("skips default terminal spawn", () => {
      const actions = simulateBootstrap({ initialProjectId: "proj-a" }, storeWithProjectA);
      expect(actions.find((a) => a.action === "spawnDefaultTerminal")).toBeUndefined();
    });

    it("handles missing project in store gracefully — clears PTY and spawns default terminal", () => {
      const actions = simulateBootstrap({ initialProjectId: "proj-missing" }, emptyStore);
      expect(actions).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: null },
      });
      expect(actions).toContainEqual({ action: "spawnDefaultTerminal" });
    });
  });

  describe("unbound new window (no initialProjectId, no initialProjectPath)", () => {
    it("sets PTY active project to null (no project binding)", () => {
      const actions = simulateBootstrap({}, storeWithProjectA);
      expect(actions).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: null },
      });
    });

    it("does NOT register initial view", () => {
      const actions = simulateBootstrap({}, storeWithProjectA);
      expect(actions.find((a) => a.action === "registerInitialView")).toBeUndefined();
    });

    it("does NOT load worktrees", () => {
      const actions = simulateBootstrap({}, storeWithProjectA);
      expect(actions.find((a) => a.action === "loadWorktrees")).toBeUndefined();
    });

    it("does NOT initialize task queue", () => {
      const actions = simulateBootstrap({}, storeWithProjectA);
      expect(actions.find((a) => a.action === "initializeTaskQueue")).toBeUndefined();
    });

    it("spawns a default terminal without projectId", () => {
      const actions = simulateBootstrap({}, storeWithProjectA);
      expect(actions).toContainEqual({ action: "spawnDefaultTerminal" });
    });

    it("ignores global current project even when store has one", () => {
      // Even though storeWithProjectA has a project, the unbound window
      // should not use it — it must show the project picker instead.
      const actions = simulateBootstrap({}, storeWithProjectA);
      const projectActions = actions.filter(
        (a) =>
          a.action !== "spawnDefaultTerminal" &&
          !(a.action === "ptySetActiveProject" && a.args?.id === null)
      );
      expect(projectActions).toEqual([]);
    });
  });

  describe("explicit-path window (initialProjectPath set, no initialProjectId)", () => {
    const opts: Opts = { initialProjectPath: "/cli/project" };

    it("sets PTY active project to null (no projectId yet)", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: null },
      });
    });

    it("does NOT register initial view (no projectId yet)", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions.find((a) => a.action === "registerInitialView")).toBeUndefined();
    });

    it("loads worktrees for the explicit path", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions).toContainEqual({
        action: "loadWorktrees",
        args: { path: "/cli/project" },
      });
    });

    it("skips default terminal spawn", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions.find((a) => a.action === "spawnDefaultTerminal")).toBeUndefined();
    });

    it("does NOT initialize task queue (not a restore window)", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions.find((a) => a.action === "initializeTaskQueue")).toBeUndefined();
    });
  });

  describe("both initialProjectId and initialProjectPath set", () => {
    const opts: Opts = { initialProjectId: "proj-a", initialProjectPath: "/override/path" };

    it("sets PTY active project from initialProjectId", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: "proj-a", path: "/projects/a" },
      });
    });

    it("loads worktrees for initialProjectPath (takes priority)", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions).toContainEqual({
        action: "loadWorktrees",
        args: { path: "/override/path" },
      });
    });

    it("does NOT initialize task queue (initialProjectPath present)", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions.find((a) => a.action === "initializeTaskQueue")).toBeUndefined();
    });
  });
});

describe("windowServices workspace prewarm ordering (#8828)", () => {
  const order = (actions: { action: string }[], name: string) =>
    actions.findIndex((a) => a.action === name);

  it("prewarms before awaiting PTY-ready for a restore window (initialProjectId)", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: "proj-a" }, storeWithProjectA);
    expect(actions).toContainEqual({ action: "prewarmProject", args: { path: "/projects/a" } });
    expect(order(actions, "prewarmProject")).toBeLessThan(order(actions, "ptyWaitForReady"));
  });

  it("prewarms before awaiting PTY-ready for an explicit-path window (initialProjectPath)", () => {
    const actions = simulateWorkspaceInit({ initialProjectPath: "/cli/project" }, emptyStore);
    expect(actions).toContainEqual({ action: "prewarmProject", args: { path: "/cli/project" } });
    expect(order(actions, "prewarmProject")).toBeLessThan(order(actions, "ptyWaitForReady"));
  });

  it("prefers initialProjectPath over the store lookup when both are set", () => {
    const actions = simulateWorkspaceInit(
      { initialProjectId: "proj-a", initialProjectPath: "/override/path" },
      storeWithProjectA
    );
    expect(actions).toContainEqual({ action: "prewarmProject", args: { path: "/override/path" } });
  });

  it("does NOT prewarm when no project path can be resolved (unbound window)", () => {
    const actions = simulateWorkspaceInit({}, storeWithProjectA);
    expect(actions.find((a) => a.action === "prewarmProject")).toBeUndefined();
  });

  it("does NOT prewarm when the store has no matching project", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: "proj-missing" }, emptyStore);
    expect(actions.find((a) => a.action === "prewarmProject")).toBeUndefined();
  });

  it("constructs the workspace client before prewarming and PTY-ready", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: "proj-a" }, storeWithProjectA);
    expect(order(actions, "getWorkspaceClient")).toBeLessThan(order(actions, "prewarmProject"));
    expect(order(actions, "getWorkspaceClient")).toBeLessThan(order(actions, "ptyWaitForReady"));
  });

  it("only sets the IPC-visible ref after PTY-ready, never before", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: "proj-a" }, storeWithProjectA);
    expect(order(actions, "setWorkspaceClientRef")).toBeGreaterThan(
      order(actions, "ptyWaitForReady")
    );
  });

  it("continues startup when prewarm throws synchronously (PTY-ready and ref still happen)", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: "proj-a" }, storeWithProjectA, true);
    expect(actions.find((a) => a.action === "prewarmProject")).toBeUndefined();
    expect(actions).toContainEqual({ action: "prewarmFailedSync" });
    expect(actions.find((a) => a.action === "ptyWaitForReady")).toBeDefined();
    expect(actions.find((a) => a.action === "setWorkspaceClientRef")).toBeDefined();
  });
});
