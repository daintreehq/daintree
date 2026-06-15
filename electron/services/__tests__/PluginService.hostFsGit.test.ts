// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import path from "node:path";

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
  svc = new PluginService(pluginsRoot);
});

afterEach(() => {
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
