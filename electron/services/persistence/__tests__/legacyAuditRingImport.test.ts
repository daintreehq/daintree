import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    getAppPath: () => "/fake/appPath",
  },
}));

vi.mock("electron-store", async () => ({ default: (await import("conf")).default }));

const harness = vi.hoisted(() => ({
  db: null as import("better-sqlite3").Database | null,
  sidecarPath: "",
}));

vi.mock("../db.js", () => ({
  getSharedSqlite: () => harness.db,
  getSharedDb: () => {
    throw new Error("tests inject openSqlite");
  },
}));

vi.mock("../dbWorkerClient.js", () => ({
  runDbWork: (_op: unknown, fallback: () => unknown) => Promise.resolve(fallback()),
  fenceDbWorkerWrites: () => true,
  isDbWorkerFenceIntact: () => true,
}));

// Migrations 022/023 write the sidecar through electron-store; this stands in
// for it with the same file at the same path, so the importer reads what they wrote.
vi.mock("../../../store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../store.js")>();
  const nodeFs = await import("node:fs");
  const read = (): Record<string, unknown> => {
    try {
      return JSON.parse(nodeFs.readFileSync(harness.sidecarPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      return {};
    }
  };
  return {
    ...actual,
    auditLogsStore: {
      get path() {
        return harness.sidecarPath;
      },
      get: (key: string) => read()[key],
      set: (key: string, value: unknown) => {
        nodeFs.writeFileSync(harness.sidecarPath, JSON.stringify({ ...read(), [key]: value }));
      },
    },
  };
});

import { migration022 } from "../../migrations/022-audit-logs-store.js";
import { migration023 } from "../../migrations/023-audit-rings-to-audit-logs-store.js";
import { AuditService } from "../../mcp-server/auditLog.js";
import { TurnOutcomeService } from "../../mcp-server/turnOutcomeLog.js";
import { PluginActionAuditService } from "../../PluginActionAuditService.js";
import { ForgeAuditService } from "../../forge/auditLog.js";
import { RunHistoryLog } from "../../runHistory/runHistoryLog.js";
import { PluginMcpAuditService } from "../../plugin-mcp/PluginMcpAuditService.js";
import { AuditRingStore, type AuditRingName } from "../auditRingStore.js";
import {
  importLegacyAuditRings,
  LEGACY_AUDIT_IMPORT_RECEIPT_KEY,
  type LegacyAuditRingImportDeps,
} from "../legacyAuditRingImport.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../migrations");
const NOW = Date.UTC(2026, 9, 31, 12);

type Rec = Record<string, unknown> & { id: string };

// Records each owner's hydrate accepts, oldest first.
const fixtures = {
  mcpAuditLog: (id: string, t: number): Rec => ({
    id,
    timestamp: t,
    toolId: "actions.list",
    sessionId: "sess-1",
    tier: "action",
    argsSummary: "{}",
    result: "success",
    durationMs: 5,
  }),
  mcpTurnOutcomeLog: (id: string, t: number): Rec => ({
    id,
    timestamp: t,
    terminalId: "term-1",
    sessionId: "help-1",
    outcome: "answered",
  }),
  pluginAuditLog: (id: string, t: number): Rec => ({
    id,
    ts: t,
    pluginId: "acme",
    actionId: "acme.go",
  }),
  forgeAuditLog: (id: string, t: number): Rec => ({
    id,
    timestamp: t,
    providerId: "builtin.github",
    methodName: "listIssues",
    result: "success",
    durationMs: 12,
  }),
  runHistoryRecords: (id: string, t: number): Rec => ({
    id,
    kind: "recipe",
    timestamp: t,
    recipeName: "Build",
  }),
  pluginMcpAuditLog: (id: string, t: number): Rec => ({
    id,
    ts: t,
    pluginId: "acme",
    serverId: "main",
    toolName: "search",
    dangerTier: "read",
    tool_description_sha: "a".repeat(64),
    input_schema_sha: "b".repeat(64),
    arg_sha: "",
    durationMs: 3,
    result: "success",
    schemaVersion: 1,
  }),
} satisfies Record<AuditRingName, (id: string, t: number) => Rec>;

const RINGS = Object.keys(fixtures) as AuditRingName[];

// v0.18.x config.json: every ring still nested in its settings slice.
function preV019Config(): Record<string, unknown> {
  const two = (ring: AuditRingName) => [
    fixtures[ring](`${ring}-old`, 1000),
    fixtures[ring](`${ring}-new`, 2000),
  ];
  return {
    _schemaVersion: 21,
    mcpServer: {
      enabled: true,
      auditEnabled: true,
      auditMaxRecords: 500,
      auditLog: two("mcpAuditLog"),
      turnOutcomeLog: two("mcpTurnOutcomeLog"),
    },
    plugins: {
      disabled: [],
      auditEnabled: true,
      auditMaxRecords: 500,
      auditLog: two("pluginAuditLog"),
    },
    forgeAudit: { auditEnabled: true, auditMaxRecords: 500, auditLog: two("forgeAuditLog") },
    runHistory: { records: two("runHistoryRecords") },
    pluginMcpAudit: {
      auditEnabled: true,
      auditMaxRecords: 500,
      auditLog: two("pluginMcpAuditLog"),
    },
  };
}

function makeConfig(initial: Record<string, unknown>, storePath = "/fake/config.json") {
  const data: Record<string, unknown> = structuredClone(initial);
  return {
    data,
    path: storePath,
    get: (key: string) => structuredClone(data[key]),
    set: (key: string, value: unknown) => {
      data[key] = structuredClone(value);
    },
    restore(snapshot: Record<string, unknown>) {
      for (const key of Object.keys(data)) delete data[key];
      Object.assign(data, structuredClone(snapshot));
    },
  };
}

type FakeConfig = ReturnType<typeof makeConfig>;

function runMigrations(config: FakeConfig): void {
  const store = config as unknown as Parameters<typeof migration022.up>[0];
  void migration022.up(store);
  void migration023.up(store);
}

let tempDir: string;
let openSqlite: Mock<() => Database.Database | null>;

function deps(config: FakeConfig, overrides: Partial<LegacyAuditRingImportDeps> = {}) {
  return {
    config,
    sidecarPath: harness.sidecarPath,
    openSqlite,
    fence: () => true,
    now: () => NOW,
    ...overrides,
  } satisfies LegacyAuditRingImportDeps;
}

function ids(ring: AuditRingName): string[] {
  return new AuditRingStore().readAll<Rec>(ring).map((record) => record.id);
}

function insertRow(ring: AuditRingName, record: Rec, recordId: string | null = record.id): void {
  harness
    .db!.prepare(
      "INSERT INTO audit_rings (ring, record_id, record, created_at) VALUES (?, ?, ?, ?)"
    )
    .run(ring, recordId, JSON.stringify(record), 1);
}

function archives(): string[] {
  return fs.readdirSync(tempDir).filter((name) => name.startsWith("audit-logs.json.imported-"));
}

function receipt(): unknown {
  return harness
    .db!.prepare("SELECT value FROM app_state WHERE key = ?")
    .get(LEGACY_AUDIT_IMPORT_RECEIPT_KEY);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-legacy-audit-"));
  harness.sidecarPath = path.join(tempDir, "audit-logs.json");
  harness.db = new Database(path.join(tempDir, "daintree.db"));
  migrate(drizzle(harness.db), { migrationsFolder });
  openSqlite = vi.fn(() => harness.db);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  harness.db?.close();
  harness.db = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("importLegacyAuditRings — pre-v0.19 upgrade", () => {
  it("brings all six config.json rings through 022/023 into SQLite and the owners, in order", () => {
    const config = makeConfig(preV019Config());
    runMigrations(config);
    expect(fs.existsSync(harness.sidecarPath)).toBe(true);

    importLegacyAuditRings(deps(config));

    for (const ring of RINGS) {
      expect(ids(ring), ring).toEqual([`${ring}-old`, `${ring}-new`]);
    }

    // The owners read through the same adapters production wires up, and
    // present newest first.
    const ringStore = new AuditRingStore();
    const adapter = (ring: AuditRingName) => ({
      read: () => ringStore.readAll(ring),
      write: () => {},
    });
    const noConfig = () => ({});
    const newestFirst = (ring: AuditRingName) => [`${ring}-new`, `${ring}-old`];
    const byId = (records: { id: string }[]) => records.map((record) => record.id);

    expect(byId(new AuditService(() => {}, noConfig, adapter("mcpAuditLog")).getRecords())).toEqual(
      newestFirst("mcpAuditLog")
    );
    expect(
      byId(
        new TurnOutcomeService({
          saveConfig: () => {},
          readConfig: noConfig,
          getSessionIdForTerminal: () => null,
          getRecentAuditRecords: () => [],
          logStore: adapter("mcpTurnOutcomeLog"),
        }).getRecords()
      )
    ).toEqual(newestFirst("mcpTurnOutcomeLog"));
    expect(
      byId(new PluginActionAuditService(() => {}, noConfig, adapter("pluginAuditLog")).getRecords())
    ).toEqual(newestFirst("pluginAuditLog"));
    expect(
      byId(new ForgeAuditService(() => {}, noConfig, adapter("forgeAuditLog")).getRecords())
    ).toEqual(newestFirst("forgeAuditLog"));
    expect(
      byId(new RunHistoryLog(() => {}, adapter("runHistoryRecords").read).getRecords())
    ).toEqual(newestFirst("runHistoryRecords"));
    expect(
      byId(new PluginMcpAuditService(() => {}, noConfig, adapter("pluginMcpAuditLog")).getRecords())
    ).toEqual(newestFirst("pluginMcpAuditLog"));

    // Sources retired: config.json keeps its flags, the sidecar is archived.
    expect(config.data.mcpServer).toEqual({
      enabled: true,
      auditEnabled: true,
      auditMaxRecords: 500,
    });
    expect(config.data.runHistory).toEqual({});
    expect(fs.existsSync(harness.sidecarPath)).toBe(false);
    expect(archives()).toHaveLength(1);
  });

  it("imports rings the migrations left in config.json when the audit-logs store was not durable", () => {
    const config = makeConfig(preV019Config());
    const sidecarPath = harness.sidecarPath;
    harness.sidecarPath = "";
    runMigrations(config);
    harness.sidecarPath = sidecarPath;
    expect((config.data.plugins as Record<string, unknown>).auditLog).toHaveLength(2);

    importLegacyAuditRings(deps(config));

    for (const ring of RINGS) {
      expect(ids(ring), ring).toEqual([`${ring}-old`, `${ring}-new`]);
    }
    expect("auditLog" in (config.data.plugins as object)).toBe(false);
  });
});

describe("importLegacyAuditRings — merge", () => {
  it("puts legacy records ahead of existing rows, keeps SQLite's copy of a shared id, and drops repeats", () => {
    const ring = "runHistoryRecords";
    const make = fixtures[ring];
    insertRow(ring, { ...make("e1", 5000), recipeName: "sqlite copy" });
    insertRow(ring, make("e2", 6000));
    // A pre-keying row: no record_id, but its id still counts.
    insertRow(ring, make("e-unkeyed", 7000), null);

    const config = makeConfig({ runHistory: { records: [make("c1", 100), make("c2", 200)] } });
    fs.writeFileSync(
      harness.sidecarPath,
      JSON.stringify({
        // migration022 run twice on a restored config.json leaves repeats.
        [ring]: [
          make("c1", 100),
          make("s1", 300),
          make("s1", 300),
          { ...make("e1", 5000), recipeName: "legacy copy" },
          make("e-unkeyed", 7000),
          null,
          "garbage",
        ],
      })
    );

    importLegacyAuditRings(deps(config));

    expect(ids(ring)).toEqual(["c1", "c2", "s1", "e1", "e2", "e-unkeyed"]);
    const records = new AuditRingStore().readAll<Rec>(ring);
    expect(records.find((record) => record.id === "e1")?.recipeName).toBe("sqlite copy");
    // Legacy rows go in keyed; the pre-keying row keeps its NULL record_id.
    const unkeyed = harness
      .db!.prepare("SELECT COUNT(*) AS n FROM audit_rings WHERE ring = ? AND record_id IS NULL")
      .get(ring) as { n: number };
    expect(unkeyed.n).toBe(1);
  });

  it("dedupes records without an id by their content", () => {
    const ring = "pluginAuditLog";
    const noId = { ts: 1, pluginId: "acme", actionId: "acme.legacy" };
    insertRow(ring, noId as Rec, null);
    const config = makeConfig({
      plugins: { auditLog: [noId, { ...noId, ts: 2 }, { ...noId, ts: 2 }] },
    });

    importLegacyAuditRings(deps(config));

    const records = new AuditRingStore().readAll<{ ts: number }>(ring);
    expect(records.map((record) => record.ts)).toEqual([2, 1]);
  });

  it("trims to each owner's cap, giving up the oldest legacy records first", () => {
    const ring = "runHistoryRecords";
    const make = fixtures[ring];
    for (let i = 0; i < 98; i++) insertRow(ring, make(`e${i}`, 10_000 + i));
    const config = makeConfig({
      runHistory: { records: [make("l1", 1), make("l2", 2), make("l3", 3), make("l4", 4)] },
    });

    importLegacyAuditRings(deps(config));

    const result = ids(ring);
    expect(result).toHaveLength(100);
    expect(result.slice(0, 3)).toEqual(["l3", "l4", "e0"]);
    expect(result.at(-1)).toBe("e97");
  });

  it("leaves a full ring untouched", () => {
    const ring = "pluginMcpAuditLog";
    const make = fixtures[ring];
    for (let i = 0; i < 500; i++) insertRow(ring, make(`e${i}`, 10_000 + i));
    const before = ids(ring);
    const config = makeConfig({ pluginMcpAudit: { auditLog: [make("legacy", 1)] } });

    importLegacyAuditRings(deps(config));

    expect(ids(ring)).toEqual(before);
    expect("auditLog" in (config.data.pluginMcpAudit as object)).toBe(false);
  });
});

describe("importLegacyAuditRings — retries", () => {
  it("imports each record once when config.json and audit-logs.json come back after the import", () => {
    const original = preV019Config();
    const config = makeConfig(original);
    runMigrations(config);
    const sidecarBytes = fs.readFileSync(harness.sidecarPath);

    importLegacyAuditRings(deps(config));
    // A crash before cleanup, a restored config.json backup, a sidecar put back.
    config.restore(original);
    fs.writeFileSync(harness.sidecarPath, sidecarBytes);
    importLegacyAuditRings(deps(config));
    // The restored config.json goes through the migration chain again too.
    config.restore(original);
    runMigrations(config);
    importLegacyAuditRings(deps(config));

    for (const ring of RINGS) {
      expect(ids(ring), ring).toEqual([`${ring}-old`, `${ring}-new`]);
    }
  });

  it("does not bring back records the user cleared after the import", () => {
    const original = preV019Config();
    const config = makeConfig(original);
    importLegacyAuditRings(deps(config));
    expect(ids("forgeAuditLog")).toEqual(["forgeAuditLog-old", "forgeAuditLog-new"]);

    // The forge audit "Clear" flushes an empty ring synchronously.
    new AuditRingStore().writeAll("forgeAuditLog", [], 500, { sync: true });
    config.restore(original);
    importLegacyAuditRings(deps(config));

    expect(ids("forgeAuditLog")).toEqual([]);
    expect(ids("runHistoryRecords")).toEqual(["runHistoryRecords-old", "runHistoryRecords-new"]);
  });

  it("rolls every ring and the receipt back when the transaction fails, leaving the sources", () => {
    const original = preV019Config();
    const config = makeConfig(original);
    runMigrations(config);
    const sidecarBytes = fs.readFileSync(harness.sidecarPath);
    config.restore(original);
    harness.db!.exec(`
      CREATE TRIGGER fail_plugin_mcp BEFORE INSERT ON audit_rings
      WHEN NEW.ring = 'pluginMcpAuditLog'
      BEGIN SELECT RAISE(ABORT, 'disk full'); END;
    `);

    importLegacyAuditRings(deps(config));

    for (const ring of RINGS) expect(ids(ring), ring).toEqual([]);
    expect(receipt()).toBeUndefined();
    expect(config.data).toEqual(original);
    expect(fs.readFileSync(harness.sidecarPath)).toEqual(sidecarBytes);

    harness.db!.exec("DROP TRIGGER fail_plugin_mcp");
    importLegacyAuditRings(deps(config));

    for (const ring of RINGS) {
      expect(ids(ring), ring).toEqual([`${ring}-old`, `${ring}-new`]);
    }
  });
});

describe("importLegacyAuditRings — unreadable sources", () => {
  it.each([
    ["invalid JSON", '{"mcpAuditLog": [{"id": "a"'],
    ["a JSON array", "[1, 2, 3]"],
    ["JSON null", "null"],
  ])("leaves an audit-logs.json holding %s byte-for-byte on disk", (_label, contents) => {
    fs.writeFileSync(harness.sidecarPath, contents);
    const config = makeConfig({ runHistory: { records: [fixtures.runHistoryRecords("c1", 1)] } });

    importLegacyAuditRings(deps(config));

    expect(fs.readFileSync(harness.sidecarPath, "utf8")).toBe(contents);
    expect(archives()).toEqual([]);
    // The readable source still comes across.
    expect(ids("runHistoryRecords")).toEqual(["c1"]);
    expect(config.data.runHistory).toEqual({});
  });

  it("archives a readable sidecar with a malformed ring, keeping its bytes", () => {
    const contents = JSON.stringify({
      forgeAuditLog: "not a ring",
      runHistoryRecords: [fixtures.runHistoryRecords("s1", 1)],
    });
    fs.writeFileSync(harness.sidecarPath, contents);

    importLegacyAuditRings(deps(makeConfig({})));

    expect(ids("runHistoryRecords")).toEqual(["s1"]);
    expect(archives()).toHaveLength(1);
    expect(fs.readFileSync(path.join(tempDir, archives()[0]!), "utf8")).toBe(contents);
  });

  it("leaves a malformed config.json ring where it is", () => {
    const config = makeConfig({ runHistory: { records: "garbage" } });

    importLegacyAuditRings(deps(config));

    expect(config.data.runHistory).toEqual({ records: "garbage" });
    expect(openSqlite).not.toHaveBeenCalled();
  });

  it("keeps every source when the database cannot open", () => {
    const original = preV019Config();
    const config = makeConfig(original);
    fs.writeFileSync(harness.sidecarPath, JSON.stringify({ forgeAuditLog: [] }));

    importLegacyAuditRings(
      deps(config, {
        openSqlite: () => {
          throw new Error("Cannot open database: disk space is critical");
        },
      })
    );

    expect(config.data).toEqual(original);
    expect(fs.existsSync(harness.sidecarPath)).toBe(true);
  });

  it("keeps every source when a ring's worker writes cannot be fenced", () => {
    const original = preV019Config();
    const config = makeConfig(original);

    importLegacyAuditRings(deps(config, { fence: (ring) => ring !== "forgeAuditLog" }));

    for (const ring of RINGS) expect(ids(ring), ring).toEqual([]);
    expect(config.data).toEqual(original);
  });
});

describe("importLegacyAuditRings — nothing to import", () => {
  it("retires empty sources without opening the database", () => {
    const config = makeConfig({ mcpServer: { enabled: true, auditLog: [], turnOutcomeLog: [] } });
    fs.writeFileSync(
      harness.sidecarPath,
      JSON.stringify({ mcpAuditLog: [], runHistoryRecords: [] })
    );

    importLegacyAuditRings(deps(config));

    expect(openSqlite).not.toHaveBeenCalled();
    expect(config.data.mcpServer).toEqual({ enabled: true });
    expect(fs.existsSync(harness.sidecarPath)).toBe(false);
    expect(archives()).toHaveLength(1);
  });

  it("does nothing while the config store is in memory", () => {
    const original = preV019Config();
    const config = makeConfig(original, "");
    fs.writeFileSync(harness.sidecarPath, JSON.stringify({ mcpAuditLog: [] }));

    importLegacyAuditRings(deps(config));

    expect(openSqlite).not.toHaveBeenCalled();
    expect(config.data).toEqual(original);
    expect(fs.existsSync(harness.sidecarPath)).toBe(true);
  });
});
