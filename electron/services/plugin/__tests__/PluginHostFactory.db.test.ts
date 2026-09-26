import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
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
import { approvePluginDatabaseBackup } from "../pluginInternalApprovers.js";
import {
  makeProjectPluginInstanceKey,
  type PluginDatabaseContribution,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

const PROJECT_ID = "b".repeat(64);
const INSTANCE = makeProjectPluginInstanceKey(PROJECT_ID, "acme.ledger");

let tmp: string;
let projectRoot: string;
let dataDir: string;

function loadedPlugin(databases: PluginDatabaseContribution[]): LoadedPlugin {
  return {
    isBuiltin: false,
    manifest: {
      name: "acme.ledger",
      capabilities: ["fs:project-read", "fs:project-write"],
      contributes: { forgeProviders: [], fileDecorationProviders: [], databases },
    },
  } as unknown as LoadedPlugin;
}

function makeDeps(databases: PluginDatabaseContribution[]) {
  const plugins = new Map<string, LoadedPlugin>([[INSTANCE, loadedPlugin(databases)]]);
  const pluginEventCleanups = new Map<string, Array<() => void>>();
  const deps = {
    plugins,
    pluginEventCleanups,
    declaredCapabilities: () => new Set(["fs:project-read", "fs:project-write"]),
    pluginDataDir: () => dataDir,
    getHostGitFactory: () => undefined,
    getProcessManager: vi.fn(),
    // What the host.fs write gate behind db.backup consults: the project is
    // the one declared root.
    isPathUnder: (root: string, candidate: string) => {
      const rel = path.relative(root, candidate);
      return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    },
    expandAllowedPathEntries: async () => [{ path: projectRoot, rootClass: "project" }],
    safeAppendAudit: vi.fn(),
    safeArgsHash: () => "hash",
  } as unknown as PluginHostFactoryDeps;
  return { deps, plugins, pluginEventCleanups };
}

beforeEach(async () => {
  tmp = await fsp.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "host-db-")));
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

  it("backs up only to a destination the fs write gate approves", async () => {
    const { deps } = makeDeps([
      { id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" },
    ]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    const db = await host.db.open("ledger", {
      migrations: ["CREATE TABLE t (x); INSERT INTO t VALUES (7)"],
    });
    const outside = path.join(tmp, "elsewhere.db");
    await expect(db.backup(outside)).rejects.toThrow(/PATH_NOT_ALLOWED/);
    expect(fs.existsSync(outside)).toBe(false);

    ensureAllowed.mockClear();
    fs.mkdirSync(path.join(projectRoot, "backups"));
    const dest = path.join(projectRoot, "backups", "finance.db");
    expect(await db.backup(dest)).toEqual({ path: dest, bytes: fs.statSync(dest).size });
    expect(ensureAllowed.mock.calls.map((call) => call[2])).toEqual(["fs:project-write"]);
    const copy = new DatabaseSync(dest, { readOnly: true });
    expect(copy.prepare("SELECT x FROM t").all()).toEqual([{ x: 7 }]);
    copy.close();
    await db.close();
  });

  it("approves a worker's backup destination through the same gate", async () => {
    const { deps } = makeDeps([
      { id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" },
    ]);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    await (await host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] })).close();
    const dest = path.join(projectRoot, "ledger-copy.db");
    // What the main bridge runs for the worker's `db.prepareBackup` call.
    await expect(approvePluginDatabaseBackup(host.db, "ledger", dest)).resolves.toBe(dest);
    await expect(
      approvePluginDatabaseBackup(host.db, "ledger", path.join(tmp, "elsewhere.db"))
    ).rejects.toThrow(/PATH_NOT_ALLOWED/);
    await expect(approvePluginDatabaseBackup(host.db, "other", dest)).rejects.toThrow(
      /DB_NOT_DECLARED/
    );
  });

  it("gives a host kept across a same-id reload no access to the new instance's databases", async () => {
    const declared: PluginDatabaseContribution[] = [
      { id: "cache", location: "local", journalMode: "delete" },
    ];
    const { deps, plugins, pluginEventCleanups } = makeDeps(declared);
    const { host: stale } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    plugins.set(
      INSTANCE,
      loadedPlugin([...declared, { id: "fresh", location: "local", journalMode: "delete" }])
    );
    await expect(stale.db.open("cache")).rejects.toThrow(/PLUGIN_UNLOADED/);
    await expect(stale.db.resolve("fresh")).rejects.toThrow(/PLUGIN_UNLOADED/);
    expect(pluginEventCleanups.get(INSTANCE)).toBeUndefined();
  });

  it("abandons an open whose plugin reloaded while it waited for consent", async () => {
    const declared: PluginDatabaseContribution[] = [
      { id: "ledger", location: "project", journalMode: "delete" },
    ];
    const { deps, plugins, pluginEventCleanups } = makeDeps(declared);
    const { host } = createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot });
    ensureAllowed.mockImplementationOnce(async () => {
      plugins.set(INSTANCE, loadedPlugin(declared));
    });
    await expect(host.db.open("ledger")).rejects.toThrow(/PLUGIN_UNLOADED/);
    expect(fs.existsSync(path.join(projectRoot, ".daintree"))).toBe(false);
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
