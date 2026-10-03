// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

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
import type { PluginManifest, PluginHostApi } from "../../../shared/types/plugin.js";
import {
  PluginPushListenerRegistry,
  resetPluginPushListenerRegistryForTests,
} from "../plugin/pluginPushListenerRegistry.js";
import { observePluginPushListeners } from "../plugin/pluginInternalApprovers.js";

let svc: PluginService;
let baseDir: string;
let allowed: string;
let homeDir: string;
let homedirSpy: MockInstance<() => string>;

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

describe("host.fs.walk", () => {
  const walk = (host: PluginHostApi) => host.fs.walk!;

  it("lists a contained tree in one call", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await fs.mkdir(join(allowed, "src"), { recursive: true });
    await fs.writeFile(join(allowed, "src", "a.ts"), "a");
    await fs.writeFile(join(allowed, "readme.md"), "r");
    const result = await walk(host)(allowed, { includeSize: true });
    expect(result).toEqual({
      entries: [
        { path: "readme.md", type: "file", size: 1 },
        { path: "src", type: "dir" },
        { path: "src/a.ts", type: "file", size: 1 },
      ],
      truncated: false,
    });
  });

  it("rejects a root outside every allowed path", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await expect(walk(host)(join(allowed, ".."))).rejects.toThrow(/PATH_NOT_ALLOWED/);
    await expect(walk(host)(baseDir)).rejects.toThrow(/PATH_NOT_ALLOWED/);
  });

  it("rejects a symlinked root that resolves outside, and never lists through an inner link", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    const outside = join(baseDir, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(join(outside, "secret.txt"), "TOPSECRET");
    await fs.symlink(outside, join(allowed, "escape"));
    await fs.writeFile(join(allowed, "ok.txt"), "ok");
    await expect(walk(host)(join(allowed, "escape"))).rejects.toThrow(/PATH_NOT_ALLOWED/);
    const result = await walk(host)(allowed);
    expect(result.entries.map((e) => e.path)).toEqual(["ok.txt"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("requires a read capability, and the one for the root's class", async () => {
    await expect(walk(registerPlugin(["fs:project-write"], [allowed]))(allowed)).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
    await expect(walk(registerPlugin(["fs:user-data-read"], [allowed]))(allowed)).rejects.toThrow(
      /PERMISSION_REQUIRED/
    );
  });

  it("validates options before touching the disk", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    await expect(walk(host)(allowed, { limit: 0 })).rejects.toThrow(/VALIDATION/);
  });

  it("rejects once the plugin is unloaded", async () => {
    const host = registerPlugin(["fs:project-read"], [allowed]);
    (
      svc as unknown as { _unregisterFakePluginForTests(id: string): void }
    )._unregisterFakePluginForTests("acme.fsgit");
    await expect(walk(host)(allowed)).rejects.toThrow(/PLUGIN_UNLOADED/);
  });
});

describe("host.hasListeners / onDidChangeListeners (in-process)", () => {
  interface FakeRenderer {
    id: number;
    isDestroyed(): boolean;
    once(event: "destroyed", listener: () => void): void;
  }
  let renderers: FakeRenderer[];
  let registry: PluginPushListenerRegistry;

  beforeEach(() => {
    renderers = [];
    registry = new PluginPushListenerRegistry(() => renderers);
    resetPluginPushListenerRegistryForTests(registry);
  });
  afterEach(() => {
    resetPluginPushListenerRegistryForTests();
  });

  const renderer = (id: number): FakeRenderer => {
    const r = { id, isDestroyed: () => false, once: vi.fn() };
    renderers.push(r);
    return r;
  };

  it("answers from the renderers' reports and notifies on change", () => {
    const host = registerPlugin([], []);
    const r = renderer(1);
    // Not reported yet: assumed listening.
    expect(host.hasListeners!("tick")).toBe(true);
    registry.report(r, []);
    expect(host.hasListeners!("tick")).toBe(false);

    const seen: boolean[] = [];
    const dispose = host.onDidChangeListeners!("tick", (has) => seen.push(has));
    registry.report(r, [["plugin:acme.fsgit:tick", null]]);
    registry.report(r, [["plugin:acme.fsgit:other", null]]);
    expect(seen).toEqual([true, false]);
    dispose();
    registry.report(r, [["plugin:acme.fsgit:tick", null]]);
    expect(seen).toEqual([true, false]);
  });

  it("counts a panel-targeted subscriber as a listener on the channel", () => {
    const host = registerPlugin([], []);
    registry.report(renderer(1), [["plugin:acme.fsgit:tick", "panel-a"]]);
    expect(host.hasListeners!("tick")).toBe(true);
  });

  it("validates the channel", () => {
    const host = registerPlugin([], []);
    expect(() => host.hasListeners!("a:b")).toThrow(/channel/);
    expect(() => host.onDidChangeListeners!("", () => {})).toThrow(/channel/);
    expect(() => host.onDidChangeListeners!("tick", 1 as never)).toThrow(/callback/);
  });

  const eventSubscriptions = (): number =>
    (svc as unknown as { pluginEventCleanups: Map<string, unknown[]> }).pluginEventCleanups.get(
      "acme.fsgit"
    )?.length ?? 0;

  it("counts onDidChangeListeners as an event subscription, but not the worker's observation", () => {
    const host = registerPlugin([], []);
    const r = renderer(1);
    registry.report(r, []);
    const seen: boolean[] = [];
    const observation = observePluginPushListeners(host, "tick", (has) => seen.push(has));
    expect(observation?.current).toBe(false);
    expect(eventSubscriptions()).toBe(0);
    // Passive: an observation alone never runs the periodic reconcile.
    expect(registry.isReconciling()).toBe(false);
    registry.report(r, [["plugin:acme.fsgit:tick", null]]);
    expect(seen).toEqual([true]);

    const dispose = host.onDidChangeListeners!("tick", () => {});
    expect(eventSubscriptions()).toBe(1);
    expect(registry.isReconciling()).toBe(true);
    dispose();
    expect(eventSubscriptions()).toBe(0);
    expect(registry.isReconciling()).toBe(false);
    observation?.dispose();
    expect(registry.watcherCount()).toBe(0);
  });

  it("drops a worker observation that outlives its plugin on the next change", () => {
    const host = registerPlugin([], []);
    const r = renderer(1);
    registry.report(r, []);
    const seen: boolean[] = [];
    observePluginPushListeners(host, "tick", (has) => seen.push(has));
    svc.unloadPlugin("acme.fsgit");
    registry.report(r, [["plugin:acme.fsgit:tick", null]]);
    expect(seen).toEqual([]);
    expect(registry.watcherCount()).toBe(0);
  });

  it("answers false and stops notifying once the plugin unloads", () => {
    const host = registerPlugin([], []);
    const r = renderer(1);
    registry.report(r, []);
    const seen: boolean[] = [];
    host.onDidChangeListeners!("tick", (has) => seen.push(has));
    svc.unloadPlugin("acme.fsgit");
    registry.report(r, [["plugin:acme.fsgit:tick", null]]);
    expect(seen).toEqual([]);
    expect(host.hasListeners!("tick")).toBe(false);
    expect(registry.watcherCount()).toBe(0);
  });
});
