// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn((key: string) => `/mock/electron/${key}`),
    getVersion: vi.fn(() => "0.15.0"),
  },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  // unloadPlugin broadcasts plugin-agent changes to all renderers; without a
  // BrowserWindow stub that path throws asynchronously after the test ends.
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  webContents: { getAllWebContents: vi.fn(() => []) },
}));

vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

const appendSpy = vi.fn();
vi.mock("../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: () => ({ append: appendSpy }),
}));

import { PluginService } from "../PluginService.js";
import type { SimpleGit } from "simple-git";
import type { PluginManifest, PluginHostApi } from "../../../shared/types/plugin.js";

let svc: PluginService;
let baseDir: string;
let allowed: string;
let homeDir: string;
let homedirSpy: MockInstance<() => string>;

/** The implicit per-plugin data dir for the fixture plugin under the faked home. */
function dataDir(): string {
  return join(homeDir, ".daintree", "plugin-data", "acme.fsgit");
}

/** Inject a fake WorkspaceClient that returns the given worktree snapshots. */
function setWorktrees(snapshots: Array<Partial<WorktreeSnapshot> & { path: string }>): void {
  (svc as unknown as { setWorkspaceClient(c: unknown): void }).setWorkspaceClient({
    getAllStatesAsync: async () => snapshots,
  });
}

interface FakeLoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  loadedAt: number;
  isBuiltin: boolean;
}

function makeManifest(capabilities: string[], allowedPaths: string[]): PluginManifest {
  return {
    name: "acme.fsgit",
    version: "1.0.0",
    capabilities,
    scopes: { fs: { allowedPaths } },
    contributes: { fileDecorationProviders: [], forgeProviders: [] },
  } as unknown as PluginManifest;
}

function registerPlugin(capabilities: string[], allowedPaths: string[]): PluginHostApi {
  const seam = svc as unknown as {
    _registerFakePluginForTests(p: FakeLoadedPlugin): void;
    _createHostForTests(id: string): PluginHostApi;
  };
  seam._registerFakePluginForTests({
    manifest: makeManifest(capabilities, allowedPaths),
    dir: baseDir,
    loadedAt: 0,
    isBuiltin: false,
  });
  return seam._createHostForTests("acme.fsgit");
}

beforeEach(async () => {
  appendSpy.mockClear();
  baseDir = mkdtempSync(join(tmpdir(), "plugin-fsgit-"));
  const pluginsRoot = join(baseDir, "plugins");
  mkdirSync(pluginsRoot, { recursive: true });
  allowed = join(baseDir, "allowed");
  await fs.mkdir(allowed, { recursive: true });
  // Redirect the home dir into the fixture so the implicit per-plugin data dir
  // (~/.daintree/plugin-data/{id}/) lands under the temp tree, never the real
  // home. PluginService imports the same `os` singleton, so this spy is shared.
  homeDir = join(baseDir, "home");
  await fs.mkdir(homeDir, { recursive: true });
  homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(homeDir);
  svc = new PluginService(pluginsRoot);
});

afterEach(() => {
  homedirSpy.mockRestore();
  rmSync(baseDir, { recursive: true, force: true });
});

describe("host.fs containment + capability gating", () => {
  it("reads and writes inside allowedPaths with the right capabilities", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "note.txt");

    await host.fs.writeFile(target, "hello");
    expect(await host.fs.readFile(target)).toBe("hello");
    expect(await fs.readFile(target, "utf-8")).toBe("hello");
  });

  it("audits every fs write", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await host.fs.writeFile(join(allowed, "a.txt"), "x");
    const writeAudits = appendSpy.mock.calls.filter(
      (c) => (c[0] as { channel: string }).channel === "plugin:fs-write"
    );
    expect(writeAudits.length).toBe(1);
  });

  it("rejects a traversal that escapes the allowed root", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const escape = join(allowed, "..", "outside.txt");
    await fs.writeFile(join(baseDir, "outside.txt"), "secret");
    await expect(host.fs.readFile(escape)).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("rejects a symlink escape", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const secret = join(baseDir, "secret.txt");
    await fs.writeFile(secret, "TOPSECRET");
    const link = join(allowed, "link.txt");
    await fs.symlink(secret, link);
    await expect(host.fs.readFile(link)).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("denies a read when the plugin lacks any read capability", async () => {
    const host = registerPlugin(["fs:project-write"], [allowed]);
    const target = join(allowed, "x.txt");
    await fs.writeFile(target, "x");
    await expect(host.fs.readFile(target)).rejects.toThrow(/PERMISSION_REQUIRED/);
  });

  it("denies a write when the plugin lacks any write capability", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await expect(host.fs.writeFile(join(allowed, "x.txt"), "x")).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
  });

  it("readFile carries no size cap (reads a file larger than the 500KB files.read limit)", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const big = "a".repeat(600 * 1024);
    const target = join(allowed, "big.txt");
    await fs.writeFile(target, big);
    expect((await host.fs.readFile(target)).length).toBe(big.length);
  });
});

describe("host.fs.watch lifecycle", () => {
  it("invokes the callback on a change and tears down on unload", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const watched = join(allowed, "watched.txt");
    await fs.writeFile(watched, "initial");

    const changes: string[] = [];
    const dispose = await host.fs.watch([watched], (p) => changes.push(p));

    await fs.writeFile(watched, "changed");
    await new Promise((r) => setTimeout(r, 150));
    expect(changes.length).toBeGreaterThan(0);

    // Unload tears down the watcher: the internal watcher set is cleared.
    const watcherMap = (svc as unknown as { pluginFsWatchers: Map<string, Set<unknown>> })
      .pluginFsWatchers;
    expect(watcherMap.get("acme.fsgit")?.size ?? 0).toBe(1);
    svc.unloadPlugin("acme.fsgit");
    expect(watcherMap.has("acme.fsgit")).toBe(false);

    // The disposer is idempotent after unload.
    expect(() => dispose()).not.toThrow();
  });

  it("rejects watch without a read capability", async () => {
    const host = registerPlugin(["fs:project-write"], [allowed]);
    await expect(host.fs.watch([allowed], () => {})).rejects.toThrow(/PERMISSION_REQUIRED/);
  });
});

describe("host.git capability gating + commit safeguard", () => {
  function fakeGitFactory(): SimpleGit {
    return {
      diff: vi.fn().mockResolvedValue("diff --git a/x b/x\n+line"),
      add: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue({ commit: "abc1234" }),
    } as unknown as SimpleGit;
  }

  it("commit refuses without an explicit message (no silent fallback)", async () => {
    const git = fakeGitFactory();
    (
      svc as unknown as { _setHostGitFactoryForTests(f: () => Promise<SimpleGit>): void }
    )._setHostGitFactoryForTests(async () => git);
    const host = registerPlugin(["git:read", "git:write"], [allowed]);

    await expect(host.git.commit(allowed, { message: "" })).rejects.toThrow(
      /COMMIT_MESSAGE_REQUIRED/
    );
    expect(git.commit).not.toHaveBeenCalled();
  });

  it("commit returns the real staged diff as a preview and audits the mutation", async () => {
    const git = fakeGitFactory();
    (
      svc as unknown as { _setHostGitFactoryForTests(f: () => Promise<SimpleGit>): void }
    )._setHostGitFactoryForTests(async () => git);
    const host = registerPlugin(["git:read", "git:write"], [allowed]);

    const result = await host.git.commit(allowed, { message: "feat: x" });
    expect(result.commit).toBe("abc1234");
    expect(result.preview).toContain("+line");

    const commitAudits = appendSpy.mock.calls.filter(
      (c) => (c[0] as { channel: string }).channel === "plugin:git-commit"
    );
    expect(commitAudits.length).toBe(1);
  });

  it("denies git.status without git:read", async () => {
    const host = registerPlugin(["git:write"], [allowed]);
    await expect(host.git.status(allowed)).rejects.toThrow(/PERMISSION_REQUIRED/);
  });

  it("denies git.commit without git:write", async () => {
    const git = fakeGitFactory();
    (
      svc as unknown as { _setHostGitFactoryForTests(f: () => Promise<SimpleGit>): void }
    )._setHostGitFactoryForTests(async () => git);
    const host = registerPlugin(["git:read"], [allowed]);
    await expect(host.git.commit(allowed, { message: "x" })).rejects.toThrow(/PERMISSION_REQUIRED/);
  });

  it("rejects a worktreePath outside the allowed roots", async () => {
    const git = fakeGitFactory();
    (
      svc as unknown as { _setHostGitFactoryForTests(f: () => Promise<SimpleGit>): void }
    )._setHostGitFactoryForTests(async () => git);
    const host = registerPlugin(["git:read"], [allowed]);
    await expect(host.git.status(path.join(baseDir, "other"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });
});

describe("host.fs ${worktree}/${project} token expansion", () => {
  it("expands ${worktree} to the active worktree and contains within it", async () => {
    const worktree = join(baseDir, "wt-feature");
    await fs.mkdir(worktree, { recursive: true });
    setWorktrees([{ path: worktree, isCurrent: true }]);
    const host = registerPlugin(["fs:project-read", "fs:project-write"], ["${worktree}"]);

    const target = join(worktree, "note.txt");
    await host.fs.writeFile(target, "hi");
    expect(await host.fs.readFile(target)).toBe("hi");
    // A sibling outside the active worktree is rejected.
    await expect(host.fs.readFile(join(baseDir, "elsewhere.txt"))).rejects.toThrow(
      /PATH_NOT_ALLOWED/
    );
  });

  it("expands ${project} to the main worktree, distinct from the active one", async () => {
    const project = join(baseDir, "wt-main");
    const feature = join(baseDir, "wt-other");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(feature, { recursive: true });
    setWorktrees([
      { path: project, isMainWorktree: true },
      { path: feature, isCurrent: true },
    ]);
    const host = registerPlugin(["fs:project-read", "fs:project-write"], ["${project}"]);

    const target = join(project, "p.txt");
    await host.fs.writeFile(target, "x");
    expect(await host.fs.readFile(target)).toBe("x");
    // ${project} must NOT reach the active (non-main) worktree.
    await fs.writeFile(join(feature, "f.txt"), "y");
    await expect(host.fs.readFile(join(feature, "f.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("supports a /suffix on a token (scoping to a subdirectory)", async () => {
    const worktree = join(baseDir, "wt");
    const sub = join(worktree, "sub");
    await fs.mkdir(sub, { recursive: true });
    setWorktrees([{ path: worktree, isCurrent: true }]);
    const host = registerPlugin(["fs:project-read", "fs:project-write"], ["${worktree}/sub"]);

    await host.fs.writeFile(join(sub, "ok.txt"), "ok");
    expect(await host.fs.readFile(join(sub, "ok.txt"))).toBe("ok");
    // The worktree root itself is above the scoped subdir → rejected.
    await fs.writeFile(join(worktree, "root.txt"), "z");
    await expect(host.fs.readFile(join(worktree, "root.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("treats coinciding ${project} and ${worktree} (single worktree) as one root", async () => {
    const only = join(baseDir, "only");
    await fs.mkdir(only, { recursive: true });
    setWorktrees([{ path: only, isCurrent: true, isMainWorktree: true }]);
    const host = registerPlugin(
      ["fs:project-read", "fs:project-write"],
      ["${project}", "${worktree}"]
    );
    await host.fs.writeFile(join(only, "a.txt"), "a");
    expect(await host.fs.readFile(join(only, "a.txt"))).toBe("a");
  });

  it("fails closed when ${worktree} has no active worktree (no fallback path)", async () => {
    setWorktrees([{ path: join(baseDir, "main"), isMainWorktree: true }]);
    const host = registerPlugin(["fs:project-read"], ["${worktree}"]);
    await expect(host.fs.readFile(join(baseDir, "main", "x.txt"))).rejects.toThrow(
      /PATH_NOT_ALLOWED/
    );
  });

  it("fails closed when no WorkspaceClient is wired and a token is declared", async () => {
    const host = registerPlugin(["fs:project-read"], ["${worktree}"]);
    await expect(host.fs.readFile(join(baseDir, "x.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("fails closed (no fallback) when getAllStatesAsync rejects", async () => {
    (svc as unknown as { setWorkspaceClient(c: unknown): void }).setWorkspaceClient({
      getAllStatesAsync: async () => {
        throw new Error("client unavailable");
      },
    });
    const host = registerPlugin(["fs:project-read"], ["${worktree}"]);
    await expect(host.fs.readFile(join(baseDir, "x.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("still serves a co-declared literal root when a token can't resolve", async () => {
    // No active worktree → ${worktree} drops out, but the literal stays usable.
    setWorktrees([{ path: join(baseDir, "main"), isMainWorktree: true }]);
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed, "${worktree}"]);
    await host.fs.writeFile(join(allowed, "ok.txt"), "ok");
    expect(await host.fs.readFile(join(allowed, "ok.txt"))).toBe("ok");
  });
});

describe("host.fs implicit per-plugin data dir", () => {
  it("auto-grants the data dir to a user-data plugin and creates it lazily on write", async () => {
    const host = registerPlugin(["fs:user-data-read", "fs:user-data-write"], []);
    expect(existsSync(dataDir())).toBe(false);

    const target = join(dataDir(), "state.json");
    await host.fs.writeFile(target, "{}");
    expect(existsSync(dataDir())).toBe(true);
    expect(await host.fs.readFile(target)).toBe("{}");
  });

  it("creates intermediate dirs for a nested write inside the data dir", async () => {
    const host = registerPlugin(["fs:user-data-read", "fs:user-data-write"], []);
    const nested = join(dataDir(), "cache", "v1", "blob.bin");
    await host.fs.writeFile(nested, "data");
    expect(await host.fs.readFile(nested)).toBe("data");
  });

  it("stays reachable even when a co-declared token can't resolve", async () => {
    // The always-on data dir must survive a failing ${worktree} expansion.
    const host = registerPlugin(["fs:user-data-read", "fs:user-data-write"], ["${worktree}"]);
    const target = join(dataDir(), "state.json");
    await host.fs.writeFile(target, "{}");
    expect(await host.fs.readFile(target)).toBe("{}");
  });

  it("denies the data dir to a plugin holding only project caps", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await expect(host.fs.writeFile(join(dataDir(), "x.txt"), "x")).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    // The deny must not have created the data dir as a side effect.
    expect(existsSync(dataDir())).toBe(false);
  });
});

describe("host.fs per-root-class capability gating", () => {
  it("denies a project path to a plugin holding only user-data caps", async () => {
    const host = registerPlugin(["fs:user-data-read", "fs:user-data-write"], [allowed]);
    const target = join(allowed, "x.txt");
    await fs.writeFile(target, "x");
    await expect(host.fs.readFile(target)).rejects.toThrow(/PERMISSION_REQUIRED/);
    await expect(host.fs.writeFile(target, "y")).rejects.toThrow(/PERMISSION_REQUIRED/);
  });

  it("allows a project path with project caps and the data dir with user-data caps", async () => {
    const host = registerPlugin(
      ["fs:project-read", "fs:project-write", "fs:user-data-read", "fs:user-data-write"],
      [allowed]
    );
    await host.fs.writeFile(join(allowed, "p.txt"), "p");
    expect(await host.fs.readFile(join(allowed, "p.txt"))).toBe("p");
    await host.fs.writeFile(join(dataDir(), "u.txt"), "u");
    expect(await host.fs.readFile(join(dataDir(), "u.txt"))).toBe("u");
  });
});

describe("host.git token expansion", () => {
  function fakeGitFactory(): SimpleGit {
    return {
      status: vi.fn().mockResolvedValue({ files: [] }),
      diff: vi.fn().mockResolvedValue(""),
      add: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue({ commit: "abc1234" }),
    } as unknown as SimpleGit;
  }

  it("expands ${worktree} for git ops but never the implicit data dir", async () => {
    const worktree = join(baseDir, "wt");
    await fs.mkdir(worktree, { recursive: true });
    setWorktrees([{ path: worktree, isCurrent: true }]);
    const git = fakeGitFactory();
    (
      svc as unknown as { _setHostGitFactoryForTests(f: () => Promise<SimpleGit>): void }
    )._setHostGitFactoryForTests(async () => git);
    const host = registerPlugin(["git:read"], ["${worktree}"]);

    // diff uses the mocked SimpleGit factory (status would hit the real
    // changes provider, which needs an actual git repo on disk).
    await expect(host.git.diff(worktree)).resolves.toBeDefined();
    // The per-plugin data dir is an fs root, never a git root — rejected at
    // containment before any git work runs.
    await fs.mkdir(dataDir(), { recursive: true });
    await expect(host.git.diff(dataDir())).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });
});
