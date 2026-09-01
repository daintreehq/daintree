import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import os from "os";

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProject: vi.fn((): { path: string } | null => null),
  getProjectById: vi.fn((_id: string): { path: string } | null => null),
}));

vi.mock("../../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const { PluginStorageManager } = await import("../PluginStorageManager.js");

const PLUGIN_ID = "acme.storage-target";
const PLUGINS_ROOT = path.join(os.tmpdir(), "daintree-storage-target", "plugins");

let activeWorktreePath: string | undefined;
let getActiveWorktreePath: ReturnType<typeof vi.fn>;

function managerFor(): InstanceType<typeof PluginStorageManager> {
  getActiveWorktreePath = vi.fn(async () => activeWorktreePath);
  return new PluginStorageManager({
    getPluginsRoot: () => PLUGINS_ROOT,
    getActiveWorktreePath: getActiveWorktreePath as () => Promise<string | undefined>,
  });
}

function storageFile(root: string): string {
  return path.join(root, ".daintree", "plugin-storage", `${PLUGIN_ID}.json`);
}

beforeEach(() => {
  activeWorktreePath = undefined;
  projectStoreMock.getCurrentProject.mockReturnValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PluginStorageManager explicit project root", () => {
  it("resolves the supplied root and never consults the active project", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/active" });
    const mgr = managerFor();

    expect(
      await mgr.resolveStorageFilePath(PLUGIN_ID, "project", { projectRoot: "/projects/bound" })
    ).toBe(storageFile("/projects/bound"));
    expect(projectStoreMock.getCurrentProject).not.toHaveBeenCalled();
  });

  it("does not track project switches once a root is supplied", async () => {
    const mgr = managerFor();
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/a" });
    const first = await mgr.resolveStorageFilePath(PLUGIN_ID, "project", {
      projectRoot: "/projects/bound",
    });

    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/b" });
    expect(
      await mgr.resolveStorageFilePath(PLUGIN_ID, "project", { projectRoot: "/projects/bound" })
    ).toBe(first);
  });

  it("still resolves the active project at call time when no root is supplied", async () => {
    const mgr = managerFor();
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/a" });
    expect(await mgr.resolveStorageFilePath(PLUGIN_ID, "project")).toBe(storageFile("/projects/a"));

    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/b" });
    expect(await mgr.resolveStorageFilePath(PLUGIN_ID, "project", {})).toBe(
      storageFile("/projects/b")
    );
    expect(await mgr.resolveStorageFilePath(PLUGIN_ID, "project", { projectRoot: null })).toBe(
      storageFile("/projects/b")
    );
  });

  it("fails closed on a supplied-but-empty root rather than falling back to the active project", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/active" });
    const mgr = managerFor();
    expect(
      await mgr.resolveStorageFilePath(PLUGIN_ID, "project", { projectRoot: "" })
    ).toBeUndefined();
  });
});

describe("PluginStorageManager explicit worktree path", () => {
  it("resolves the supplied worktree and never queries the active one", async () => {
    activeWorktreePath = "/worktrees/active";
    const mgr = managerFor();

    expect(
      await mgr.resolveStorageFilePath(PLUGIN_ID, "worktree", { worktreePath: "/worktrees/bound" })
    ).toBe(storageFile("/worktrees/bound"));
    expect(getActiveWorktreePath).not.toHaveBeenCalled();
  });

  it("still resolves the active worktree at call time when no path is supplied", async () => {
    activeWorktreePath = "/worktrees/a";
    const mgr = managerFor();
    expect(await mgr.resolveStorageFilePath(PLUGIN_ID, "worktree")).toBe(
      storageFile("/worktrees/a")
    );

    activeWorktreePath = "/worktrees/b";
    expect(await mgr.resolveStorageFilePath(PLUGIN_ID, "worktree", { worktreePath: null })).toBe(
      storageFile("/worktrees/b")
    );
  });

  it("fails closed on a supplied-but-empty worktree path", async () => {
    activeWorktreePath = "/worktrees/active";
    const mgr = managerFor();
    expect(
      await mgr.resolveStorageFilePath(PLUGIN_ID, "worktree", { worktreePath: "" })
    ).toBeUndefined();
  });

  it("keeps the two target members independent", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/active" });
    activeWorktreePath = "/worktrees/active";
    const mgr = managerFor();

    // A bound worktree must not become the project-scope target, nor vice versa.
    expect(
      await mgr.resolveStorageFilePath(PLUGIN_ID, "project", { worktreePath: "/worktrees/bound" })
    ).toBe(storageFile("/projects/active"));
    expect(
      await mgr.resolveStorageFilePath(PLUGIN_ID, "worktree", { projectRoot: "/projects/bound" })
    ).toBe(storageFile("/worktrees/active"));
  });

  it("ignores an explicit target for user scope", async () => {
    const mgr = managerFor();
    expect(
      await mgr.resolveStorageFilePath(PLUGIN_ID, "user", {
        projectRoot: "/projects/bound",
        worktreePath: "/worktrees/bound",
      })
    ).toBe(path.join(path.dirname(PLUGINS_ROOT), "plugin-storage", `${PLUGIN_ID}.json`));
  });
});

describe("PluginStorageManager store cache under explicit targets", () => {
  it("gives two bound projects two stores and reuses one per resolved path", async () => {
    const mgr = managerFor();
    const a = (await mgr.resolveStorageFilePath(PLUGIN_ID, "project", {
      projectRoot: "/projects/a",
    }))!;
    const b = (await mgr.resolveStorageFilePath(PLUGIN_ID, "project", {
      projectRoot: "/projects/b",
    }))!;

    const storeA = mgr.getOrCreateStorageStore(PLUGIN_ID, "project", a);
    const storeB = mgr.getOrCreateStorageStore(PLUGIN_ID, "project", b);
    expect(storeB).not.toBe(storeA);
    expect(mgr.getOrCreateStorageStore(PLUGIN_ID, "project", a)).toBe(storeA);
  });

  it("reuses one store when an explicit target resolves to the ambient path", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/same" });
    const mgr = managerFor();
    const ambient = (await mgr.resolveStorageFilePath(PLUGIN_ID, "project"))!;
    const explicit = (await mgr.resolveStorageFilePath(PLUGIN_ID, "project", {
      projectRoot: "/projects/same",
    }))!;

    expect(explicit).toBe(ambient);
    expect(mgr.getOrCreateStorageStore(PLUGIN_ID, "project", explicit)).toBe(
      mgr.getOrCreateStorageStore(PLUGIN_ID, "project", ambient)
    );
  });
});
