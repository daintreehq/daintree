// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
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

// A workspace-scoped fs resolves its project's root through the project store,
// never through a window, so the scoped tests register their projects here.
const projectStoreMock = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  closed: new Set<string>(),
}));
vi.mock("../ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
    getProjectById: vi.fn((id: string) =>
      projectStoreMock.paths[id]
        ? {
            id,
            path: projectStoreMock.paths[id],
            // A closed project keeps its row, so the row carries the status.
            status: projectStoreMock.closed.has(id) ? "closed" : "open",
          }
        : undefined
    ),
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
import type {
  PluginManifest,
  PluginHostApi,
  BuiltinPluginHostApi,
} from "../../../shared/types/plugin.js";

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
    // The result-shaped read the plugin host's worktree surfaces go through
    // (#12174) — same states, plus the project they belong to.
    getAllStatesResultAsync: async () => ({
      status: "ok",
      projectId: "project-1",
      states: snapshots,
    }),
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

  describe("readFileBytes (#12216)", () => {
    it("returns bytes UTF-8 decoding would have corrupted", async () => {
      const host = registerPlugin(["fs:project-read"], [allowed]);
      // A PNG header: byte 0x89 is not valid UTF-8 on its own, so `readFile`
      // hands back a replacement character and the bytes are unrecoverable.
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const target = join(allowed, "icon.png");
      await fs.writeFile(target, bytes);

      const read = await host.fs.readFileBytes(target);

      expect(read).toBeInstanceOf(Uint8Array);
      expect([...read]).toEqual([...bytes]);
    });

    it("does not share Node's pooled buffer with the caller", async () => {
      const host = registerPlugin(["fs:project-read"], [allowed]);
      const target = join(allowed, "small.bin");
      await fs.writeFile(target, Buffer.from([1, 2, 3]));

      const read = await host.fs.readFileBytes(target);

      // A pooled Buffer's ArrayBuffer is shared with unrelated reads, so a view
      // handed straight through would expose whatever else the pool holds.
      expect(read.byteOffset).toBe(0);
      expect(read.buffer.byteLength).toBe(3);
    });

    it("enforces the same containment as readFile", async () => {
      const host = registerPlugin(["fs:project-read"], [allowed]);
      await fs.writeFile(join(baseDir, "outside.bin"), "secret");
      await expect(host.fs.readFileBytes(join(allowed, "..", "outside.bin"))).rejects.toThrow(
        /PATH_NOT_ALLOWED/
      );
    });

    it("denies a read when the plugin lacks any read capability", async () => {
      const host = registerPlugin(["fs:project-write"], [allowed]);
      const target = join(allowed, "x.bin");
      await fs.writeFile(target, "x");
      await expect(host.fs.readFileBytes(target)).rejects.toThrow(/PERMISSION_REQUIRED/);
    });

    it("honors an already-aborted signal without touching the disk", async () => {
      const host = registerPlugin(["fs:project-read"], [allowed]);
      const target = join(allowed, "y.bin");
      await fs.writeFile(target, "y");
      await expect(
        host.fs.readFileBytes(target, { signal: AbortSignal.abort() })
      ).rejects.toThrow();
    });
  });
});

describe("host.fs.readdir detailed listing", () => {
  it("returns only name and kind flags by default", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.writeFile(join(allowed, "a.txt"), "hello");

    const [entry] = await host.fs.readdir(allowed);

    expect(entry).toEqual({
      name: "a.txt",
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    });
    // The cheap read must stay cheap — no per-entry lstat is implied.
    expect(entry?.size).toBeUndefined();
    expect(entry?.mtimeMs).toBeUndefined();
  });

  it("supplies size and mtime for a detailed read", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.writeFile(join(allowed, "a.txt"), "hello");

    const [entry] = await host.fs.readdir(allowed, { detail: true });

    expect(entry?.name).toBe("a.txt");
    expect(entry?.size).toBe(5);
    expect(entry?.mtimeMs).toBeGreaterThan(0);
  });

  it("orders directories first, then by a numeric-aware name collation", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.writeFile(join(allowed, "file10.txt"), "x");
    await fs.writeFile(join(allowed, "file2.txt"), "x");
    await fs.writeFile(join(allowed, "alpha.txt"), "x");
    await fs.mkdir(join(allowed, "zeta"));

    const names = (await host.fs.readdir(allowed, { detail: true })).map((e) => e.name);

    // `file2` before `file10` is the numeric collation; a plain sort would
    // invert them, which is exactly what a plugin would get rolling its own.
    expect(names).toEqual(["zeta", "alpha.txt", "file2.txt", "file10.txt"]);
  });

  it("reports a directory with no size", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.mkdir(join(allowed, "sub"));

    const [entry] = await host.fs.readdir(allowed, { detail: true });

    expect(entry?.isDirectory).toBe(true);
    expect(entry?.size).toBeUndefined();
  });

  it("classifies a link to an in-scope file by its target", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.writeFile(join(allowed, "real.txt"), "hello");
    await fs.symlink(join(allowed, "real.txt"), join(allowed, "link.txt"));

    const entries = await host.fs.readdir(allowed, { detail: true });
    const link = entries.find((e) => e.name === "link.txt");

    expect(link?.isSymbolicLink).toBe(true);
    expect(link?.symlink?.targetKind).toBe("file");
    // A resolved link reports the target's size, because that is what opening
    // the row would give you — not the byte length of the stored link string.
    expect(link?.size).toBe(5);
  });

  it("classifies a link to an in-scope directory as descendable", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.mkdir(join(allowed, "realdir"));
    await fs.symlink(join(allowed, "realdir"), join(allowed, "linkdir"));

    const entries = await host.fs.readdir(allowed, { detail: true });
    const link = entries.find((e) => e.name === "linkdir");

    expect(link?.symlink?.targetKind).toBe("directory");
    // `isDirectory` and `targetKind` must agree, or a consumer routing on one
    // contradicts the other.
    expect(link?.isDirectory).toBe(true);
  });

  it("marks a link leaving the plugin's scope as external and non-descendable", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const outside = join(baseDir, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, join(allowed, "escape"));

    const entries = await host.fs.readdir(allowed, { detail: true });
    const link = entries.find((e) => e.name === "escape");

    // "external" is scoped to what THIS plugin may read, which is the only
    // classification a plugin can act on.
    expect(link?.symlink?.targetKind).toBe("external");
    expect(link?.isDirectory).toBe(false);
  });

  it("marks a dangling link broken rather than external", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.symlink(join(allowed, "nothing-here"), join(allowed, "dangling"));

    const entries = await host.fs.readdir(allowed, { detail: true });
    const link = entries.find((e) => e.name === "dangling");

    expect(link?.symlink?.targetKind).toBe("broken");
  });

  it("reports a link that resolves to nothing as neither file nor directory", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const outside = join(baseDir, "outside-dir");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(join(allowed, "nothing-here"), join(allowed, "dangling"));
    await fs.symlink(outside, join(allowed, "escape"));

    const entries = await host.fs.readdir(allowed, { detail: true });
    const dangling = entries.find((e) => e.name === "dangling");
    const escape = entries.find((e) => e.name === "escape");

    // Deriving isFile as `!isDirectory` would call both of these regular files
    // and invite a plugin to read something that isn't there.
    for (const entry of [dangling, escape]) {
      expect(entry?.isFile).toBe(false);
      expect(entry?.isDirectory).toBe(false);
    }
  });

  it("describes a link by its target for both kind flags", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.writeFile(join(allowed, "real.txt"), "hello");
    await fs.mkdir(join(allowed, "realdir"));
    await fs.symlink(join(allowed, "real.txt"), join(allowed, "tofile"));
    await fs.symlink(join(allowed, "realdir"), join(allowed, "todir"));

    const entries = await host.fs.readdir(allowed, { detail: true });
    const toFile = entries.find((e) => e.name === "tofile");
    const toDir = entries.find((e) => e.name === "todir");

    expect(toFile?.isFile).toBe(true);
    expect(toFile?.isDirectory).toBe(false);
    expect(toDir?.isDirectory).toBe(true);
    expect(toDir?.isFile).toBe(false);
  });

  it("never returns content or metadata for a target reached outside scope", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const outside = join(baseDir, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, "exists"), "secret");

    // Both probes are lexically inside the allowed root, so the cheap
    // out-of-scope rejection does not fire — they only leave scope once the
    // intermediate link is resolved.
    await fs.symlink(outside, join(allowed, "hop"));
    await fs.symlink(join(allowed, "hop", "exists"), join(allowed, "probe-real"));
    await fs.symlink(join(allowed, "hop", "absent"), join(allowed, "probe-absent"));

    const entries = await host.fs.readdir(allowed, { detail: true });
    const real = entries.find((e) => e.name === "probe-real");
    const absent = entries.find((e) => e.name === "probe-absent");

    // Neither is readable, and neither carries the target's size — an
    // unresolved link reports no size at all, precisely so a link's own
    // `lstat.size` (the byte length of the stored target string) is never
    // mistaken for the target's. `mtimeMs` IS present, but it is the link
    // entry's own, and that entry lives inside the allowed scope.
    for (const entry of [real, absent]) {
      expect(entry?.isFile).toBe(false);
      expect(entry?.isDirectory).toBe(false);
      expect(entry?.size).toBeUndefined();
    }
    const linkStat = await fs.lstat(join(allowed, "probe-real"));
    expect(real?.mtimeMs).toBe(linkStat.mtimeMs);

    // The two DO classify differently — an existing out-of-scope target reads
    // "external", a missing one "broken" — so the pair is a one-bit existence
    // probe for a path outside the declared scope. Pinned rather than removed
    // because it is deliberate: the distinction is what lets the file browser
    // tell a user "this link points outside your workspace" apart from "this
    // link is dangling", and it hands a plugin nothing, since its `main` runs
    // un-sandboxed and can stat that path through raw `node:fs` anyway. If
    // host.fs ever becomes a real seal (D3), this is one of the seams to close.
    expect(real?.symlink?.targetKind).toBe("external");
    expect(absent?.symlink?.targetKind).toBe("broken");
  });

  it("still enforces containment and capability on a detailed read", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await expect(host.fs.readdir(join(baseDir, "outside"), { detail: true })).rejects.toThrow(
      /PATH_NOT_ALLOWED/
    );

    const uncapable = registerPlugin([], [allowed]);
    await expect(uncapable.fs.readdir(allowed, { detail: true })).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
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

  it("fails closed (no fallback) when the states read rejects", async () => {
    (svc as unknown as { setWorkspaceClient(c: unknown): void }).setWorkspaceClient({
      getAllStatesAsync: async () => {
        throw new Error("client unavailable");
      },
      getAllStatesResultAsync: async () => {
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
    // Resolves the written revision (#12323) rather than void, for every caller.
    await expect(host.fs.writeFile(join(allowed, "builtin.txt"), "x")).resolves.toEqual({
      revision: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
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
      getAllStatesResultAsync: async () => ({
        status: "ok",
        projectId: "project-ambient",
        states: asCurrent(ambient),
      }),
      getAllStatesForProjectAsync: forProject,
      getAllStatesForProjectResultAsync: async (root: string, projectId: string) => {
        // Availability is entry existence, NOT list length — the real client
        // answers `ok` with `states: []` for a live project that has no
        // worktrees, and only reports unavailable when the pool entry is
        // missing or its immutable id mismatches.
        if (!(projectId in perProject)) {
          return { status: "unavailable", reason: "project-unavailable" };
        }
        return { status: "ok", projectId, states: await forProject(root, projectId) };
      },
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

// #12174 follow-up: a built-in has no project binding, so its `${worktree}` /
// `${project}` roots otherwise track the focused window. `fsForWorkspace` pins
// them to one named project + worktree for the life of the handle.
describe("a built-in's workspace-scoped host.fs (fsForWorkspace)", () => {
  const PROJECT_A = "a".repeat(64);
  const PROJECT_B = "b".repeat(64);

  interface Tree {
    id: string;
    path: string;
    isCurrent?: boolean;
    isMainWorktree?: boolean;
  }

  /**
   * A workspace client whose per-project read answers each project's own trees
   * and whose ambient (focused-window) read answers `focused`. A scoped handle
   * that consulted focus would land on `focused`.
   */
  function setProjects(perProject: Record<string, Tree[]>, focused: Tree[]) {
    projectStoreMock.paths = Object.fromEntries(
      Object.keys(perProject).map((id) => [id, join(baseDir, id.slice(0, 6))])
    );
    (svc as unknown as { setWorkspaceClient(c: unknown): void }).setWorkspaceClient({
      getAllStatesAsync: async () => focused,
      getAllStatesResultAsync: async () => ({
        status: "ok",
        projectId: "project-focused",
        states: focused,
      }),
      getAllStatesForProjectAsync: async (_root: string, projectId: string) =>
        perProject[projectId] ?? [],
      getAllStatesForProjectResultAsync: async (_root: string, projectId: string) =>
        projectId in perProject
          ? { status: "ok", projectId, states: perProject[projectId] }
          : { status: "unavailable", reason: "project-unavailable" },
      on: vi.fn(),
      off: vi.fn(),
    });
  }

  function registerBuiltin(capabilities: string[], allowedPaths: string[]): BuiltinPluginHostApi {
    const seam = svc as unknown as {
      _registerFakePluginForTests(p: FakeLoadedPlugin): void;
      _createBuiltinHostForTests(id: string): BuiltinPluginHostApi;
    };
    seam._registerFakePluginForTests({
      manifest: makeManifest(capabilities, allowedPaths),
      dir: baseDir,
      loadedAt: 0,
      isBuiltin: true,
    });
    return seam._createBuiltinHostForTests("acme.fsgit");
  }

  /** `${dir}/a.txt` holding `dir`'s basename, so a read says which tree it came from. */
  async function tree(name: string): Promise<Tree> {
    const dir = join(baseDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "a.txt"), name, "utf8");
    return { id: `wt-${name}`, path: dir };
  }

  afterEach(() => {
    projectStoreMock.paths = {};
    projectStoreMock.closed.clear();
    windowScopeMock.hasActiveView = true;
  });

  it("resolves ${worktree} to the named worktree, not the current one", async () => {
    const mine = await tree("mine");
    const current = await tree("current");
    setProjects({ [PROJECT_A]: [mine, { ...current, isCurrent: true }] }, [
      { ...current, isCurrent: true },
    ]);
    const host = registerBuiltin(["fs:project-read"], ["${worktree}"]);

    const scoped = host.fsForWorkspace({ projectId: PROJECT_A, worktreeId: mine.id });
    expect(await scoped.readFile(join(mine.path, "a.txt"))).toBe("mine");
    // The project's OWN current worktree is outside this handle's root, which
    // is the whole point: the handle is about one worktree.
    await expect(scoped.readFile(join(current.path, "a.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
    // Ambient `host.fs` still follows the current worktree — the scoped handle
    // narrows one handle, it does not change the plugin's other roots.
    expect(await host.fs.readFile(join(current.path, "a.txt"))).toBe("current");
  });

  it("does not move when another project is focused, or when no window resolves", async () => {
    const mine = await tree("scoped-mine");
    const theirs = await tree("scoped-theirs");
    setProjects({ [PROJECT_A]: [mine], [PROJECT_B]: [{ ...theirs, isCurrent: true }] }, [
      { ...theirs, isCurrent: true },
    ]);
    const host = registerBuiltin(["fs:project-read"], ["${worktree}"]);
    const scoped = host.fsForWorkspace({ projectId: PROJECT_A, worktreeId: mine.id });

    expect(await scoped.readFile(join(mine.path, "a.txt"))).toBe("scoped-mine");
    await expect(scoped.readFile(join(theirs.path, "a.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);

    // No resolvable window at all — which denies every ambient token root —
    // leaves the scoped handle untouched, because it never asked a window.
    windowScopeMock.hasActiveView = false;
    expect(await scoped.readFile(join(mine.path, "a.txt"))).toBe("scoped-mine");
    await expect(host.fs.readFile(join(theirs.path, "a.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("resolves ${project} to the named project's main worktree", async () => {
    const main = await tree("scoped-main");
    const feature = await tree("scoped-feature");
    setProjects(
      {
        [PROJECT_A]: [
          { ...main, isMainWorktree: true },
          { ...feature, isCurrent: true },
        ],
      },
      []
    );
    const host = registerBuiltin(["fs:project-read"], ["${project}"]);

    const scoped = host.fsForWorkspace({ projectId: PROJECT_A, worktreeId: feature.id });
    expect(await scoped.readFile(join(main.path, "a.txt"))).toBe("scoped-main");
    await expect(scoped.readFile(join(feature.path, "a.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("fails closed for an unknown project and for an unknown worktree", async () => {
    const mine = await tree("closed-mine");
    setProjects({ [PROJECT_A]: [mine] }, [{ ...mine, isCurrent: true }]);
    const host = registerBuiltin(["fs:project-read"], ["${worktree}"]);

    // A project the store does not know: no root, so containment denies rather
    // than falling back to the focused project (which would read here).
    await expect(
      host
        .fsForWorkspace({ projectId: PROJECT_B, worktreeId: mine.id })
        .readFile(join(mine.path, "a.txt"))
    ).rejects.toThrow(/PATH_NOT_ALLOWED/);

    await expect(
      host
        .fsForWorkspace({ projectId: PROJECT_A, worktreeId: "wt-does-not-exist" })
        .readFile(join(mine.path, "a.txt"))
    ).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("keeps every capability, containment and liveness gate host.fs applies", async () => {
    const mine = await tree("gated");
    setProjects({ [PROJECT_A]: [mine] }, []);
    const scope = { projectId: PROJECT_A, worktreeId: mine.id };

    // A project path with only user-data caps: denied on class, not on path.
    const uncapable = registerBuiltin(["fs:user-data-read"], ["${worktree}"]);
    await expect(
      uncapable.fsForWorkspace(scope).readFile(join(mine.path, "a.txt"))
    ).rejects.toThrow(/PERMISSION_REQUIRED/);
    svc.unloadPlugin("acme.fsgit");

    const host = registerBuiltin(["fs:project-read", "fs:project-write"], ["${worktree}"]);
    const scoped = host.fsForWorkspace(scope);
    // A symlink out of the scoped root is rejected by the same realpath check.
    const secret = join(baseDir, "scoped-secret.txt");
    await fs.writeFile(secret, "TOPSECRET", "utf8");
    await fs.symlink(secret, join(mine.path, "link.txt"));
    await expect(scoped.readFile(join(mine.path, "link.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
    // Writes are audited exactly like host.fs writes.
    appendSpy.mockClear();
    await scoped.writeFile(join(mine.path, "written.txt"), "x");
    expect(
      appendSpy.mock.calls.filter(
        (c) => (c[0] as { channel: string }).channel === "plugin:fs-write"
      ).length
    ).toBe(1);
    // And the data dir stays reachable to a plugin holding user-data caps only
    // through its own class gate, never through the scope.
    await expect(scoped.writeFile(join(dataDir(), "x.txt"), "x")).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );

    svc.unloadPlugin("acme.fsgit");
    await expect(scoped.readFile(join(mine.path, "a.txt"))).rejects.toThrow(/PLUGIN_UNLOADED/);
  });

  it("registers scoped watchers in the plugin's teardown set", async () => {
    const mine = await tree("watched");
    setProjects({ [PROJECT_A]: [mine] }, []);
    const host = registerBuiltin(["fs:project-read"], ["${worktree}"]);
    const scoped = host.fsForWorkspace({ projectId: PROJECT_A, worktreeId: mine.id });

    const dispose = await scoped.watch([join(mine.path, "a.txt")], () => {});
    const watcherMap = (svc as unknown as { pluginFsWatchers: Map<string, Set<unknown>> })
      .pluginFsWatchers;
    expect(watcherMap.get("acme.fsgit")?.size ?? 0).toBe(1);
    svc.unloadPlugin("acme.fsgit");
    expect(watcherMap.has("acme.fsgit")).toBe(false);
    expect(() => dispose()).not.toThrow();
  });

  it("denies a project the user has closed, even while its host is still warm", async () => {
    const mine = await tree("closing");
    // The pool entry (and so the snapshots) outlive the close by design; the
    // persisted row going `closed` is what has to end the scope's authority.
    setProjects({ [PROJECT_A]: [mine] }, []);
    const host = registerBuiltin(["fs:project-read"], ["${worktree}"]);
    const scope = { projectId: PROJECT_A, worktreeId: mine.id };
    // One handle throughout: a fresh handle after the close would not notice
    // an old one keeping the roots it was minted with.
    const scoped = host.fsForWorkspace(scope);
    expect(await scoped.readFile(join(mine.path, "a.txt"))).toBe("closing");

    projectStoreMock.closed.add(PROJECT_A);
    await expect(scoped.readFile(join(mine.path, "a.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("pins the handle to the scope it was minted with, not to the caller's object", async () => {
    const mine = await tree("pinned");
    const other = await tree("repointed");
    setProjects({ [PROJECT_A]: [mine, other] }, []);
    const host = registerBuiltin(["fs:project-read"], ["${worktree}"]);

    const scope = { projectId: PROJECT_A, worktreeId: mine.id };
    const scoped = host.fsForWorkspace(scope);
    // The caller keeps its object; mutating it must not redirect a live handle.
    (scope as { worktreeId: string }).worktreeId = other.id;

    expect(await scoped.readFile(join(mine.path, "a.txt"))).toBe("pinned");
    await expect(scoped.readFile(join(other.path, "a.txt"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("rejects a malformed scope instead of silently expanding to nothing", async () => {
    const host = registerBuiltin(["fs:project-read"], ["${worktree}"]);
    expect(() => host.fsForWorkspace({ projectId: "", worktreeId: "wt" })).toThrow(
      /fsForWorkspace/
    );
    expect(() =>
      host.fsForWorkspace({ projectId: PROJECT_A } as unknown as {
        projectId: string;
        worktreeId: string;
      })
    ).toThrow(/fsForWorkspace/);
  });
});

// #12323: the checked write. #12618: it is the only write — omitting options
// is the same call as passing `{}`.
describe("host.fs.writeFile checked path (#12323)", () => {
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("creates a new file without options and reports the written revision", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "plain.txt");
    const result = await host.fs.writeFile(target, "hello");
    expect(result).toEqual({ revision: sha("hello") });
    expect(await fs.readFile(target, "utf-8")).toBe("hello");
  });

  it("replaces an existing file atomically without options (#12618)", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "plain.txt");
    await fs.writeFile(target, "before");
    // Windows refuses to rename over a file held open, so the descriptor half
    // of the proof is POSIX-only; the replace itself is checked everywhere.
    const held = process.platform === "win32" ? null : await fs.open(target, "r");
    try {
      const result = await host.fs.writeFile(target, "after");
      expect(result).toEqual({ revision: sha("after") });
      expect(await fs.readFile(target, "utf-8")).toBe("after");
      // A rename, not a truncate-and-write: a descriptor opened before the
      // write still reads the file it opened.
      if (held) expect(await held.readFile("utf-8")).toBe("before");
    } finally {
      await held?.close();
    }
    const siblings = await fs.readdir(allowed);
    expect(siblings.filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("refuses a leaf swapped for an outside symlink during consent, without options (#12618)", async () => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "doc.md");
    await fs.writeFile(target, "mine");
    const outside = join(baseDir, "outside.txt");
    await fs.writeFile(outside, "not yours");
    getPluginCapabilityConsentService().setConsentBridge(async () => {
      await fs.rm(target);
      await fs.symlink(outside, target);
      return "approved-once";
    });
    await expect(host.fs.writeFile(target, "redirected")).rejects.toMatchObject({
      code: "TARGET_UNAVAILABLE",
    });
    expect(await fs.readFile(outside, "utf-8")).toBe("not yours");
    const writeAudits = appendSpy.mock.calls.filter(
      (c) => (c[0] as { channel: string }).channel === "plugin:fs-write"
    );
    expect(writeAudits).toEqual([]);
  });

  it("refuses a leaf swapped for an in-scope symlink during consent, without options (#12618)", async () => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "doc.md");
    await fs.writeFile(target, "mine");
    const other = join(allowed, "other.md");
    await fs.writeFile(other, "other");
    getPluginCapabilityConsentService().setConsentBridge(async () => {
      await fs.rm(target);
      await fs.symlink(other, target);
      return "approved-once";
    });
    await expect(host.fs.writeFile(target, "redirected")).rejects.toMatchObject({
      code: "TARGET_UNAVAILABLE",
    });
    expect(await fs.readFile(other, "utf-8")).toBe("other");
  });

  it("writes atomically when the expected revision matches and returns the new one", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "doc.md");
    await fs.writeFile(target, "v1");
    const result = await host.fs.writeFile(target, "v2", { expectedRevision: sha("v1") });
    expect(result.revision).toBe(sha("v2"));
    expect(await fs.readFile(target, "utf-8")).toBe("v2");
    // No temp file left beside the target.
    const siblings = await fs.readdir(allowed);
    expect(siblings.filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("refuses a stale revision with REVISION_MISMATCH carrying the current revision, and writes nothing", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "doc.md");
    await fs.writeFile(target, "on disk");
    let caught: (Error & { code?: string; currentRevision?: string }) | null = null;
    try {
      await host.fs.writeFile(target, "mine", { expectedRevision: sha("what I read") });
    } catch (error) {
      caught = error as Error & { code?: string; currentRevision?: string };
    }
    expect(caught?.code).toBe("REVISION_MISMATCH");
    expect(caught?.message.startsWith("REVISION_MISMATCH:")).toBe(true);
    expect(caught?.currentRevision).toBe(sha("on disk"));
    expect(await fs.readFile(target, "utf-8")).toBe("on disk");
  });

  it("serialises competing checked writers to one winner", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "doc.md");
    await fs.writeFile(target, "base");
    const base = sha("base");
    const results = await Promise.allSettled([
      host.fs.writeFile(target, "A", { expectedRevision: base }),
      host.fs.writeFile(target, "B", { expectedRevision: base }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = rejected[0] as PromiseRejectedResult;
    expect((loser.reason as { code?: string }).code).toBe("REVISION_MISMATCH");
    const onDisk = await fs.readFile(target, "utf-8");
    expect(["A", "B"]).toContain(onDisk);
    expect((fulfilled[0] as PromiseFulfilledResult<{ revision: string }>).value.revision).toBe(
      sha(onDisk)
    );
  });

  it("reports a missing target as TARGET_UNAVAILABLE rather than treating it as empty", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "gone.md");
    await expect(
      host.fs.writeFile(target, "x", { expectedRevision: sha("") })
    ).rejects.toMatchObject({ code: "TARGET_UNAVAILABLE" });
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("creates a new file when expectedRevision is null and refuses an existing one", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "fresh.md");
    const result = await host.fs.writeFile(target, "new", { expectedRevision: null });
    expect(result.revision).toBe(sha("new"));
    await expect(
      host.fs.writeFile(target, "again", { expectedRevision: null })
    ).rejects.toMatchObject({ code: "TARGET_EXISTS" });
    expect(await fs.readFile(target, "utf-8")).toBe("new");
  });

  it("create-new refuses a directory at the target without opening it", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "dir.md");
    await fs.mkdir(target);
    await expect(host.fs.writeFile(target, "x", { expectedRevision: null })).rejects.toMatchObject({
      code: "TARGET_EXISTS",
    });
    expect((await fs.stat(target)).isDirectory()).toBe(true);
  });

  it.each([
    ["with empty options", {}],
    ["without options", undefined],
  ] as const)(
    "a write %s replaces atomically without reading the target",
    async (_label, options) => {
      const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
      const target = join(allowed, "opaque.md");
      await fs.writeFile(target, "v1");
      const canonical = await fs.realpath(target);
      // Reads open a descriptor, so a read of the target shows up as an open.
      const openSpy = vi.spyOn(fs, "open");
      const readSpy = vi.spyOn(fs, "readFile");
      try {
        const result = await host.fs.writeFile(target, "v2", options);
        expect(result.revision).toBe(sha("v2"));
        const touched = [...openSpy.mock.calls, ...readSpy.mock.calls].map((call) => call[0]);
        expect(touched).not.toContain(target);
        expect(touched).not.toContain(canonical);
      } finally {
        openSpy.mockRestore();
        readSpy.mockRestore();
      }
      expect(await fs.readFile(target, "utf-8")).toBe("v2");
    }
  );

  it.each([
    ["with options", {}],
    ["without options", undefined],
  ] as const)("refuses to write through a symlink %s", async (_label, options) => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const real = join(allowed, "real.md");
    await fs.writeFile(real, "real");
    const link = join(allowed, "link.md");
    await fs.symlink(real, link);
    await expect(host.fs.writeFile(link, "x", options)).rejects.toMatchObject({
      code: "TARGET_IS_SYMLINK",
    });
    expect(await fs.readFile(real, "utf-8")).toBe("real");
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
  });

  it.each([
    [
      "with an expected revision",
      { expectedRevision: createHash("sha256").update("v1").digest("hex") },
    ],
    ["without options", undefined],
  ] as const)("preserves the file mode across an atomic replace %s", async (_label, options) => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "script.md");
    await fs.writeFile(target, "v1");
    await fs.chmod(target, 0o640);
    await host.fs.writeFile(target, "v2", options);
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o640);
  });

  it("rejects a malformed expectedRevision up front", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "doc.md");
    await fs.writeFile(target, "v1");
    await expect(host.fs.writeFile(target, "v2", { expectedRevision: "nope" })).rejects.toThrow(
      /expectedRevision/
    );
    expect(await fs.readFile(target, "utf-8")).toBe("v1");
  });

  it("audits a checked write once, like a plain one", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "doc.md");
    await host.fs.writeFile(target, "v1", {});
    const writeAudits = appendSpy.mock.calls.filter(
      (c) => (c[0] as { channel: string }).channel === "plugin:fs-write"
    );
    expect(writeAudits.length).toBe(1);
  });
});

function fsWriteAudits(): Array<{ actionId: string }> {
  return appendSpy.mock.calls
    .map((c) => c[0] as { channel: string; actionId: string })
    .filter((record) => record.channel === "plugin:fs-write");
}

describe("host.fs.readFileWithRevision", () => {
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

  it("returns the text and the revision writeFile accepts as expectedRevision", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "ledger.json");
    await fs.writeFile(target, '﻿{"rows":[]}');

    const read = await host.fs.readFileWithRevision(target);
    expect(read.contents).toBe(await host.fs.readFile(target));
    expect(read.revision).toBe(
      createHash("sha256")
        .update(await fs.readFile(target))
        .digest("hex")
    );

    const written = await host.fs.writeFile(target, '{"rows":[1]}', {
      expectedRevision: read.revision,
    });
    expect(written.revision).toBe(sha('{"rows":[1]}'));
    expect((await host.fs.readFileWithRevision(target)).revision).toBe(written.revision);
  });

  it("hands back a revision that goes stale when the file changes underneath", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "board.md");
    await fs.writeFile(target, "v1");
    const { revision } = await host.fs.readFileWithRevision(target);
    await fs.writeFile(target, "agent edit");
    await expect(
      host.fs.writeFile(target, "mine", { expectedRevision: revision })
    ).rejects.toMatchObject({ code: "REVISION_MISMATCH", currentRevision: sha("agent edit") });
  });

  it("keeps the read gates: capability, containment and an aborted signal", async () => {
    const writeOnly = registerPlugin(["fs:project-write"], [allowed]);
    const target = join(allowed, "x.txt");
    await fs.writeFile(target, "x");
    await expect(writeOnly.fs.readFileWithRevision(target)).rejects.toThrow(/PERMISSION_REQUIRED/);

    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.writeFile(join(baseDir, "secret.txt"), "TOPSECRET");
    await fs.symlink(join(baseDir, "secret.txt"), join(allowed, "link.txt"));
    await expect(host.fs.readFileWithRevision(join(allowed, "link.txt"))).rejects.toThrow(
      /PATH_NOT_ALLOWED/
    );
    await expect(
      host.fs.readFileWithRevision(target, { signal: AbortSignal.abort() })
    ).rejects.toThrow();
  });
});

describe("host.fs.mkdir", () => {
  it("creates missing ancestors, audits each one, and is a no-op on an existing directory", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const target = join(allowed, "data", "2026", "09");

    await host.fs.mkdir(target);
    expect((await fs.stat(target)).isDirectory()).toBe(true);
    const real = await fs.realpath(allowed);
    expect(fsWriteAudits().map((a) => a.actionId)).toEqual([
      `fs.mkdir:${join(real, "data")}`,
      `fs.mkdir:${join(real, "data", "2026")}`,
      `fs.mkdir:${join(real, "data", "2026", "09")}`,
    ]);

    await expect(host.fs.mkdir(target)).resolves.toBeUndefined();
    await expect(host.fs.mkdir(join(allowed, "data"))).resolves.toBeUndefined();
    expect(fsWriteAudits().length).toBe(3);
  });

  it("refuses a path whose existing ancestor is a symlink out of scope, creating nothing", async () => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const outside = join(baseDir, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, join(allowed, "escape"));

    await expect(host.fs.mkdir(join(allowed, "escape", "new", "deeper"))).rejects.toThrow(
      /PATH_NOT_ALLOWED/
    );
    expect(existsSync(join(outside, "new"))).toBe(false);
    expect(fsWriteAudits().length).toBe(0);
  });

  it("refuses a traversal out of the root", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await expect(host.fs.mkdir(join(allowed, "..", "sibling"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
    expect(existsSync(join(baseDir, "sibling"))).toBe(false);
  });

  it("requires a write capability for the path's root class", async () => {
    const readOnly = registerPlugin(["fs:project-read"], [allowed]);
    await expect(readOnly.fs.mkdir(join(allowed, "nope"))).rejects.toThrow(/PERMISSION_REQUIRED/);

    const userDataOnly = registerPlugin(["fs:user-data-read", "fs:user-data-write"], [allowed]);
    await expect(userDataOnly.fs.mkdir(join(allowed, "nope"))).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    expect(existsSync(join(allowed, "nope"))).toBe(false);
  });

  it("does not create anything when the user denies consent", async () => {
    getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await expect(host.fs.mkdir(join(allowed, "denied"))).rejects.toThrow(/PERMISSION_REQUIRED/);
    expect(existsSync(join(allowed, "denied"))).toBe(false);
  });

  it("refuses a file standing at the target", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await fs.writeFile(join(allowed, "taken"), "file");
    await expect(host.fs.mkdir(join(allowed, "taken"))).rejects.toMatchObject({
      code: "TARGET_EXISTS",
    });
  });

  it("creates directories inside the implicit data dir before it exists", async () => {
    const host = registerPlugin(["fs:user-data-read", "fs:user-data-write"], []);
    await host.fs.mkdir(join(dataDir(), "cache", "thumbs"));
    expect((await fs.stat(join(dataDir(), "cache", "thumbs"))).isDirectory()).toBe(true);
  });
});

describe("host.fs.appendFile", () => {
  it("creates a missing file, appends to an existing one, and audits each append", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const log = join(allowed, "habits.jsonl");

    await host.fs.appendFile(log, '{"day":1}\n');
    await host.fs.appendFile(log, '{"day":2}\n');
    expect(await fs.readFile(log, "utf-8")).toBe('{"day":1}\n{"day":2}\n');

    const audits = fsWriteAudits();
    expect(audits.length).toBe(2);
    expect(audits[0]?.actionId).toBe(`fs.appendFile:${await fs.realpath(log)}`);
  });

  it("lands every concurrent append whole", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const log = join(allowed, "inbox.jsonl");
    const lines = Array.from({ length: 25 }, (_, i) => `{"n":${i}}\n`);
    await Promise.all(lines.map((line) => host.fs.appendFile(log, line)));
    const written = (await fs.readFile(log, "utf-8")).split("\n").filter(Boolean);
    expect(written.sort()).toEqual(lines.map((line) => line.trim()).sort());
  });

  it("keeps an existing file's inode rather than replacing it", async () => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const log = join(allowed, "ledger.jsonl");
    await fs.writeFile(log, "a\n");
    const before = await fs.stat(log);
    await host.fs.appendFile(log, "b\n");
    expect((await fs.stat(log)).ino).toBe(before.ino);
  });

  it("refuses a symlink leaf, even one pointing inside scope", async () => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const real = join(allowed, "real.jsonl");
    await fs.writeFile(real, "keep\n");
    const link = join(allowed, "link.jsonl");
    await fs.symlink(real, link);

    await expect(host.fs.appendFile(link, "sneak\n")).rejects.toMatchObject({
      code: "TARGET_IS_SYMLINK",
    });
    expect(await fs.readFile(real, "utf-8")).toBe("keep\n");
  });

  it("refuses a symlink leaf pointing out of scope", async () => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const secret = join(baseDir, "secret.jsonl");
    await fs.writeFile(secret, "outside\n");
    await fs.symlink(secret, join(allowed, "escape.jsonl"));
    await expect(host.fs.appendFile(join(allowed, "escape.jsonl"), "x\n")).rejects.toThrow(
      /PATH_NOT_ALLOWED/
    );
    expect(await fs.readFile(secret, "utf-8")).toBe("outside\n");
  });

  it("requires a write capability and a string", async () => {
    const readOnly = registerPlugin(["fs:project-read"], [allowed]);
    await expect(readOnly.fs.appendFile(join(allowed, "log.jsonl"), "x")).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    expect(existsSync(join(allowed, "log.jsonl"))).toBe(false);

    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await expect(
      host.fs.appendFile(join(allowed, "log.jsonl"), 42 as unknown as string)
    ).rejects.toThrow(/contents must be a string/);
  });

  it("needs the parent directory to exist outside the data dir", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await expect(host.fs.appendFile(join(allowed, "missing", "log.jsonl"), "x")).rejects.toThrow(
      /ENOENT/
    );
  });

  it("refuses a directory at the target", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await fs.mkdir(join(allowed, "dir.jsonl"));
    await expect(host.fs.appendFile(join(allowed, "dir.jsonl"), "x")).rejects.toThrow();
  });
});

describe("host.fs.watch recursive and debounced", () => {
  async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("waitFor timed out");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("reports a nested change and a file in a subdirectory created after subscribing", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const nested = join(allowed, "cards", "todo");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(join(nested, "a.md"), "a");
    const realAllowed = await fs.realpath(allowed);

    const changes: string[] = [];
    const dispose = await host.fs.watch([allowed], (p) => changes.push(p), { recursive: true });
    try {
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(join(nested, "a.md"), "changed");
      await waitFor(() => changes.includes(join(realAllowed, "cards", "todo", "a.md")));

      await fs.mkdir(join(allowed, "cards", "done"));
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(join(allowed, "cards", "done", "b.md"), "b");
      await waitFor(() => changes.includes(join(realAllowed, "cards", "done", "b.md")));
    } finally {
      dispose();
    }
  });

  it("keeps a plain watch to immediate children while a recursive one shares the directory", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.mkdir(join(allowed, "sub"));
    const realAllowed = await fs.realpath(allowed);

    const plain: string[] = [];
    const deep: string[] = [];
    const disposePlain = await host.fs.watch([allowed], (p) => plain.push(p));
    const disposeDeep = await host.fs.watch([allowed], (p) => deep.push(p), { recursive: true });
    try {
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(join(allowed, "sub", "deep.txt"), "x");
      await waitFor(() => deep.includes(join(realAllowed, "sub", "deep.txt")));
      expect(plain).not.toContain(join(realAllowed, "sub", "deep.txt"));
    } finally {
      disposePlain();
      disposeDeep();
    }
  });

  it("coalesces a burst into one trailing callback", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const changes: string[] = [];
    const dispose = await host.fs.watch([allowed], (p) => changes.push(p), { debounceMs: 250 });
    try {
      await new Promise((r) => setTimeout(r, 100));
      for (let i = 0; i < 8; i++) {
        await fs.writeFile(join(allowed, `burst-${i}.txt`), String(i));
      }
      await waitFor(() => changes.length > 0);
      await new Promise((r) => setTimeout(r, 600));
      expect(changes.length).toBe(1);
      expect(changes[0]).toMatch(/burst-\d\.txt$/);
    } finally {
      dispose();
    }
  });

  it("drops a pending debounced callback when disposed", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const changes: string[] = [];
    const dispose = await host.fs.watch([allowed], (p) => changes.push(p), { debounceMs: 400 });
    await new Promise((r) => setTimeout(r, 100));
    await fs.writeFile(join(allowed, "late.txt"), "x");
    await new Promise((r) => setTimeout(r, 150));
    dispose();
    await new Promise((r) => setTimeout(r, 500));
    expect(changes).toEqual([]);
  });
});

describe("host.fs mutation gating before any directory is created", () => {
  it("creates no data dir when consent to a data-dir mkdir or append is denied", async () => {
    getPluginCapabilityConsentService().setConsentBridge(async () => "rejected");
    const host = registerPlugin(["fs:user-data-read", "fs:user-data-write"], []);
    await expect(host.fs.mkdir(join(dataDir(), "cache"))).rejects.toThrow(/PERMISSION_REQUIRED/);
    await expect(host.fs.appendFile(join(dataDir(), "logs", "a.jsonl"), "x")).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    await expect(host.fs.writeFile(join(dataDir(), "notes", "a.md"), "x")).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    expect(existsSync(dataDir())).toBe(false);
    expect(fsWriteAudits()).toEqual([]);
  });

  it("asks for consent once per call, even when the data dir is bootstrapped", async () => {
    const bridge = vi.fn(async () => "approved-once" as const);
    getPluginCapabilityConsentService().setConsentBridge(bridge);
    const host = registerPlugin(["fs:user-data-read", "fs:user-data-write"], []);
    await host.fs.appendFile(join(dataDir(), "log.jsonl"), "x\n");
    expect(bridge).toHaveBeenCalledTimes(1);
  });

  it("audits every directory it creates, including the data dir bootstrap", async () => {
    const host = registerPlugin(["fs:user-data-read", "fs:user-data-write"], []);
    await host.fs.mkdir(dataDir());
    // The bootstrap creates the whole host-owned chain under the home dir,
    // and each directory it makes is audited.
    expect(fsWriteAudits().map((a) => a.actionId)).toEqual([
      `fs.mkdir:${join(homeDir, ".daintree")}`,
      `fs.mkdir:${join(homeDir, ".daintree", "plugin-data")}`,
      `fs.mkdir:${dataDir()}`,
    ]);

    appendSpy.mockClear();
    await host.fs.appendFile(join(dataDir(), "2026", "09", "log.jsonl"), "x\n");
    const realData = await fs.realpath(dataDir());
    expect(fsWriteAudits().map((a) => a.actionId)).toEqual([
      `fs.mkdir:${join(realData, "2026")}`,
      `fs.mkdir:${join(realData, "2026", "09")}`,
      `fs.appendFile:${join(realData, "2026", "09", "log.jsonl")}`,
    ]);
  });

  it("audits each ancestor a project mkdir creates", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    await host.fs.mkdir(join(allowed, "a", "b"));
    const real = await fs.realpath(allowed);
    expect(fsWriteAudits().map((a) => a.actionId)).toEqual([
      `fs.mkdir:${join(real, "a")}`,
      `fs.mkdir:${join(real, "a", "b")}`,
    ]);
  });
});

describe("host.fs audits a mutation that fails part-way", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("audits the directories a mkdir created before a later component failed", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const real = await fs.realpath(allowed);
    const realMkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation((async (target: string, options?: unknown) => {
      if (target === join(real, "a", "b", "c")) {
        throw Object.assign(new Error("EACCES: denied"), { code: "EACCES" });
      }
      return realMkdir(target, options as undefined);
    }) as typeof fs.mkdir);

    await expect(host.fs.mkdir(join(allowed, "a", "b", "c"))).rejects.toThrow(/EACCES/);
    expect(fsWriteAudits().map((a) => a.actionId)).toEqual([
      `fs.mkdir:${join(real, "a")}`,
      `fs.mkdir:${join(real, "a", "b")}`,
    ]);
  });

  it("audits an append whose close fails after the bytes were written", async () => {
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const log = join(allowed, "log.jsonl");
    const realOpen = fs.open.bind(fs);
    // `close` is an own property of each FileHandle, so the handle the append
    // opens is wrapped rather than a prototype patched.
    vi.spyOn(fs, "open").mockImplementationOnce((async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      const realClose = handle.close.bind(handle);
      handle.close = async () => {
        await realClose();
        throw new Error("EIO: close failed");
      };
      return handle;
    }) as typeof fs.open);

    await expect(host.fs.appendFile(log, "line\n")).rejects.toThrow(/EIO/);
    expect(await fs.readFile(log, "utf-8")).toBe("line\n");
    const records = appendSpy.mock.calls
      .map((c) => c[0] as { channel: string; actionId: string; result: string })
      .filter((record) => record.channel === "plugin:fs-write");
    expect(records).toEqual([
      expect.objectContaining({
        actionId: `fs.appendFile:${await fs.realpath(log)}`,
        result: "error",
      }),
    ]);
  });
});

describe("host.fs.appendFile special files", () => {
  it("refuses a FIFO at the target without blocking on it", async () => {
    if (process.platform === "win32") return;
    const host = registerPlugin(["fs:project-read", "fs:project-write"], [allowed]);
    const fifo = join(allowed, "pipe.jsonl");
    execFileSync("mkfifo", [fifo]);
    await expect(host.fs.appendFile(fifo, "x\n")).rejects.toMatchObject({
      code: "TARGET_UNAVAILABLE",
    });
    // The path lock was released: a regular append on another path still runs.
    await host.fs.appendFile(join(allowed, "after.jsonl"), "ok\n");
    expect(await fs.readFile(join(allowed, "after.jsonl"), "utf-8")).toBe("ok\n");
  });
});

describe("host.fs.watch option validation", () => {
  it("rejects a non-boolean recursive and a non-finite or negative debounceMs", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const cb = () => {};
    await expect(
      host.fs.watch([allowed], cb, { recursive: "yes" as unknown as boolean })
    ).rejects.toThrow(/recursive must be a boolean/);
    for (const debounceMs of [Infinity, Number.NaN, -1, "100" as unknown as number]) {
      await expect(host.fs.watch([allowed], cb, { debounceMs })).rejects.toThrow(/debounceMs/);
    }
    const watchers = (svc as unknown as { pluginFsWatchers: Map<string, Set<unknown>> })
      .pluginFsWatchers;
    expect(watchers.get("acme.fsgit")?.size ?? 0).toBe(0);
  });

  it("clamps an oversized debounceMs instead of letting it overflow to an immediate fire", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const changes: string[] = [];
    const dispose = await host.fs.watch([allowed], (p) => changes.push(p), {
      debounceMs: 1e12,
    });
    try {
      await new Promise((r) => setTimeout(r, 100));
      await fs.writeFile(join(allowed, "slow.txt"), "x");
      await new Promise((r) => setTimeout(r, 400));
      expect(changes).toEqual([]);
    } finally {
      dispose();
    }
  });
});
