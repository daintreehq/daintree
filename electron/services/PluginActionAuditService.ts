import { randomUUID } from "node:crypto";
import type {
  PluginActionAuditRecord,
  PluginActionAuditResult,
  PluginAuditConfig,
} from "../../shared/types/ipc/pluginAudit.js";
import {
  PLUGIN_AUDIT_DEFAULT_MAX_RECORDS,
  PLUGIN_AUDIT_MAX_RECORDS,
  PLUGIN_AUDIT_MIN_RECORDS,
  PLUGIN_AUDIT_SCHEMA_VERSION,
} from "../../shared/types/ipc/pluginAudit.js";
import type { ActionSource, ActionDanger } from "../../shared/types/actions.js";
import { events } from "./events.js";
import type { TypedEventBus } from "./events.js";

const FLUSH_DEBOUNCE_MS = 1000;
const MAX_PLAINTEXT_CHARS = 4096;

/**
 * Persisted plaintext args may only be stored when the developer opts in.
 * Serializes the (already redacted) args the renderer forwarded, capped so a
 * single oversized payload can't bloat the store. Returns undefined when the
 * args are absent or unserializable.
 */
function summarizePlaintext(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(args);
  } catch {
    return undefined;
  }
  if (typeof serialized !== "string") return undefined;
  return serialized.length > MAX_PLAINTEXT_CHARS
    ? `${serialized.slice(0, MAX_PLAINTEXT_CHARS)}…`
    : serialized;
}

/**
 * Main-process ring buffer of plugin-action dispatch audit records. Mirrors
 * the MCP `AuditService` storage pattern (hydrate / append / trim / debounced
 * flush) without its anomaly-detection surface — plugin audit is a plain
 * chronological dispatch trail.
 *
 * Records are appended from the `action:dispatched` bus event whenever the
 * dispatched action carries a `pluginId`. Persistence is wired to the
 * `plugins` store slice via the `saveConfig`/`readConfig` callbacks so the
 * service stays decoupled from the concrete store module.
 */
export class PluginActionAuditService {
  private records: PluginActionAuditRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>
  ) {}

  /**
   * Subscribe to the action-dispatch bus. Records are appended only for
   * plugin-contributed actions (`payload.pluginId` set). `isPlaintextEnabled`
   * gates whether the redacted plaintext args are persisted alongside the hash.
   */
  initialize(opts: { isPlaintextEnabled: () => boolean }, bus: TypedEventBus = events): void {
    if (this.unsubscribe) return;
    this.unsubscribe = bus.on("action:dispatched", (payload) => {
      if (typeof payload.pluginId !== "string" || payload.pluginId.length === 0) return;
      try {
        this.append({
          pluginId: payload.pluginId,
          actionId: payload.actionId,
          source: payload.source as ActionSource,
          danger: payload.danger as ActionDanger,
          argsHash: typeof payload.argsHash === "string" ? payload.argsHash : "",
          argsPlaintext: opts.isPlaintextEnabled() ? summarizePlaintext(payload.args) : undefined,
          durationMs: payload.durationMs,
          result: "success",
        });
      } catch (err) {
        console.warn("[PluginAudit] Failed to append dispatch record:", err);
      }
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.flushNow();
    this.records = [];
    this.hydrated = false;
  }

  hydrate(): void {
    if (this.hydrated) return;
    const config = this.readConfig();
    const persisted = Array.isArray(config.auditLog) ? config.auditLog : [];
    const cap = this.normalizeMaxRecords(config.auditMaxRecords);
    const safe = persisted.filter((r: unknown): r is PluginActionAuditRecord => {
      if (r === null || typeof r !== "object") return false;
      const rec = r as { id?: unknown; pluginId?: unknown; actionId?: unknown };
      // Require the fields the viewer reads unguarded (`pluginId.toLowerCase()`,
      // `actionId.toLowerCase()`) so a manually corrupted store can't crash it.
      return (
        typeof rec.id === "string" &&
        typeof rec.pluginId === "string" &&
        typeof rec.actionId === "string"
      );
    });
    this.records = safe.length > cap ? safe.slice(safe.length - cap) : safe;
    this.hydrated = true;
  }

  normalizeMaxRecords(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return PLUGIN_AUDIT_DEFAULT_MAX_RECORDS;
    if (n < PLUGIN_AUDIT_MIN_RECORDS) return PLUGIN_AUDIT_MIN_RECORDS;
    if (n > PLUGIN_AUDIT_MAX_RECORDS) return PLUGIN_AUDIT_MAX_RECORDS;
    return n;
  }

  append(input: {
    pluginId: string;
    actionId: string;
    source: ActionSource;
    danger: ActionDanger;
    argsHash: string;
    argsPlaintext?: string;
    durationMs: number;
    result: PluginActionAuditResult;
    turnId?: string;
  }): void {
    if (this.readConfig().auditEnabled === false) return;
    this.hydrate();

    const record: PluginActionAuditRecord = {
      id: randomUUID(),
      ts: Date.now(),
      pluginId: input.pluginId,
      actionId: input.actionId,
      source: input.source,
      danger: input.danger,
      argsHash: input.argsHash,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      result: input.result,
      schemaVersion: PLUGIN_AUDIT_SCHEMA_VERSION,
    };
    if (input.argsPlaintext !== undefined) record.argsPlaintext = input.argsPlaintext;
    if (input.turnId !== undefined) record.turnId = input.turnId;

    this.enqueueAndTrim(record);
  }

  private enqueueAndTrim(record: PluginActionAuditRecord): void {
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
    }, FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (!this.hydrated) return;
    try {
      this.saveConfig({ auditLog: [...this.records] });
    } catch (err) {
      console.error("[PluginAudit] Failed to flush audit log:", err);
    }
  }

  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /** Newest-first view of all persisted records. */
  getRecords(): PluginActionAuditRecord[] {
    this.hydrate();
    return [...this.records].reverse();
  }

  getConfig(): PluginAuditConfig {
    const config = this.readConfig();
    return {
      enabled: config.auditEnabled !== false,
      maxRecords: this.normalizeMaxRecords(config.auditMaxRecords),
    };
  }

  setEnabled(enabled: boolean): PluginAuditConfig {
    this.hydrate();
    this.saveConfig({ auditEnabled: enabled });
    return this.getConfig();
  }

  setMaxRecords(max: number): PluginAuditConfig {
    this.hydrate();
    const normalized = this.normalizeMaxRecords(max);
    if (this.records.length > normalized) {
      this.records.splice(0, this.records.length - normalized);
    }
    this.saveConfig({ auditMaxRecords: normalized });
    this.flushNow();
    return this.getConfig();
  }

  clear(): void {
    this.hydrate();
    this.records = [];
    this.flushNow();
  }

  /** Serialize the given records as newline-delimited JSON for export. */
  exportRecords(records: PluginActionAuditRecord[]): string {
    return records.map((r) => JSON.stringify(r)).join("\n");
  }

  _resetForTest(): void {
    this.dispose();
    this.records = [];
    this.hydrated = false;
  }
}

let instance: PluginActionAuditService | null = null;

export function getPluginActionAuditService(): PluginActionAuditService {
  if (!instance) {
    // Lazy require to avoid pulling the electron-store module into unit tests
    // that exercise the class directly with injected callbacks.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { store } = require("../store.js") as typeof import("../store.js");
    instance = new PluginActionAuditService(
      (patch) => {
        const current = (store.get("plugins") ?? {}) as Record<string, unknown>;
        store.set("plugins", { ...current, ...patch });
      },
      () => (store.get("plugins") ?? {}) as Record<string, unknown>
    );
  }
  return instance;
}

export function _resetPluginActionAuditServiceForTest(): void {
  instance?._resetForTest();
  instance = null;
}
