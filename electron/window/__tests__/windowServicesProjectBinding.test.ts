import { describe, expect, it } from "vitest";
import { resolveRestoreWorkspace, resolveWorktreeLoadPath } from "../restoreWorkspaceBinding.js";

/**
 * Tests the per-window workspace binding logic from windowServices.ts (#5492).
 *
 * setupWindowServices cannot be imported directly (side effects, Electron
 * deps), so this file replicates the *actions* that follow the binding — but
 * the binding decision itself is imported from production rather than copied.
 * A copied decision is how this suite came to assert an `initializeTaskQueue`
 * step that windowServices.ts had already dropped: green, and testing nothing.
 */

type Project = { id: string; name: string; path: string };
type Scratch = { id: string; path: string };

type Opts = {
  initialProjectId?: string;
  initialProjectPath?: string;
};

type Stores = {
  getProjectById: (id: string) => Project | undefined;
  getScratchById?: (id: string) => Scratch | undefined;
};

const bind = (opts: Opts, stores: Stores) =>
  resolveRestoreWorkspace(opts.initialProjectId, {
    getProjectById: stores.getProjectById,
    getScratchById: stores.getScratchById ?? (() => undefined),
  });

function simulateBootstrap(opts: Opts, stores: Stores) {
  const actions: { action: string; args?: Record<string, unknown> }[] = [];
  const { workspace: restoreWorkspace } = bind(opts, stores);

  // PTY active project (explicit null for unbound windows)
  if (restoreWorkspace) {
    actions.push({
      action: "ptySetActiveProject",
      args: { id: restoreWorkspace.id, path: restoreWorkspace.path },
    });
  } else {
    actions.push({ action: "ptySetActiveProject", args: { id: null } });
  }

  // Default terminal spawn (skip when a workspace is bound or a path is given)
  const skipDefaultSpawn = opts.initialProjectPath || restoreWorkspace;
  if (!skipDefaultSpawn) {
    actions.push({ action: "spawnDefaultTerminal" });
  }

  // Initial view registration — the only caller of registerProjectView for the
  // startup view, so a workspace that misses it stays unbound for its lifetime.
  if (restoreWorkspace) {
    actions.push({
      action: "registerInitialView",
      args: { id: restoreWorkspace.id, path: restoreWorkspace.path },
    });
  }

  // Worktree loading — the production resolver, so "a scratch loads no
  // worktrees" is asserted against the expression the app actually evaluates.
  const projectPathForWorktrees = resolveWorktreeLoadPath(
    opts.initialProjectPath,
    bind(opts, stores)
  );
  if (projectPathForWorktrees) {
    actions.push({ action: "loadWorktrees", args: { path: projectPathForWorktrees } });
  }

  return actions;
}

/**
 * Replicates the workspace-init ordering from windowServices.ts (#8828):
 * the workspace client is constructed and the project host prewarmed BEFORE
 * the PTY-ready await, so the two utility-process forks overlap. The IPC-visible
 * ref must still only be set AFTER PTY-ready.
 */
function simulateWorkspaceInit(opts: Opts, stores: Stores, prewarmThrows = false) {
  const actions: { action: string; args?: Record<string, unknown> }[] = [];

  actions.push({ action: "getWorkspaceClient" });

  // Mirrors windowServices.ts exactly: the prewarm runs long before the binding
  // resolver is in scope and reads projectStore directly, so a scratch id finds
  // no row and no host is prewarmed for it.
  const prewarmPath =
    opts.initialProjectPath ??
    (opts.initialProjectId ? stores.getProjectById(opts.initialProjectId)?.path : undefined);
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

// Real shapes: production routes a scratch id to the scratch store by its
// UUID form, and a project id is 64 hex characters.
const PROJECT_A: Project = { id: "a".repeat(64), name: "Project A", path: "/projects/a" };

const SCRATCH: Scratch = { id: "11111111-1111-4111-8111-111111111111", path: "/scratches/one" };

const storeWithProjectA: Stores = {
  getProjectById: (id: string) => (id === PROJECT_A.id ? PROJECT_A : undefined),
};

const emptyStore: Stores = {
  getProjectById: () => undefined,
};

/**
 * Mirrors ScratchStore.getScratchById: only a live scratch resolves, and a
 * project id resolves to nothing even when a scratch is present.
 */
const storeWithScratch: Stores = {
  getProjectById: () => undefined,
  getScratchById: (id: string) => (id === SCRATCH.id ? SCRATCH : undefined),
};

describe("windowServices project binding (#5492)", () => {
  describe("startup restore window (initialProjectId set)", () => {
    it("sets PTY active project, registers view, loads worktrees", () => {
      const actions = simulateBootstrap({ initialProjectId: PROJECT_A.id }, storeWithProjectA);

      expect(actions).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: PROJECT_A.id, path: PROJECT_A.path },
      });
      expect(actions).toContainEqual({
        action: "registerInitialView",
        args: { id: PROJECT_A.id, path: PROJECT_A.path },
      });
      expect(actions).toContainEqual({
        action: "loadWorktrees",
        args: { path: "/projects/a" },
      });
    });

    it("skips default terminal spawn", () => {
      const actions = simulateBootstrap({ initialProjectId: PROJECT_A.id }, storeWithProjectA);
      expect(actions.find((a) => a.action === "spawnDefaultTerminal")).toBeUndefined();
    });

    it("handles missing project in store gracefully — clears PTY and spawns default terminal", () => {
      const actions = simulateBootstrap({ initialProjectId: "f".repeat(64) }, emptyStore);
      expect(actions).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: null },
      });
      expect(actions).toContainEqual({ action: "spawnDefaultTerminal" });
    });
  });

  // A scratch is a workspace with no `projects` row (#11484). Restoring one
  // has to bind the view exactly as a project does, while staying clear of
  // every git-backed path (#11958).
  describe("startup restore into a scratch (initialProjectId names a scratch)", () => {
    const opts: Opts = { initialProjectId: SCRATCH.id };

    it("binds the PTY to the scratch id and its directory", () => {
      expect(simulateBootstrap(opts, storeWithScratch)).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: SCRATCH.id, path: SCRATCH.path },
      });
    });

    it("registers the initial view, so the sender resolves for the rest of its life", () => {
      expect(simulateBootstrap(opts, storeWithScratch)).toContainEqual({
        action: "registerInitialView",
        args: { id: SCRATCH.id, path: SCRATCH.path },
      });
    });

    it("skips the stray home-directory terminal", () => {
      const actions = simulateBootstrap(opts, storeWithScratch);
      expect(actions.find((a) => a.action === "spawnDefaultTerminal")).toBeUndefined();
    });

    it("does NOT load worktrees — a scratch never reaches WorktreeService", () => {
      const actions = simulateBootstrap(opts, storeWithScratch);
      expect(actions.find((a) => a.action === "loadWorktrees")).toBeUndefined();
    });

    it("does NOT prewarm the workspace host", () => {
      const actions = simulateWorkspaceInit(opts, storeWithScratch);
      expect(actions.find((a) => a.action === "prewarmProject")).toBeUndefined();
    });

    it("reports the scratch as the bound workspace but not as a project", () => {
      const { project, workspace } = bind(opts, storeWithScratch);
      expect(workspace).toEqual({ id: SCRATCH.id, path: SCRATCH.path, kind: "scratch" });
      expect(project).toBeUndefined();
    });

    it("leaves a scratch that no longer exists unbound, like a deleted project", () => {
      const actions = simulateBootstrap({ initialProjectId: SCRATCH.id }, emptyStore);
      expect(actions).toContainEqual({ action: "ptySetActiveProject", args: { id: null } });
      expect(actions.find((a) => a.action === "registerInitialView")).toBeUndefined();
    });

    it("prefers the project row when an id somehow resolves in both stores", () => {
      const both: Stores = {
        getProjectById: () => PROJECT_A,
        getScratchById: () => SCRATCH,
      };
      const { project, workspace } = bind({ initialProjectId: PROJECT_A.id }, both);
      expect(workspace?.kind).toBe("project");
      expect(project?.path).toBe(PROJECT_A.path);
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
  });

  describe("both initialProjectId and initialProjectPath set", () => {
    const opts: Opts = { initialProjectId: PROJECT_A.id, initialProjectPath: "/override/path" };

    it("sets PTY active project from initialProjectId", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions).toContainEqual({
        action: "ptySetActiveProject",
        args: { id: PROJECT_A.id, path: PROJECT_A.path },
      });
    });

    it("loads worktrees for initialProjectPath (takes priority)", () => {
      const actions = simulateBootstrap(opts, storeWithProjectA);
      expect(actions).toContainEqual({
        action: "loadWorktrees",
        args: { path: "/override/path" },
      });
    });
  });
});

describe("windowServices workspace prewarm ordering (#8828)", () => {
  const order = (actions: { action: string }[], name: string) =>
    actions.findIndex((a) => a.action === name);

  it("prewarms before awaiting PTY-ready for a restore window (initialProjectId)", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: PROJECT_A.id }, storeWithProjectA);
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
      { initialProjectId: PROJECT_A.id, initialProjectPath: "/override/path" },
      storeWithProjectA
    );
    expect(actions).toContainEqual({ action: "prewarmProject", args: { path: "/override/path" } });
  });

  it("does NOT prewarm when no project path can be resolved (unbound window)", () => {
    const actions = simulateWorkspaceInit({}, storeWithProjectA);
    expect(actions.find((a) => a.action === "prewarmProject")).toBeUndefined();
  });

  it("does NOT prewarm when the store has no matching project", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: "f".repeat(64) }, emptyStore);
    expect(actions.find((a) => a.action === "prewarmProject")).toBeUndefined();
  });

  it("constructs the workspace client before prewarming and PTY-ready", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: PROJECT_A.id }, storeWithProjectA);
    expect(order(actions, "getWorkspaceClient")).toBeLessThan(order(actions, "prewarmProject"));
    expect(order(actions, "getWorkspaceClient")).toBeLessThan(order(actions, "ptyWaitForReady"));
  });

  it("only sets the IPC-visible ref after PTY-ready, never before", () => {
    const actions = simulateWorkspaceInit({ initialProjectId: PROJECT_A.id }, storeWithProjectA);
    expect(order(actions, "setWorkspaceClientRef")).toBeGreaterThan(
      order(actions, "ptyWaitForReady")
    );
  });

  it("continues startup when prewarm throws synchronously (PTY-ready and ref still happen)", () => {
    const actions = simulateWorkspaceInit(
      { initialProjectId: PROJECT_A.id },
      storeWithProjectA,
      true
    );
    expect(actions.find((a) => a.action === "prewarmProject")).toBeUndefined();
    expect(actions).toContainEqual({ action: "prewarmFailedSync" });
    expect(actions.find((a) => a.action === "ptyWaitForReady")).toBeDefined();
    expect(actions.find((a) => a.action === "setWorkspaceClientRef")).toBeDefined();
  });
});
