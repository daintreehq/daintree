import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("../db.js", () => ({
  getSharedSqlite: () => harness.db,
}));

// Stand-in for the DB worker: runs the op on the same database with the shared
// executors and resolves the applied flag, as the real worker does.
vi.mock("../dbWorkerClient.js", () => ({
  runDbWork: (op: DbWorkerOp) => Promise.resolve(workerExecutes(op)),
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

function persistedCount(ring: string): number {
  const row = harness
    .db!.prepare("SELECT COUNT(*) AS n FROM audit_rings WHERE ring = ?")
    .get(ring) as { n: number };
  return row.n;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** The common surface every owner exposes, adapted per owner below. */
interface RingOwner {
  append(n: number): void;
  setMaxRecords(max: number): void;
  /** The debounced (background) flush the append path schedules. */
  flushDebounced(): Promise<void>;
  flushNow(): void;
  ids(): string[];
  dispose(): void;
}

interface OwnerCase {
  name: string;
  ring: string;
  configKey: string;
  defaultMax: number;
  boot(): Promise<RingOwner>;
}

/** Record ids oldest first, from an owner's newest-first view. */
function oldestFirst(records: { id: string }[]): string[] {
  return records.map((r) => r.id).reverse();
}

const OWNERS: OwnerCase[] = [
  {
    name: "plugin action audit",
    ring: "pluginAuditLog",
    configKey: "plugins",
    defaultMax: 500,
    async boot() {
      const mod = await import("../../PluginActionAuditService.js");
      const svc = mod.getPluginActionAuditService();
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
        flushDebounced: async () => {
          await vi.advanceTimersByTimeAsync(5_000);
          await settle();
        },
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getRecords()),
        dispose: () => mod._resetPluginActionAuditServiceForTest(),
      };
    },
  },
  {
    name: "MCP audit",
    ring: "mcpAuditLog",
    configKey: "mcpServer",
    defaultMax: 500,
    async boot() {
      const { AuditService } = await import("../../mcp-server/auditLog.js");
      const svc = new AuditService(
        (patch) => {
          harness.config.mcpServer = { ...(harness.config.mcpServer as object), ...patch };
        },
        () => harness.config.mcpServer as Record<string, unknown>
      );
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
        flushDebounced: async () => {
          await vi.advanceTimersByTimeAsync(5_000);
          await settle();
        },
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getLogRecords()),
        dispose: () => svc.flushNow(),
      };
    },
  },
  {
    name: "MCP turn outcome",
    ring: "mcpTurnOutcomeLog",
    configKey: "mcpServer",
    defaultMax: 500,
    async boot() {
      const { TurnOutcomeService } = await import("../../mcp-server/turnOutcomeLog.js");
      const { AuditService } = await import("../../mcp-server/auditLog.js");
      const saveConfig = (patch: Record<string, unknown>) => {
        harness.config.mcpServer = { ...(harness.config.mcpServer as object), ...patch };
      };
      const readConfig = () => harness.config.mcpServer as Record<string, unknown>;
      // The turn ring shares the MCP audit setting, which the dispatch log's
      // setter saves; McpServerService.setAuditMaxRecords applies it to both.
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
        setMaxRecords: (max) => svc.setMaxRecords(settings.setMaxRecords(max).maxRecords),
        flushDebounced: async () => {
          await vi.advanceTimersByTimeAsync(5_000);
          await settle();
        },
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getRecords()),
        dispose: () => svc.flushNow(),
      };
    },
  },
  {
    name: "forge audit",
    ring: "forgeAuditLog",
    configKey: "forgeAudit",
    defaultMax: 500,
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
        flushDebounced: async () => {
          await vi.advanceTimersByTimeAsync(5_000);
          await settle();
        },
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getRecords()),
        dispose: () => svc.flushNow(),
      };
    },
  },
  {
    name: "plugin MCP audit",
    ring: "pluginMcpAuditLog",
    configKey: "pluginMcpAudit",
    defaultMax: 500,
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
        flushDebounced: async () => {
          await vi.advanceTimersByTimeAsync(5_000);
          await settle();
        },
        flushNow: () => svc.flushNow(),
        ids: () => oldestFirst(svc.getRecords()),
        dispose: () => svc.flushNow(),
      };
    },
  },
];

describe.each(OWNERS)("$name ring keeps the configured history length", (owner) => {
  let current: RingOwner | null = null;

  async function boot(): Promise<RingOwner> {
    current?.dispose();
    vi.resetModules();
    current = await owner.boot();
    return current;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    harness.db = new Database(":memory:");
    createSchema(harness.db);
    harness.config = {
      [owner.configKey]: { auditEnabled: true, auditMaxRecords: owner.defaultMax },
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    current?.dispose();
    current = null;
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
    await svc.flushDebounced();
    expect(persistedCount(owner.ring)).toBe(collected);

    svc = await boot();
    expect(svc.ids()).toEqual(before);

    // A fresh ring store knows nothing of the rows, so this is a full replacement.
    svc.append(1);
    await svc.flushDebounced();
    expect(persistedCount(owner.ring)).toBe(collected + 1);
  });

  it("trims storage as soon as the limit is lowered, and a later raise keeps it trimmed", async () => {
    const raised = owner.defaultMax * 2;
    const lowered = owner.defaultMax + 100;

    let svc = await boot();
    svc.setMaxRecords(raised);
    svc.append(owner.defaultMax + 200);
    const all = svc.ids();
    svc.flushNow();

    // Lowered before this boot's ring has been read or written.
    svc = await boot();
    svc.setMaxRecords(lowered);
    const kept = svc.ids();
    expect(kept).toEqual(all.slice(-lowered));
    expect(persistedCount(owner.ring)).toBe(lowered);

    svc.setMaxRecords(raised);
    svc = await boot();
    expect(svc.ids()).toEqual(kept);
  });

  it("keeps a raised history through a synchronous flush on teardown", async () => {
    const raised = owner.defaultMax * 2;
    const collected = owner.defaultMax + 200;

    let svc = await boot();
    svc.setMaxRecords(raised);
    svc.append(collected);
    const before = svc.ids();
    svc.flushNow();
    expect(persistedCount(owner.ring)).toBe(collected);

    svc = await boot();
    expect(svc.ids()).toEqual(before);
  });
});
