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

  // PTY active project
  if (restoreProject) {
    actions.push({
      action: "ptySetActiveProject",
      args: { id: restoreProject.id, path: restoreProject.path },
    });
  }

  // Default terminal spawn
  const skipDefaultSpawn = opts.initialProjectPath || opts.initialProjectId;
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

    it("handles missing project in store gracefully", () => {
      const actions = simulateBootstrap({ initialProjectId: "proj-missing" }, emptyStore);
      expect(actions).toEqual([]);
    });
  });

  describe("unbound new window (no initialProjectId, no initialProjectPath)", () => {
    it("does NOT set PTY active project", () => {
      const actions = simulateBootstrap({}, storeWithProjectA);
      expect(actions.find((a) => a.action === "ptySetActiveProject")).toBeUndefined();
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
      const projectActions = actions.filter((a) => a.action !== "spawnDefaultTerminal");
      expect(projectActions).toEqual([]);
    });
  });

  describe("explicit-path window (initialProjectPath set, no initialProjectId)", () => {
    const opts: Opts = { initialProjectPath: "/cli/project" };

    it("does NOT set PTY active project (no projectId yet)", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions.find((a) => a.action === "ptySetActiveProject")).toBeUndefined();
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
