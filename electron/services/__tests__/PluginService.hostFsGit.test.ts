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

// `${worktree}` / `${project}` allowlist tokens expand from worktree snapshots,
// which are now fetched scoped to the window the plugin is acting for (#11297).
// With no resolvable window the fetch returns empty and every token-rooted path
// is denied — correct in production (an unresolvable window must not widen the
// allowlist), but these tests need a window to stand in for the visible one.
const windowScopeMock = vi.hoisted(() => ({
  /** Set to false to simulate "no renderer resolves" — see the deny test. */
  hasActiveView: true,
}));
vi.mock("../../window/windowRef.js", () => ({
  getWindowRegistry: vi.fn(() => null),
  getProjectViewManager: vi.fn(() =>
    windowScopeMock.hasActiveView
      ? { getActiveView: () => ({ webContents: { id: 99, isDestroyed: () => false } }) }
      : null
  ),
  setWindowRegistry: vi.fn(),
  setMainWindow: vi.fn(),
  getMainWindow: vi.fn(() => null),
  setProjectViewManager: vi.fn(),
}));
vi.mock("../../window/webContentsRegistry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../window/webContentsRegistry.js")>()),
  getWindowForWebContents: vi.fn(() => ({ id: 1 })),
}));

const appendSpy = vi.fn();
vi.mock("../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: () => ({ append: appendSpy }),
}));

import { PluginService } from "../PluginService.js";
import {
  getPluginCapabilityConsentService,
  _resetPluginCapabilityServicesForTest,
} from "../plugin-capability/instances.js";
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
    // The real WorkspaceClient is an EventEmitter; setWorkspaceClient wires the
    // #10621 worktree-scope cache-eviction listener through on/off.
    on: vi.fn(),
    off: vi.fn(),
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
    // `PluginFsScopeSchema` requires `.min(1)`, so a validated manifest never
    // carries an empty `allowedPaths` — an undeclared scope omits the key.
    ...(allowedPaths.length > 0 ? { scopes: { fs: { allowedPaths } } } : {}),
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
  // JIT capability consent (#10524) gates the first host-mediated write/spawn.
  // Auto-approve without pinning so the happy-path containment assertions run
  // without a renderer; the dedicated consent tests cover the prompt branch.
  getPluginCapabilityConsentService().setConsentBridge(async () => "approved-once");
});

afterEach(() => {
  homedirSpy.mockRestore();
  _resetPluginCapabilityServicesForTest();
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
  afterEach(() => {
    windowScopeMock.hasActiveView = true;
  });

  it("denies a token-rooted path when no window resolves (#11297)", async () => {
    // Window scoping only ever narrows: with no resolvable renderer the
    // snapshot fetch is empty, the token can't expand, and the entry drops so
    // containment denies (#9492). It must never fall back to the cross-project
    // aggregate, which could root the token in a project the user isn't in.
    const worktree = join(baseDir, "wt-unscoped");
    await fs.mkdir(worktree, { recursive: true });
    setWorktrees([{ path: worktree, isCurrent: true }]);
    const host = registerPlugin(["fs:project-read", "fs:project-write"], ["${worktree}"]);

    windowScopeMock.hasActiveView = false;

    await expect(host.fs.readFile(join(worktree, "note.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

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
      on: vi.fn(),
      off: vi.fn(),
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

describe("JIT capability consent gating (#10524)", () => {
  function registerWith(isBuiltin: boolean): PluginHostApi {
    const seam = svc as unknown as {
      _registerFakePluginForTests(p: FakeLoadedPlugin): void;
      _createHostForTests(id: string): PluginHostApi;
    };
    seam._registerFakePluginForTests({
      manifest: makeManifest(["fs:project-read", "fs:project-write"], [allowed]),
      dir: baseDir,
      loadedAt: 0,
      isBuiltin,
    });
    return seam._createHostForTests("acme.fsgit");
  }

  it("blocks a host write when the user denies consent, even with the capability declared", async () => {
    getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");
    const host = registerWith(false);
    await expect(host.fs.writeFile(join(allowed, "denied.txt"), "x")).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    // The write never lands.
    await expect(fs.readFile(join(allowed, "denied.txt"), "utf-8")).rejects.toThrow();
  });

  it("prompts only once, then runs silently after approve-and-pin", async () => {
    const bridge = vi.fn(async () => "approved-and-pin" as const);
    getPluginCapabilityConsentService().setConsentBridge(bridge);
    const host = registerWith(false);
    await host.fs.writeFile(join(allowed, "a.txt"), "1");
    await host.fs.writeFile(join(allowed, "b.txt"), "2");
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("exempts built-in (first-party) plugins from the consent prompt", async () => {
    const bridge = vi.fn(async () => "rejected" as const);
    getPluginCapabilityConsentService().setConsentBridge(bridge);
    const host = registerWith(true);
    await expect(host.fs.writeFile(join(allowed, "builtin.txt"), "x")).resolves.toBeUndefined();
    expect(bridge).not.toHaveBeenCalled();
  });

  it("blocks git.add and git.commit and never reaches simple-git when consent is denied", async () => {
    getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");
    const git = {
      diff: vi.fn().mockResolvedValue("diff --git a/x b/x\n+line"),
      add: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue({ commit: "abc1234" }),
    } as unknown as SimpleGit;
    (
      svc as unknown as { _setHostGitFactoryForTests(f: () => Promise<SimpleGit>): void }
    )._setHostGitFactoryForTests(async () => git);
    const seam = svc as unknown as {
      _registerFakePluginForTests(p: FakeLoadedPlugin): void;
      _createHostForTests(id: string): PluginHostApi;
    };
    seam._registerFakePluginForTests({
      manifest: makeManifest(["git:read", "git:write"], [allowed]),
      dir: baseDir,
      loadedAt: 0,
      isBuiltin: false,
    });
    const host = seam._createHostForTests("acme.fsgit");

    await expect(host.git.add(allowed, ["a.txt"])).rejects.toThrow(/PERMISSION_REQUIRED/);
    await expect(host.git.commit(allowed, { message: "feat: x" })).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    expect(git.add).not.toHaveBeenCalled();
    expect(git.commit).not.toHaveBeenCalled();
  });
});

describe("a bound plugin's ${project}/${worktree} allowlist roots", () => {
  const PROJECT_A = "a".repeat(64);
  const PROJECT_B = "b".repeat(64);

  interface BoundFakePlugin extends FakeLoadedPlugin {
    binding: { projectId: string | null; projectRoot: string | null };
    origin?: "builtin" | "user" | "project";
  }

  /**
   * A workspace client that answers the app-global fetch with B's worktrees and
   * the per-project fetch with the caller's own. A bound plugin that resolves
   * its tokens ambiently would land on B.
   */
  function setSplitWorktrees(perProject: Record<string, string>, ambient: string) {
    const asCurrent = (p: string) => [{ path: p, isCurrent: true, isMainWorktree: true }];
    const forProject = vi.fn(async (_root: string, projectId: string) =>
      perProject[projectId] ? asCurrent(perProject[projectId]!) : []
    );
    (svc as unknown as { setWorkspaceClient(c: unknown): void }).setWorkspaceClient({
      getAllStatesAsync: async () => asCurrent(ambient),
      getAllStatesForProjectAsync: forProject,
      on: vi.fn(),
      off: vi.fn(),
    });
    return forProject;
  }

  function registerBound(binding: {
    projectId: string | null;
    projectRoot: string | null;
  }): PluginHostApi {
    const seam = svc as unknown as {
      _registerFakePluginForTests(p: BoundFakePlugin): void;
      _createHostForTests(id: string, b?: unknown): PluginHostApi;
    };
    seam._registerFakePluginForTests({
      manifest: makeManifest(["fs:project-read"], ["${worktree}"]),
      dir: baseDir,
      loadedAt: 0,
      isBuiltin: false,
      binding,
    });
    return seam._createHostForTests("acme.fsgit", binding);
  }

  it("expands against its own project, not the focused one", async () => {
    const mine = join(baseDir, "mine");
    const theirs = join(baseDir, "theirs");
    await fs.mkdir(mine, { recursive: true });
    await fs.mkdir(theirs, { recursive: true });
    await fs.writeFile(join(mine, "a.txt"), "mine", "utf8");
    await fs.writeFile(join(theirs, "a.txt"), "theirs", "utf8");

    const forProject = setSplitWorktrees({ [PROJECT_A]: mine }, theirs);
    const host = registerBound({ projectId: PROJECT_A, projectRoot: mine });

    expect(await host.fs.readFile(join(mine, "a.txt"))).toBe("mine");
    expect(forProject).toHaveBeenCalledWith(mine, PROJECT_A);
    // The focused project's tree is outside this plugin's declared roots.
    await expect(host.fs.readFile(join(theirs, "a.txt"))).rejects.toThrow();
  });

  it("defaults a project plugin with no declared allowedPaths to its project root", async () => {
    // Spec §7.2: a project plugin lives inside the tree, so the tree is the
    // only sensible default. Without it host.fs and host.git reach nothing but
    // the plugin's own data dir.
    //
    // The root sits UNDER the faked home deliberately. Literal allowlist paths
    // are classified `user-data` when they are under the home dir, and most
    // real projects are — so a default routed through literal classification
    // would deny `fs:project-read` the project root. A root outside the home
    // dir passes either way and proves nothing.
    const mine = join(homeDir, "Projects", "defaulted");
    await fs.mkdir(mine, { recursive: true });
    await fs.writeFile(join(mine, "a.txt"), "mine", "utf8");

    setSplitWorktrees({}, join(baseDir, "elsewhere"));
    const seam = svc as unknown as {
      _registerFakePluginForTests(p: BoundFakePlugin): void;
      _createHostForTests(id: string, b?: unknown): PluginHostApi;
    };
    const binding = { projectId: PROJECT_A, projectRoot: mine };
    const manifest = makeManifest(["fs:project-read"], []);
    seam._registerFakePluginForTests({
      manifest,
      dir: baseDir,
      loadedAt: 0,
      isBuiltin: false,
      origin: "project",
      binding,
    });
    const host = seam._createHostForTests("acme.fsgit", binding);

    expect(await host.fs.readFile(join(mine, "a.txt"))).toBe("mine");
  });

  it("does not widen an unbound plugin with no declared allowedPaths", async () => {
    // An installed plugin has no project of its own; defaulting it to a tree
    // would grant reach nobody asked for.
    const somewhere = join(baseDir, "somewhere");
    await fs.mkdir(somewhere, { recursive: true });
    await fs.writeFile(join(somewhere, "a.txt"), "x", "utf8");

    const seam = svc as unknown as {
      _registerFakePluginForTests(p: BoundFakePlugin): void;
      _createHostForTests(id: string, b?: unknown): PluginHostApi;
    };
    const binding = { projectId: null, projectRoot: null };
    seam._registerFakePluginForTests({
      manifest: makeManifest(["fs:project-read"], []),
      dir: baseDir,
      loadedAt: 0,
      isBuiltin: false,
      origin: "user",
      binding,
    });
    const host = seam._createHostForTests("acme.fsgit", binding);

    await expect(host.fs.readFile(join(somewhere, "a.txt"))).rejects.toThrow();
  });

  it("expands ambiently for an unbound plugin", async () => {
    const ambient = join(baseDir, "ambient");
    await fs.mkdir(ambient, { recursive: true });
    await fs.writeFile(join(ambient, "a.txt"), "ambient", "utf8");

    setSplitWorktrees({ [PROJECT_B]: join(baseDir, "unused") }, ambient);
    const host = registerBound({ projectId: null, projectRoot: null });

    expect(await host.fs.readFile(join(ambient, "a.txt"))).toBe("ambient");
  });

  it("expands to nothing for a malformed bound-but-rootless binding", async () => {
    const ambient = join(baseDir, "ambient2");
    await fs.mkdir(ambient, { recursive: true });
    await fs.writeFile(join(ambient, "a.txt"), "ambient", "utf8");

    setSplitWorktrees({}, ambient);
    const host = registerBound({ projectId: PROJECT_A, projectRoot: null });

    // Fails closed: the token contributes no root rather than falling back.
    await expect(host.fs.readFile(join(ambient, "a.txt"))).rejects.toThrow();
  });
});
