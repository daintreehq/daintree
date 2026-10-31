import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { FORGE_AUDIT_DEFAULT_MAX_RECORDS } from "../../../shared/types/ipc/forge.js";
import { MCP_AUDIT_DEFAULT_MAX_RECORDS } from "../../../shared/types/ipc/mcpServer.js";
import { PLUGIN_AUDIT_DEFAULT_MAX_RECORDS } from "../../../shared/types/ipc/pluginAudit.js";
import { PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS } from "../../../shared/types/ipc/pluginMcpAudit.js";
import { RUN_HISTORY_DEFAULT_MAX_RECORDS } from "../../../shared/types/ipc/runHistory.js";
import {
  LEGACY_CONFIG_AUDIT_RINGS,
  readAuditLogsFile,
  resolveAuditLogsPath,
  store,
} from "../../store.js";
import { prepareRingStatements } from "./auditRingSql.js";
import type { AuditRingName } from "./auditRingStore.js";
import { getSharedDb, getSharedSqlite } from "./db.js";
import { fenceDbWorkerWrites } from "./dbWorkerClient.js";

/**
 * Brings audit rings written before the SQLite move into `audit_rings` (#15615).
 *
 * Up to v0.18 the six rings lived in config.json; migrations 022/023 moved
 * them into audit-logs.json, which no shipped build ever read back, and left
 * them in config.json wherever that store was not durable. Runs once per boot,
 * after the store migrations and before any ring owner hydrates: an owner's
 * first write is a full replacement of what it hydrated, so records arriving
 * later would be overwritten.
 *
 * Legacy records are older than anything already in SQLite, so they go in
 * front (config.json first, then audit-logs.json), trimmed to the owner's cap.
 * Every legacy record consumed — kept, duplicate, or over the cap — is written
 * to a receipt in the same transaction, so a source that survives the commit
 * (a crash before cleanup, a restored config.json) never imports a record
 * twice or brings back one the user has since cleared.
 */

/** The caps the ring owners pass to `AuditRingStore.writeAll`. */
const RING_CAPS: Record<AuditRingName, number> = {
  mcpAuditLog: MCP_AUDIT_DEFAULT_MAX_RECORDS,
  mcpTurnOutcomeLog: MCP_AUDIT_DEFAULT_MAX_RECORDS,
  pluginAuditLog: PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
  forgeAuditLog: FORGE_AUDIT_DEFAULT_MAX_RECORDS,
  runHistoryRecords: RUN_HISTORY_DEFAULT_MAX_RECORDS,
  pluginMcpAuditLog: PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS,
};

export const LEGACY_AUDIT_IMPORT_RECEIPT_KEY = "legacyAuditRingImport";

export interface LegacyAuditRingImportDeps {
  config: {
    readonly path: string;
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  sidecarPath: string | null;
  /** Opens the shared database; throws or returns null when it can't. */
  openSqlite(): Database.Database | null;
  fence(ring: string): boolean;
  now(): number;
}

export interface ExistingRingRow {
  record_id: string | null;
  record: string;
  created_at: number;
}

export interface LegacyRingMerge {
  /** Legacy rows to insert ahead of the existing rows, oldest first. */
  legacyRows: { recordId: string | null; record: string }[];
  duplicates: number;
  invalid: number;
}

function defaultDeps(): LegacyAuditRingImportDeps {
  return {
    config: store as unknown as LegacyAuditRingImportDeps["config"],
    sidecarPath: resolveAuditLogsPath(),
    openSqlite: () => {
      getSharedDb();
      return getSharedSqlite();
    },
    fence: fenceDbWorkerWrites,
    now: Date.now,
  };
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function identityOf(record: Record<string, unknown>, serialized: string): string {
  const id = record.id;
  return typeof id === "string" && id.length > 0 ? `id:${id}` : `json:${serialized}`;
}

function existingIdentity(row: ExistingRingRow): string {
  if (row.record_id !== null) return `id:${row.record_id}`;
  try {
    const parsed: unknown = JSON.parse(row.record);
    if (isRecordObject(parsed)) return identityOf(parsed, row.record);
  } catch {
    // An unparseable row can only match itself.
  }
  return `json:${row.record}`;
}

function receiptEntry(ring: AuditRingName, identity: string): string {
  return createHash("sha256").update(`${ring}\0${identity}`).digest("hex").slice(0, 32);
}

/**
 * Pick the legacy records to put in front of a ring's existing rows. A record
 * already in the ring (by id, or by content when it has none), already
 * consumed by an earlier import, or repeated earlier in `legacy` is skipped.
 * Adds every valid legacy record to `consumed`.
 */
export function mergeLegacyRing(
  ring: AuditRingName,
  legacy: readonly unknown[],
  existing: readonly ExistingRingRow[],
  consumed: Set<string>
): LegacyRingMerge {
  const present = new Set(existing.map(existingIdentity));
  const legacyRows: LegacyRingMerge["legacyRows"] = [];
  let duplicates = 0;
  let invalid = 0;
  for (const record of legacy) {
    if (!isRecordObject(record)) {
      invalid++;
      continue;
    }
    const serialized = JSON.stringify(record);
    const identity = identityOf(record, serialized);
    const entry = receiptEntry(ring, identity);
    if (consumed.has(entry) || present.has(identity)) {
      consumed.add(entry);
      duplicates++;
      continue;
    }
    consumed.add(entry);
    legacyRows.push({ recordId: identity.startsWith("id:") ? identity.slice(3) : null, record: serialized });
  }
  return { legacyRows, duplicates, invalid };
}

function readReceipt(sqlite: Database.Database): Set<string> {
  const row = sqlite
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get(LEGACY_AUDIT_IMPORT_RECEIPT_KEY) as { value: string } | undefined;
  if (!row) return new Set();
  try {
    const parsed = JSON.parse(row.value) as { consumed?: unknown };
    if (Array.isArray(parsed.consumed)) {
      return new Set(parsed.consumed.filter((e): e is string => typeof e === "string"));
    }
  } catch {
    // Fall through: the existing-row check still keeps records from doubling.
  }
  console.warn("[LegacyAuditRingImport] Ignoring an unreadable import receipt");
  return new Set();
}

function commitLegacyRings(
  sqlite: Database.Database,
  legacy: Map<AuditRingName, unknown[]>,
  now: number
): void {
  const stmts = prepareRingStatements(sqlite);
  const selectRows = sqlite.prepare(
    "SELECT record_id, record, created_at FROM audit_rings WHERE ring = ? ORDER BY id ASC"
  );
  const writeReceipt = sqlite.prepare(
    "INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  const summaries: string[] = [];
  sqlite
    .transaction(() => {
      const consumed = readReceipt(sqlite);
      for (const [ring, records] of legacy) {
        const existing = selectRows.all(ring) as ExistingRingRow[];
        const { legacyRows, duplicates, invalid } = mergeLegacyRing(
          ring,
          records,
          existing,
          consumed
        );
        const cap = RING_CAPS[ring];
        const overCap = Math.max(0, Math.min(legacyRows.length, legacyRows.length + existing.length - cap));
        if (legacyRows.length > 0) {
          stmts.clear.run(ring);
          for (const row of legacyRows) stmts.insert.run(ring, row.recordId, row.record, now);
          for (const row of existing) {
            stmts.insert.run(ring, row.record_id, row.record, row.created_at);
          }
          stmts.trim.run(ring, ring, cap);
        }
        summaries.push(
          `${ring}: ${legacyRows.length - overCap} imported, ${duplicates} already present, ` +
            `${overCap} over the ${cap}-record cap, ${invalid} invalid`
        );
      }
      writeReceipt.run(
        LEGACY_AUDIT_IMPORT_RECEIPT_KEY,
        JSON.stringify({ version: 1, consumed: [...consumed] })
      );
    })
    .immediate();
  for (const summary of summaries) console.log(`[LegacyAuditRingImport] ${summary}`);
}

function archiveName(sidecarPath: string, now: number): string {
  return `${sidecarPath}.imported-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
}

export function importLegacyAuditRings(
  deps: LegacyAuditRingImportDeps = defaultDeps()
): void {
  // An in-memory config store holds none of the disk's rings, and stripping
  // its keys would prove nothing; a durable boot retries.
  if (deps.config.path === "") return;

  const legacy = new Map<AuditRingName, unknown[]>();
  const append = (ring: AuditRingName, records: unknown[]): void => {
    legacy.set(ring, [...(legacy.get(ring) ?? []), ...records]);
  };

  const configSources: (typeof LEGACY_CONFIG_AUDIT_RINGS)[number][] = [];
  for (const source of LEGACY_CONFIG_AUDIT_RINGS) {
    const parent = deps.config.get(source.parentKey);
    if (!isRecordObject(parent) || !(source.field in parent)) continue;
    const value = parent[source.field];
    if (!Array.isArray(value)) {
      console.warn(
        `[LegacyAuditRingImport] Leaving malformed ${source.parentKey}.${source.field} in config.json`
      );
      continue;
    }
    configSources.push(source);
    append(source.ring, value);
  }

  let sidecarImported = false;
  if (deps.sidecarPath) {
    const read = readAuditLogsFile(deps.sidecarPath);
    if (read.status === "unreadable") {
      console.warn(
        `[LegacyAuditRingImport] Leaving unreadable audit-logs.json in place (${read.reason})`
      );
    } else if (read.status === "ok") {
      sidecarImported = true;
      for (const { ring } of LEGACY_CONFIG_AUDIT_RINGS) {
        if (!(ring in read.data)) continue;
        const value = read.data[ring];
        if (Array.isArray(value)) {
          append(ring, value);
        } else {
          console.warn(
            `[LegacyAuditRingImport] Skipping malformed "${ring}" in audit-logs.json; the archived file keeps it`
          );
        }
      }
    }
  }

  const pending = new Map([...legacy].filter(([, records]) => records.length > 0));
  if (pending.size > 0) {
    let sqlite: Database.Database | null;
    try {
      sqlite = deps.openSqlite();
    } catch (error) {
      console.warn("[LegacyAuditRingImport] Database unavailable; retrying next boot:", error);
      return;
    }
    if (!sqlite) {
      console.warn("[LegacyAuditRingImport] Database unavailable; retrying next boot");
      return;
    }
    for (const ring of pending.keys()) {
      if (!deps.fence(ring)) {
        console.warn(`[LegacyAuditRingImport] Could not fence "${ring}" writes; retrying next boot`);
        return;
      }
    }
    try {
      commitLegacyRings(sqlite, pending, deps.now());
    } catch (error) {
      console.warn("[LegacyAuditRingImport] Import failed; sources left in place:", error);
      return;
    }
  }

  // Cleanup after the commit. A failure here only leaves a source the receipt
  // already covers, so the next boot finds nothing new in it.
  const parents = new Set(configSources.map((source) => source.parentKey));
  for (const parentKey of parents) {
    try {
      const parent = deps.config.get(parentKey);
      if (!isRecordObject(parent)) continue;
      const rest = { ...parent };
      for (const source of configSources) {
        if (source.parentKey === parentKey) delete rest[source.field];
      }
      deps.config.set(parentKey, rest);
    } catch (error) {
      console.warn(`[LegacyAuditRingImport] Could not strip imported rings from ${parentKey}:`, error);
    }
  }
  if (sidecarImported && deps.sidecarPath) {
    try {
      fs.renameSync(deps.sidecarPath, archiveName(deps.sidecarPath, deps.now()));
    } catch (error) {
      console.warn("[LegacyAuditRingImport] Could not archive audit-logs.json:", error);
    }
  }
}
