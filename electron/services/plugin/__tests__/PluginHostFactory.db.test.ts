import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: { readImage: vi.fn(), writeText: vi.fn(), readText: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
}));
vi.mock("../../../ipc/utils.js", () => ({
  broadcastToRenderer: vi.fn(),
  broadcastToProjectRenderers: vi.fn(),
}));
vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: vi.fn(() => null) }));
vi.mock("../../PluginActionAuditService.js", () => ({
  getPluginActionAuditService: vi.fn(() => ({ append: vi.fn(), getRecords: vi.fn(() => []) })),
}));
const ensureAllowed = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => ({ ensureAllowed })),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import {
  makeProjectPluginInstanceKey,
  type PluginDatabaseContribution,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const PROJECT_ID = "b".repeat(64);
const INSTANCE = makeProjectPluginInstanceKey(PROJECT_ID, "acme.ledger");

let tmp: string;
let projectRoot: string;
let dataDir: string;

function makeDeps(databases: PluginDatabaseContribution[]) {
  const plugins = new Map<string, LoadedPlugin>([
    [
      INSTANCE,
      {
        isBuiltin: false,
        manifest: {
          name: "acme.ledger",
          capabilities: ["fs:project-write"],
          contributes: { forgeProviders: [], fileDecorationProviders: [], databases },
        },
      } as unknown as LoadedPlugin,
    ],
  ]);
  const pluginEventCleanups = new Map<string, Array<() => void>>();
  const deps = {
    plugins,
    pluginEventCleanups,
    declaredCapabilities: () => new Set(["fs:project-write"]),
    pluginDataDir: () => dataDir,
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
  } as unknown as PluginHostFactoryDeps;
  return { deps, plugins, pluginEventCleanups };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-db-")));
  projectRoot = path.join(tmp, "project");
  dataDir = path.join(tmp, "plugin-data");
  fs.mkdirSync(projectRoot);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("host.db (in-process host)", () => {
  it("opens a declared project database against the bound project root", async () => {
    const { deps } = makeDeps([
      { id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" },
    ]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    const db = await host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] });
    expect(db.location.path).toBe(path.join(projectRoot, "data/finance.db"));
    await db.run("INSERT INTO t VALUES (1)");
    expect(fs.existsSync(path.join(projectRoot, "data/finance.db"))).toBe(true);
    await db.close();
  });

  it("asks for project-write consent before touching the repository, and not for a local database", async () => {
    ensureAllowed.mockClear();
    const { deps } = makeDeps([
      { id: "ledger", location: "project", journalMode: "delete" },
      { id: "cache", location: "local", journalMode: "delete" },
    ]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    await (await host.db.open("cache")).close();
    expect(ensureAllowed).not.toHaveBeenCalled();
    ensureAllowed.mockRejectedValueOnce(new Error("CONSENT_DENIED: no"));
    await expect(host.db.open("ledger")).rejects.toThrow(/CONSENT_DENIED/);
    expect(fs.existsSync(path.join(projectRoot, ".daintree"))).toBe(false);
  });

  it("opens a project database readonly without consent and without creating anything", async () => {
    ensureAllowed.mockClear();
    const { deps } = makeDeps([{ id: "ledger", location: "project", journalMode: "delete" }]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    await expect(host.db.open("ledger", { readonly: true })).rejects.toThrow(/DB_NOT_FOUND/);
    expect(fs.existsSync(path.join(projectRoot, ".daintree"))).toBe(false);
    expect(ensureAllowed).not.toHaveBeenCalled();
    await (await host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] })).close();
    ensureAllowed.mockClear();
    const reader = await host.db.open("ledger", { readonly: true });
    expect(await reader.query("SELECT count(*) AS n FROM t")).toEqual([{ n: 0 }]);
    expect(ensureAllowed).not.toHaveBeenCalled();
    await reader.close();
  });

  it("stops tracking a handle the plugin closed itself", async () => {
    const { deps, pluginEventCleanups } = makeDeps([
      { id: "cache", location: "local", journalMode: "delete" },
    ]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    const db = await host.db.open("cache");
    expect(pluginEventCleanups.get(INSTANCE)?.length).toBe(1);
    await db.close();
    expect(pluginEventCleanups.get(INSTANCE)).toBeUndefined();
  });

  it("refuses an undeclared id", async () => {
    const { deps } = makeDeps([]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    await expect(host.db.open("ledger")).rejects.toThrow(/DB_NOT_DECLARED/);
    await expect(host.db.resolve("ledger")).rejects.toThrow(/DB_NOT_DECLARED/);
  });

  it("closes open handles through the plugin's unload cleanups", async () => {
    const { deps, pluginEventCleanups } = makeDeps([
      { id: "cache", location: "local", journalMode: "delete" },
    ]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    const db = await host.db.open("cache");
    const cleanups = pluginEventCleanups.get(INSTANCE) ?? [];
    expect(cleanups.length).toBeGreaterThan(0);
    for (const cleanup of [...cleanups]) cleanup();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(db.query("SELECT 1")).rejects.toMatchObject({ code: "DB_CLOSED" });
  });

  it("refuses to open once the plugin has unloaded", async () => {
    const { deps, plugins } = makeDeps([{ id: "cache", location: "local", journalMode: "delete" }]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    plugins.delete(INSTANCE);
    await expect(host.db.open("cache")).rejects.toThrow(/PLUGIN_UNLOADED/);
  });
});
