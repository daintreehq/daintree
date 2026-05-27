// eager-import-allow: reads/writes the plugin audit log via store.get synchronously
import { randomUUID } from "node:crypto";
import type {
  PluginAuditErrorCode,
  PluginAuditRecord,
  PluginAuditResult,
} from "../../shared/types/ipc/plugin.js";
import {
  PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
  PLUGIN_AUDIT_MAX_RECORDS,
  PLUGIN_AUDIT_MIN_RECORDS,
  PLUGIN_AUDIT_SCHEMA_VERSION,
  computePluginAuditSeverity,
} from "../../shared/types/ipc/plugin.js";
import { store } from "../store.js";

/**
 * Debounce window for batching ring-buffer writes to disk. Defined locally
 * rather than imported from the MCP server's `shared.ts` so the plugin audit
 * surface stays self-contained and free of any MCP-subsystem dependency.
 */
const PLUGIN_AUDIT_FLUSH_DEBOUNCE_MS = 2000;

/**
 * Config-backed ring buffer for plugin IPC audit records. Mirrors the MCP
 * `AuditService` lifecycle — lazy hydration on first use, synchronous
 * in-memory append, debounced disk flush — but is scoped to plugin
 * invocations and carries no anomaly-detection or grant-lifecycle logic.
 *
 * Append is synchronous on purpose: `handleFileDecorationsGet` calls it from
 * inside its settle loop, so a blocking disk write per provider failure would
 * stall the loop. The actual persistence is deferred to a debounced timer.
 */
export class PluginAuditService {
  private records: PluginAuditRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>
  ) {}

  hydrate(): void {
    if (this.hydrated) return;
    const config = this.readConfig();
    const persisted = Array.isArray(config.auditLog) ? config.auditLog : [];
    const cap = this.normalizeMaxRecords(config.auditMaxRecords);
    const safe = persisted.filter(
      (r: unknown): r is Record<string, unknown> => r !== null && typeof r === "object"
    );
    const backfilled = safe.map((r: Record<string, unknown>) => {
      return {
        ...r,
        source: "plugin",
        schemaVersion: (r.schemaVersion as number) ?? PLUGIN_AUDIT_SCHEMA_VERSION,
        severity:
          (r.severity as string) ??
          computePluginAuditSeverity(
            r.result as PluginAuditResult,
            r.errorCode as string | undefined
          ),
      } as PluginAuditRecord;
    });
    this.records = backfilled.length > cap ? backfilled.slice(backfilled.length - cap) : backfilled;
    this.hydrated = true;
  }

  normalizeMaxRecords(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return PLUGIN_AUDIT_DEFAULT_MAX_RECORDS;
    if (n < PLUGIN_AUDIT_MIN_RECORDS) return PLUGIN_AUDIT_MIN_RECORDS;
    if (n > PLUGIN_AUDIT_MAX_RECORDS) return PLUGIN_AUDIT_MAX_RECORDS;
    return n;
  }

  appendRecord(input: {
    pluginId: string;
    channel: string;
    argsSummary: string;
    result: PluginAuditResult;
    durationMs: number;
    errorCode?: PluginAuditErrorCode;
    webContentsId?: number;
    contributionId?: string;
    scope?: string;
  }): void {
    if (this.readConfig().auditEnabled === false) return;
    this.hydrate();

    const record: PluginAuditRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      source: "plugin",
      pluginId: input.pluginId,
      channel: input.channel,
      argsSummary: input.argsSummary,
      result: input.result,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      schemaVersion: PLUGIN_AUDIT_SCHEMA_VERSION,
      severity: computePluginAuditSeverity(input.result, input.errorCode),
    };
    if (input.errorCode !== undefined) record.errorCode = input.errorCode;
    if (input.webContentsId !== undefined) record.webContentsId = input.webContentsId;
    if (input.contributionId !== undefined) record.contributionId = input.contributionId;
    if (input.scope !== undefined) record.scope = input.scope;

    this.records.push(record);
    const cap = this.normalizeMaxRecords(this.readConfig().auditMaxRecords);
    if (this.records.length > cap) {
      this.records.splice(0, this.records.length - cap);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, PLUGIN_AUDIT_FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (!this.hydrated) return;
    try {
      this.saveConfig({ auditLog: [...this.records] });
    } catch (err) {
      console.error("[Plugin] Failed to flush audit log:", err);
    }
  }

  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Newest-first view of the audit records. Renderer-facing. */
  getRecords(): PluginAuditRecord[] {
    this.hydrate();
    return [...this.records].reverse();
  }

  getAuditConfig(): { enabled: boolean; maxRecords: number } {
    const config = this.readConfig();
    return {
      enabled: config.auditEnabled !== false,
      maxRecords: this.normalizeMaxRecords(config.auditMaxRecords),
    };
  }

  clear(): void {
    this.hydrate();
    this.records = [];
    this.flushNow();
  }
}

export const pluginAuditService = new PluginAuditService(
  (patch) => {
    const current = store.get("plugins");
    store.set("plugins", {
      ...current,
      ...patch,
      auditLog: "auditLog" in patch ? (patch.auditLog as PluginAuditRecord[]) : current.auditLog,
    });
  },
  () => store.get("plugins") as unknown as Record<string, unknown>
);
