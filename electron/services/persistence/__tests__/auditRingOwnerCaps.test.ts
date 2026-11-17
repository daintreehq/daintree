import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FORGE_AUDIT_DEFAULT_MAX_RECORDS,
  FORGE_AUDIT_MAX_RECORDS,
} from "../../../../shared/types/ipc/forge.js";
import {
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
} from "../../../../shared/types/ipc/mcpServer.js";
import {
  PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
  PLUGIN_AUDIT_MAX_RECORDS,
} from "../../../../shared/types/ipc/pluginAudit.js";
import {
  PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS,
  PLUGIN_MCP_AUDIT_MAX_RECORDS,
} from "../../../../shared/types/ipc/pluginMcpAudit.js";
import { applyRingDelta, prepareRingStatements, replaceRing } from "../auditRingSql.js";
import type { DbWorkerOp } from "../dbWorkerProtocol.js";

// Each configurable audit ring, driven through its owner's production wiring
// (default log store adapter, real AuditRingStore, real audit_rings schema).
// Every "boot" re-imports the owner after vi.resetModules(), so the ring
// store's in-memory acknowledged state is gone exactly as after a relaunch and
// only what reached SQLite survives.

vi.mock("electron", () => ({
  app: {
    getPath: () => "/fake/userData",
    getAppPath: () => "/fake/appPath",
  },
}));

const harness = vi.hoisted(() => ({
  db: null as import("better-sqlite3").Database | null,
  config: {} as Record<string, unknown>,
  // Background writes wait here until drainWorker() runs them, so a write the
  // test sees land at once must have gone through the synchronous path.
  worker: [] as Array<() => void>,
}));

vi.mock("../db.js", () => ({
  getSharedSqlite: () => harness.db,
}));

// Stand-in for the DB worker: runs the op on the same database with the shared
// executors and resolves the applied flag, as the real worker does.
vi.mock("../dbWorkerClient.js", () => ({
  runDbWork: (op: DbWorkerOp) =>
    new Promise((resolve) => {
      harness.worker.push(() => resolve(workerExecutes(op)));
    }),
  fenceDbWorkerWrites: () => true,
  isDbWorkerFenceIntact: () => true,
}));

vi.mock("../../../store.js", () => ({
  store: {
    get: (key: string) => harness.config[key],
    set: (key: string, value: unknown) => {
      harness.config[key] = value;
    },
  },
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(__dirname, "../migrations");

function createSchema(db: Database.Database): void {
  for (const file of ["0004_audit_rings.sql", "0018_audit_ring_record_ids.sql"]) {
    for (const statement of fs
      .readFileSync(path.join(migrationsFolder, file), "utf8")
      .split("--> statement-breakpoint")) {
      db.exec(statement);
    }
  }
}

function workerExecutes(op: DbWorkerOp): boolean {
  const db = harness.db!;
  const stmts = prepareRingStatements(db);
  if (op.op === "ringWriteAll") return replaceRing(db, stmts, op.ring, op.rows, op.maxRecords);
  if (op.op === "ringApply") return applyRingDelta(db, stmts, op.ring, op.upserts, op.deletes);
  throw new Error(`unexpected op ${op.op}`);
}

/** Record ids in SQLite, in ring order. */
function persistedIds(ring: string): string[] {
  const rows = harness
    .db!.prepare("SELECT record FROM audit_rings WHERE ring = ? ORDER BY id ASC")
    .all(ring) as { record: string }[];
  return rows.map((row) => (JSON.parse(row.record) as { id: string }).id);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

async function drainWorker(): Promise<void> {
  await settle();
  while (harness.worker.length > 0) {
    harness.worker.shift()!();
    await settle();
  }
}

/** Fire the debounce timer an append scheduled, then let the background write land. */
async function flushDebounced(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000);
  await drainWorker();
}

/** The common surface every owner exposes, adapted per owner below. */
interface RingOwner {
  append(n: number): void;
  setMaxRecords(max: number): void;
  flushNow(): void;
  /** In-memory record ids, oldest first. */
  ids(): string[];
}

interface OwnerCase {
  name: string;
  ring: string;
  configKey: string;
  defaultMax: number;
  ceiling: number;
  boot(): Promise<RingOwner>;
}

function oldestFirst(records: { id: string }[]): string[] {
  return records.map((r) => r.id).reverse();
}

function mcpConfig() {
  return {
    saveConfig: (patch: Record<string, unknown>) => {
      harness.config.mcpServer = { ...(harness.config.mcpServer as object), ...patch };
    },
    readConfig: () => harness.config.mcpServer as Record<string, unknown>,
  };
}

const OWNERS: OwnerCase[] = [
  {
    name: "plugin action audit",
    ring: "pluginAuditLog",
    configKey: "plugins",
    defaultMax: PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
    ceiling: PLUGIN_AUDIT_MAX_RECORDS,
    async boot() {
      const { getPluginActionAuditService } = await import("../../PluginActionAuditService.js");
      const svc = getPluginActionAuditService();
      return {
        append: (n) => {
          for (let i = 0; i < n; i++) {
            svc.append({
              pluginId: "acme",
              actionId: "acme.run",
              argsHash: "",
              durationMs: 1,
              result: "success",
            });
          }
        },
        setMaxRecords: (max) => void svc.setMaxRecords(max),
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getRecords()),
      };
    },
  },
  {
    name: "MCP audit",
    ring: "mcpAuditLog",
    configKey: "mcpServer",
    defaultMax: MCP_AUDIT_DEFAULT_MAX_RECORDS,
    ceiling: MCP_AUDIT_MAX_RECORDS,
    async boot() {
      const { AuditService } = await import("../../mcp-server/auditLog.js");
      const { saveConfig, readConfig } = mcpConfig();
      const svc = new AuditService(saveConfig, readConfig);
      return {
        append: (n) => {
          for (let i = 0; i < n; i++) {
            svc.appendRecord({
              toolId: "actions.search",
              sessionId: "s",
              tier: "core",
              args: {},
              durationMs: 1,
              outcome: { kind: "result", value: { ok: true, result: null } },
              argsSummary: "{}",
            });
          }
        },
        setMaxRecords: (max) => void svc.setMaxRecords(max),
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getLogRecords()),
      };
    },
  },
  {
    name: "MCP turn outcome",
    ring: "mcpTurnOutcomeLog",
    configKey: "mcpServer",
    defaultMax: MCP_AUDIT_DEFAULT_MAX_RECORDS,
    ceiling: MCP_AUDIT_MAX_RECORDS,
    async boot() {
      const { TurnOutcomeService } = await import("../../mcp-server/turnOutcomeLog.js");
      const { AuditService } = await import("../../mcp-server/auditLog.js");
      const { saveConfig, readConfig } = mcpConfig();
      // The turn ring shares the MCP audit setting, which the dispatch log's
      // setter saves.
      const settings = new AuditService(saveConfig, readConfig, {
        read: () => [],
        write: () => {},
      });
      const svc = new TurnOutcomeService({
        saveConfig,
        readConfig,
        getSessionIdForTerminal: () => null,
        getRecentAuditRecords: () => [],
      });
      return {
        append: (n) => {
          for (let i = 0; i < n; i++) svc.recordDirectOutcome({ outcome: "mcp-not-ready" });
        },
        // As McpServerService.setAuditMaxRecords applies it.
        setMaxRecords: (max) => {
          svc.hydrate();
          svc.setMaxRecords(settings.setMaxRecords(max).maxRecords);
        },
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getRecords()),
      };
    },
  },
  {
    name: "forge audit",
    ring: "forgeAuditLog",
    configKey: "forgeAudit",
    defaultMax: FORGE_AUDIT_DEFAULT_MAX_RECORDS,
    ceiling: FORGE_AUDIT_MAX_RECORDS,
    async boot() {
      const { forgeAuditService: svc } = await import("../../forge/forgeAuditService.js");
      return {
        append: (n) => {
          for (let i = 0; i < n; i++) {
            svc.appendRecord({
              providerId: "github",
              methodName: "listIssues",
              result: "success",
              durationMs: 1,
            });
          }
        },
        setMaxRecords: (max) => void svc.setMaxRecords(max),
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getRecords()),
      };
    },
  },
  {
    name: "plugin MCP audit",
    ring: "pluginMcpAuditLog",
    configKey: "pluginMcpAudit",
    defaultMax: PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS,
    ceiling: PLUGIN_MCP_AUDIT_MAX_RECORDS,
    async boot() {
      const { getPluginMcpAuditService } = await import("../../plugin-mcp/instances.js");
      const svc = getPluginMcpAuditService();
      return {
        append: (n) => {
          for (let i = 0; i < n; i++) {
            svc.append({
              pluginId: "acme",
              serverId: "main",
              toolName: "do_thing",
              dangerTier: "D1",
              descriptionRaw: "d",
              inputSchema: null,
              rawArgs: undefined,
              durationMs: 1,
              result: "success",
            });
          }
        },
        setMaxRecords: (max) => void svc.setMaxRecords(max),
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getRecords()),
      };
    },
  },
];

describe.each(OWNERS)("$name ring keeps the configured history length", (owner) => {
  let current: RingOwner | null = null;

  // A relaunch: the outgoing owner's shutdown flush, then fresh modules.
  async function boot(): Promise<RingOwner> {
    current?.flushNow();
    vi.resetModules();
    current = await owner.boot();
    return current;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    harness.db = new Database(":memory:");
    createSchema(harness.db);
    harness.worker = [];
    harness.config = {
      [owner.configKey]: { auditEnabled: true, auditMaxRecords: owner.defaultMax },
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    current = null;
    harness.worker = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    harness.db?.close();
    harness.db = null;
  });

  it("keeps a raised history across a debounced flush and a restart", async () => {
    const raised = owner.defaultMax * 2;
    const collected = owner.defaultMax + 200;

    let svc = await boot();
    svc.setMaxRecords(raised);
    svc.append(collected);
    const before = svc.ids();
    expect(before).toHaveLength(collected);
    // The setter's synchronous write left an acknowledged empty ring, so this
    // goes out as a keyed delta.
    await flushDebounced();
    expect(persistedIds(owner.ring)).toEqual(before);

    svc = await boot();
    expect(svc.ids()).toEqual(before);

    // A fresh ring store knows nothing of the rows, so this is a full replacement.
    svc.append(1);
    const after = svc.ids();
    await flushDebounced();
    expect(persistedIds(owner.ring)).toEqual(after);
    expect(after.slice(0, -1)).toEqual(before);
  });

  it("trims storage as soon as the limit is lowered, and a later raise keeps it trimmed", async () => {
    const raised = owner.defaultMax * 2;
    const lowered = owner.defaultMax + 100;

    let svc = await boot();
    svc.setMaxRecords(raised);
    svc.append(owner.defaultMax + 200);
    const all = svc.ids();
    expect(all).toHaveLength(owner.defaultMax + 200);

    // Lowered before this boot's ring has been read or written.
    svc = await boot();
    svc.setMaxRecords(lowered);
    const kept = all.slice(-lowered);
    expect(svc.ids()).toEqual(kept);
    expect(persistedIds(owner.ring)).toEqual(kept);

    svc.setMaxRecords(raised);
    svc = await boot();
    expect(svc.ids()).toEqual(kept);
    expect(persistedIds(owner.ring)).toEqual(kept);
  });

  it("keeps a full ring at the highest limit through a synchronous flush and a restart", async () => {
    let svc = await boot();
    svc.setMaxRecords(owner.ceiling);
    svc.append(owner.ceiling + 1);
    const kept = svc.ids();
    expect(kept).toHaveLength(owner.ceiling);

    svc.flushNow();
    expect(persistedIds(owner.ring)).toEqual(kept);

    svc = await boot();
    expect(svc.ids()).toEqual(kept);
  });
});
