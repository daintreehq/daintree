// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { owners, consentMock } = vi.hoisted(() => ({
  owners: {
    projectsForPath: (_p: string): readonly string[] | Promise<readonly string[]> => [],
  },
  consentMock: { ensureAllowed: vi.fn(async (..._args: unknown[]) => undefined) },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/daintree-test"), getVersion: vi.fn(() => "0.0.0") },
  clipboard: {},
  shell: {},
  ipcMain: { on: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  webContents: { getAllWebContents: () => [], fromId: () => null },
}));
vi.mock("../../plugin-capability/instances.js", () => ({
  getPluginCapabilityConsentService: vi.fn(() => consentMock),
  getPluginCapabilityConsentStore: vi.fn(() => ({ hasGrant: vi.fn(() => false) })),
}));
vi.mock("../../driveLeaseTargetResolvers.js", () => ({
  createLeaseTargetResolvers: () => ({
    projectsForPath: (p: string) => owners.projectsForPath(p),
    describeTerminal: () => "missing",
    projectsForOperation: () => [],
    projectsForDevPreviewPanel: () => [],
    projectsForHelpSession: () => [],
    currentProjectId: () => null,
  }),
}));

import { createHost, type PluginHostFactoryDeps } from "../PluginHostFactory.js";
import { approvePluginDatabaseWrite } from "../pluginInternalApprovers.js";
import { agentMcpEndpointRegistry } from "../../pluginAgentMcp/endpointRegistry.js";
import {
  _resetPluginFrontendRoutingForTesting,
  runInPluginInvocation,
  setPluginFrontendRouter,
} from "../pluginFrontendRouting.js";
import {
  _resetDriveLeaseServiceForTesting,
  type DriveLeaseService,
} from "../../DriveLeaseService.js";
import type { ClientEndpoint } from "../../../ipc/endpoint.js";
import type { DriveLeaseHolder } from "../../../../shared/types/remoteHosts.js";
import {
  makeProjectPluginInstanceKey,
  type PluginDatabaseContribution,
} from "../../../../shared/types/plugin.js";
import type { LoadedPlugin } from "../PluginServiceTypes.js";

/**
 * A plugin's project database is a file in the repository, so a call from a
 * view that watches the project can read it but not change it, as with every
 * other project write a plugin makes (#14094).
 */
const PROJECT_ID = "c".repeat(64);
const INSTANCE = makeProjectPluginInstanceKey(PROJECT_ID, "acme.ledger");
const DATABASES: PluginDatabaseContribution[] = [
  { id: "ledger", location: "project", path: "data/finance.db", journalMode: "delete" },
  { id: "cache", location: "local", journalMode: "delete" },
  { id: "vendored", location: "project", path: "vendor/lib/notes.db", journalMode: "delete" },
];

function endpoint(endpointId: string, clientId: string): ClientEndpoint {
  return {
    endpointId,
    clientId,
    projectId: PROJECT_ID,
    kind: "remote-view",
    handle: -1,
    send: vi.fn(),
    request: vi.fn(),
    onClose: () => ({ dispose: () => undefined }),
    isClosed: () => false,
  };
}

const HOLDER = endpoint("remote:-9", "client-c");
const WATCHER = endpoint("remote:-4", "client-b");

function holder(of: ClientEndpoint): DriveLeaseHolder {
  return {
    leaseId: 1,
    endpointId: of.endpointId,
    clientId: of.clientId,
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 0,
  };
}

function installLeases(leases: Map<string, ClientEndpoint>): void {
  const service = {
    projectsDrivenElsewhere: (caller: Pick<ClientEndpoint, "endpointId">) => {
      const out = new Map<string, DriveLeaseHolder>();
      for (const [projectId, by] of leases) {
        if (by.endpointId !== caller.endpointId) out.set(projectId, holder(by));
      }
      return out;
    },
    dispose: () => undefined,
  };
  _resetDriveLeaseServiceForTesting(service as unknown as DriveLeaseService);
}

const asCaller = <T>(caller: ClientEndpoint, fn: () => Promise<T>) =>
  runInPluginInvocation(INSTANCE, caller, fn);

describe("plugin database writes from a view that doesn't drive the project", () => {
  let tmp: string;
  let projectRoot: string;
  let dataDir: string;
  let dbFile: string;

  function makeHost() {
    const plugin = {
      isBuiltin: false,
      manifest: {
        name: "acme.ledger",
        capabilities: ["fs:project-read", "fs:project-write", "mcp:expose"],
        contributes: {
          forgeProviders: [],
          fileDecorationProviders: [],
          databases: DATABASES,
          agentMcp: [{ id: "data", name: "data", mode: "tools" }],
        },
      },
    } as unknown as LoadedPlugin;
    const deps = {
      plugins: new Map([[INSTANCE, plugin]]),
      pluginEventCleanups: new Map<string, Array<() => void>>(),
      declaredCapabilities: () => new Set(["fs:project-read", "fs:project-write", "mcp:expose"]),
      pluginDataDir: () => dataDir,
      getHostGitFactory: () => undefined,
      getProcessManager: vi.fn(),
      isPathUnder: (root: string, candidate: string) => {
        const rel = path.relative(root, candidate);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      },
      expandAllowedPathEntries: async () => [{ path: projectRoot, rootClass: "project" }],
      safeAppendAudit: vi.fn(),
      safeArgsHash: () => "hash",
    } as unknown as PluginHostFactoryDeps;
    return createHost(deps, INSTANCE, { projectId: PROJECT_ID, projectRoot }).host;
  }

  const rows = async (db: { query: (sql: string) => Promise<unknown[]> }) =>
    (await db.query("SELECT x FROM t ORDER BY x")).map((r) => Number((r as { x: unknown }).x));

  /** A ledger with one row, made by the driver before the watcher arrives. */
  async function seedLedger(host: ReturnType<typeof makeHost>) {
    const db = await asCaller(HOLDER, () =>
      host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] })
    );
    await asCaller(HOLDER, () => db.run("INSERT INTO t VALUES (1)"));
    return db;
  }

  beforeEach(async () => {
    tmp = await fsp.realpath(fs.mkdtempSync(path.join(os.tmpdir(), "lease-db-")));
    projectRoot = path.join(tmp, "project");
    dataDir = path.join(tmp, "plugin-data");
    fs.mkdirSync(projectRoot);
    dbFile = path.join(projectRoot, "data/finance.db");
    owners.projectsForPath = (p) =>
      p === projectRoot || p.startsWith(projectRoot + path.sep) ? ["p1"] : [];
    consentMock.ensureAllowed.mockReset();
    consentMock.ensureAllowed.mockImplementation(async () => undefined);
    setPluginFrontendRouter({ resolve: () => ({ kind: "local" }), onChange: () => () => {} });
  });

  afterEach(() => {
    agentMcpEndpointRegistry.clear();
    _resetPluginFrontendRoutingForTesting();
    _resetDriveLeaseServiceForTesting(null);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refuses a writable open, creating nothing and asking for no consent", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const host = makeHost();

    const refused = asCaller(WATCHER, () =>
      host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] })
    );

    await expect(refused).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    await expect(refused).rejects.toThrow(/^DRIVEN_ELSEWHERE: .*Take control first\.$/);
    await expect(asCaller(WATCHER, () => host.db.resolve("ledger"))).rejects.toMatchObject({
      code: "DRIVEN_ELSEWHERE",
    });
    expect(fs.existsSync(path.dirname(dbFile))).toBe(false);
    expect(consentMock.ensureAllowed).not.toHaveBeenCalled();
  });

  it("still opens the database readonly and queries it for the view that watches", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const host = makeHost();
    await (await seedLedger(host)).close();

    const reader = await asCaller(WATCHER, () => host.db.open("ledger", { readonly: true }));

    expect(await asCaller(WATCHER, () => rows(reader))).toEqual([1]);
    await reader.close();
  });

  it("lets the view that drives create, migrate and write", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const host = makeHost();
    const db = await seedLedger(host);

    await asCaller(HOLDER, () => db.exec("INSERT INTO t VALUES (2)"));
    await asCaller(HOLDER, () => db.transaction((tx) => tx.run("INSERT INTO t VALUES (3)")));

    expect(await rows(db)).toEqual([1, 2, 3]);
    await db.close();
  });

  it("refuses every write a held handle makes in a watcher's call, and still reads", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const host = makeHost();
    const db = await seedLedger(host);

    for (const write of [
      () => db.run("INSERT INTO t VALUES (2)"),
      () => db.exec("INSERT INTO t VALUES (3)"),
      () => db.transaction((tx) => tx.run("INSERT INTO t VALUES (4)")),
      // A writable handle's query can write (`RETURNING`), so it is held too.
      () => db.query("INSERT INTO t VALUES (5) RETURNING x"),
      () => db.get("INSERT INTO t VALUES (6) RETURNING x"),
    ]) {
      await expect(asCaller(WATCHER, write)).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    }

    expect(await rows(db)).toEqual([1]);
    await db.close();
  });

  it("takes write authority away from a handle opened before another screen took control", async () => {
    const leases = new Map<string, ClientEndpoint>([["p1", WATCHER]]);
    installLeases(leases);
    const host = makeHost();
    const db = await asCaller(WATCHER, () =>
      host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] })
    );
    await asCaller(WATCHER, () => db.run("INSERT INTO t VALUES (1)"));

    leases.set("p1", HOLDER);

    await expect(asCaller(WATCHER, () => db.run("INSERT INTO t VALUES (2)"))).rejects.toMatchObject(
      { code: "DRIVEN_ELSEWHERE" }
    );
    expect(await rows(db)).toEqual([1]);
    await db.close();
  });

  it("holds a database in a nested project to that project's lease, not the bound one's", async () => {
    const nested = path.join(projectRoot, "vendor", "lib");
    owners.projectsForPath = (p) =>
      p.startsWith(nested + path.sep)
        ? ["p2"]
        : p === projectRoot || p.startsWith(projectRoot + path.sep)
          ? ["p1"]
          : [];
    installLeases(
      new Map([
        ["p1", WATCHER],
        ["p2", HOLDER],
      ])
    );
    const host = makeHost();

    await expect(
      asCaller(WATCHER, () => host.db.open("vendored", { migrations: ["CREATE TABLE t (x)"] }))
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    expect(fs.existsSync(nested)).toBe(false);
  });

  it("lets a watcher write the plugin's local database, which is in no project", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const host = makeHost();

    const cache = await asCaller(WATCHER, () =>
      host.db.open("cache", { migrations: ["CREATE TABLE t (x)"] })
    );
    await asCaller(WATCHER, () => cache.run("INSERT INTO t VALUES (7)"));

    expect(await rows(cache)).toEqual([7]);
    await cache.close();
  });

  it("leaves an agent's MCP tool call unchecked: it comes from no view", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const host = makeHost();
    const db = await seedLedger(host);
    await host.mcp.registerTools("data", {
      record: {
        description: "Records a value.",
        inputSchema: { type: "object" },
        execute: async () => (await db.run("INSERT INTO t VALUES (2)")).changes,
      },
    });
    const registration = agentMcpEndpointRegistry.get(INSTANCE, "data");
    const caller = { credentialId: "cred-1", projectId: PROJECT_ID, terminalId: "term-1" };

    await registration!.invoke("record", {}, caller, new AbortController().signal);

    expect(await rows(db)).toEqual([1, 2]);
    await db.close();
  });

  it("leaves background work, and a host with no lease service, unchecked", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const host = makeHost();
    const db = await host.db.open("ledger", { migrations: ["CREATE TABLE t (x)"] });
    await db.run("INSERT INTO t VALUES (1)");

    _resetDriveLeaseServiceForTesting(null);
    await asCaller(WATCHER, () => db.run("INSERT INTO t VALUES (2)"));

    expect(await rows(db)).toEqual([1, 2]);
    await db.close();
  });

  it("answers the worker's per-write check in the caller's own call", async () => {
    installLeases(new Map([["p1", HOLDER]]));
    const host = makeHost();
    await (await seedLedger(host)).close();

    await expect(
      asCaller(WATCHER, () => approvePluginDatabaseWrite(host.db, "ledger"))
    ).rejects.toMatchObject({ code: "DRIVEN_ELSEWHERE" });
    await expect(
      asCaller(HOLDER, () => approvePluginDatabaseWrite(host.db, "ledger"))
    ).resolves.toBeUndefined();
    await expect(
      asCaller(WATCHER, () => approvePluginDatabaseWrite(host.db, "cache"))
    ).resolves.toBeUndefined();
  });
});
