import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";

const projectStoreMock = vi.hoisted(() => ({
  getCurrentProject: vi.fn((): { path: string } | null => null),
  getProjectById: vi.fn((_id: string): { path: string } | null => null),
}));

vi.mock("../ProjectStore.js", () => ({ projectStore: projectStoreMock }));

const { PluginStorageManager } = await import("../plugin/PluginStorageManager.js");

const PLUGIN_ID = "acme.storage-test";

let tmpDir: string;
let activeWorktreePath: string | undefined;

function managerFor(): InstanceType<typeof PluginStorageManager> {
  return new PluginStorageManager({
    getPluginsRoot: () => path.join(tmpDir, "plugins"),
    getActiveWorktreePath: async () => activeWorktreePath,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-plugin-storage-"));
  activeWorktreePath = undefined;
  projectStoreMock.getCurrentProject.mockReturnValue(null);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("PluginStorageManager path resolution", () => {
  it("resolves user scope to the plugin-storage root (sibling of plugin-settings)", async () => {
    const mgr = managerFor();
    const filePath = await mgr.resolveStorageFilePath(PLUGIN_ID, "user");
    // The storage root is a sibling of the plugins dir, not under plugin-settings.
    expect(filePath).toBe(path.join(tmpDir, "plugin-storage", `${PLUGIN_ID}.json`));
    expect(filePath).not.toContain("plugin-settings");
  });

  it("resolves project scope inside the active project's .daintree dir", async () => {
    projectStoreMock.getCurrentProject.mockReturnValue({ path: "/projects/alpha" });
    const mgr = managerFor();
    const filePath = await mgr.resolveStorageFilePath(PLUGIN_ID, "project");
    expect(filePath).toBe(
      path.join("/projects/alpha", ".daintree", "plugin-storage", `${PLUGIN_ID}.json`)
    );
  });

  it("resolves worktree scope inside the active worktree's .daintree dir", async () => {
    activeWorktreePath = "/worktrees/feature-x";
    const mgr = managerFor();
    const filePath = await mgr.resolveStorageFilePath(PLUGIN_ID, "worktree");
    expect(filePath).toBe(
      path.join("/worktrees/feature-x", ".daintree", "plugin-storage", `${PLUGIN_ID}.json`)
    );
  });

  it("returns undefined when no project is active (project scope)", async () => {
    const mgr = managerFor();
    expect(await mgr.resolveStorageFilePath(PLUGIN_ID, "project")).toBeUndefined();
  });

  it("returns undefined when no worktree is active (worktree scope)", async () => {
    activeWorktreePath = undefined;
    const mgr = managerFor();
    expect(await mgr.resolveStorageFilePath(PLUGIN_ID, "worktree")).toBeUndefined();
  });
});

describe("PluginStorageManager store cache", () => {
  it("returns the same store for a repeated (plugin, scope, path) and a fresh one per path", async () => {
    const mgr = managerFor();
    const a = mgr.getOrCreateStorageStore(PLUGIN_ID, "user", path.join(tmpDir, "a.json"));
    const aAgain = mgr.getOrCreateStorageStore(PLUGIN_ID, "user", path.join(tmpDir, "a.json"));
    const b = mgr.getOrCreateStorageStore(PLUGIN_ID, "user", path.join(tmpDir, "b.json"));
    expect(aAgain).toBe(a);
    expect(b).not.toBe(a);
  });

  it("persists, reads back, and deletes a value through the backing store", async () => {
    const mgr = managerFor();
    const filePath = (await mgr.resolveStorageFilePath(PLUGIN_ID, "user"))!;
    const store = mgr.getOrCreateStorageStore(PLUGIN_ID, "user", filePath);

    expect(await store.set("count", 3)).toBe(true);
    expect(await store.get<number>("count")).toBe(3);

    // The value is written to the plugin-storage path on disk, not plugin-settings.
    const onDisk = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(onDisk).toEqual({ count: 3 });

    expect(await store.delete("count")).toBe(true);
    expect(await store.get("count")).toBeUndefined();
    // Deleting an already-absent key is a no-op (false), not a throw.
    expect(await store.delete("count")).toBe(false);
  });
});

describe("PluginStorageManager serialization guard", () => {
  it("rejects a non-JSON-serializable value", () => {
    const mgr = managerFor();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => mgr.assertStorageSerializable(PLUGIN_ID, "k", circular)).toThrow(
      /not JSON-serializable/
    );
  });

  it("accepts plain JSON values", () => {
    const mgr = managerFor();
    expect(() =>
      mgr.assertStorageSerializable(PLUGIN_ID, "k", { a: 1, b: ["x"], c: null })
    ).not.toThrow();
  });
});

describe("PluginStorageManager subscribers", () => {
  it("fires only the matching (key, scope) subscriber and snapshots the live set", () => {
    const mgr = managerFor();
    const userCb = vi.fn();
    const worktreeCb = vi.fn();
    mgr.addSubscriber(PLUGIN_ID, { key: "k", scope: "user", cb: userCb });
    mgr.addSubscriber(PLUGIN_ID, { key: "k", scope: "worktree", cb: worktreeCb });

    mgr.notifyStorageSubscribers(PLUGIN_ID, "user", "k", "v");
    expect(userCb).toHaveBeenCalledWith("v");
    expect(worktreeCb).not.toHaveBeenCalled();

    mgr.notifyStorageSubscribers(PLUGIN_ID, "worktree", "k", "w");
    expect(worktreeCb).toHaveBeenCalledWith("w");
    // A different key in the same scope does not fire.
    mgr.notifyStorageSubscribers(PLUGIN_ID, "user", "other", "z");
    expect(userCb).toHaveBeenCalledTimes(1);
  });

  it("stops firing after removeSubscriber", () => {
    const mgr = managerFor();
    const cb = vi.fn();
    const sub = { key: "k", scope: "user" as const, cb };
    mgr.addSubscriber(PLUGIN_ID, sub);
    mgr.notifyStorageSubscribers(PLUGIN_ID, "user", "k", "v1");
    mgr.removeSubscriber(PLUGIN_ID, sub);
    mgr.notifyStorageSubscribers(PLUGIN_ID, "user", "k", "v2");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing subscriber so siblings still fire", () => {
    const mgr = managerFor();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    mgr.addSubscriber(PLUGIN_ID, { key: "k", scope: "user", cb: bad });
    mgr.addSubscriber(PLUGIN_ID, { key: "k", scope: "user", cb: good });
    expect(() => mgr.notifyStorageSubscribers(PLUGIN_ID, "user", "k", "v")).not.toThrow();
    expect(good).toHaveBeenCalledWith("v");
    errorSpy.mockRestore();
  });
});

describe("PluginStorageManager clearPluginStorageState", () => {
  it("drops the plugin's subscribers and store caches", async () => {
    const mgr = managerFor();
    const cb = vi.fn();
    mgr.addSubscriber(PLUGIN_ID, { key: "k", scope: "user", cb });
    const filePath = (await mgr.resolveStorageFilePath(PLUGIN_ID, "user"))!;
    mgr.getOrCreateStorageStore(PLUGIN_ID, "user", filePath);

    mgr.clearPluginStorageState(PLUGIN_ID);

    const internals = mgr as unknown as {
      storageSubscribers: Map<string, unknown>;
      storageStores: Map<string, unknown>;
    };
    expect(internals.storageSubscribers.has(PLUGIN_ID)).toBe(false);
    expect(
      [...internals.storageStores.keys()].some((k) => k.startsWith(`${PLUGIN_ID}\u0000`))
    ).toBe(false);

    // A later notify is a no-op once the plugin's state is cleared.
    mgr.notifyStorageSubscribers(PLUGIN_ID, "user", "k", "v");
    expect(cb).not.toHaveBeenCalled();
  });

  it("only clears the target plugin's entries", async () => {
    const mgr = managerFor();
    const other = "acme.other";
    mgr.getOrCreateStorageStore(PLUGIN_ID, "user", path.join(tmpDir, `${PLUGIN_ID}.json`));
    mgr.getOrCreateStorageStore(other, "user", path.join(tmpDir, `${other}.json`));

    mgr.clearPluginStorageState(PLUGIN_ID);

    const stores = (mgr as unknown as { storageStores: Map<string, unknown> }).storageStores;
    expect([...stores.keys()].some((k) => k.startsWith(`${other}\u0000`))).toBe(true);
    expect([...stores.keys()].some((k) => k.startsWith(`${PLUGIN_ID}\u0000`))).toBe(false);
  });
});
