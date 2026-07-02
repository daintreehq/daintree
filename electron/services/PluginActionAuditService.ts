// eager-import-allow: wires the plugin-audit ring buffer to the synchronous electron-store slice at boot (global service, mirrors ActionBreadcrumbService)
import { randomUUID } from "node:crypto";
import type {
  DecorationFailureMode,
  PluginActionAuditRecord,
  PluginActionAuditRecordType,
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
import { auditRingStore } from "./persistence/auditRingStore.js";
import { store } from "../store.js";

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

export interface PluginAuditLogStore {
  read(): unknown;
  write(records: PluginActionAuditRecord[], options?: { sync?: boolean }): void;
}

// Persists the ring in the dedicated audit-logs store (migration023) so
// config.json stays small and audit appends never re-serialize it.
// `auditEnabled` / `auditMaxRecords` stay in config.json (`plugins`), read via
// the injected config closures.
const defaultLogStore: PluginAuditLogStore = {
  read: () => auditRingStore.readAll("pluginAuditLog"),
  write: (records, options) =>
    auditRingStore.writeAll("pluginAuditLog", records, PLUGIN_AUDIT_DEFAULT_MAX_RECORDS, options),
};

/**
 * Main-process ring buffer of plugin-action dispatch audit records. Mirrors
 * the MCP `AuditService` storage pattern (hydrate / append / trim / debounced
 * flush) without its anomaly-detection surface — plugin audit is a plain
 * chronological dispatch trail.
 *
 * Records are appended from the `action:dispatched` bus event whenever the
 * dispatched action carries a `pluginId`. Config flags are wired to the
 * `plugins` store slice via the `saveConfig`/`readConfig` callbacks and the
 * ring to the audit-logs store via `logStore`, so the service stays decoupled
 * from the concrete store module.
 */
export class PluginActionAuditService {
  private records: PluginActionAuditRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>,
    private readonly logStore: PluginAuditLogStore = defaultLogStore
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
          recordType: "action-dispatch",
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
    const stored = this.logStore.read();
    const persisted = Array.isArray(stored) ? stored : [];
    const cap = this.normalizeMaxRecords(this.readConfig().auditMaxRecords);
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
    recordType?: PluginActionAuditRecordType;
    /** Only meaningful when `recordType === "action-dispatch"`. */
    source?: ActionSource;
    /** Only meaningful when `recordType === "action-dispatch"`. */
    danger?: ActionDanger;
    argsHash: string;
    argsPlaintext?: string;
    durationMs: number;
    result: PluginActionAuditResult;
    turnId?: string;
    /** IPC channel name — `ipc-invoke` records only. */
    channel?: string;
    /** Failure mode — `decoration-failure` records only. */
    failureMode?: DecorationFailureMode;
    /** Decoration scope — `decoration-failure` records only. */
    scope?: string;
    /** Decoration contribution id — `decoration-failure` records only. */
    contributionId?: string;
    /** Human-readable failure message — `error` records. */
    errorMessage?: string;
  }): void {
    // Single config read per append — the same result gates the kill switch
    // and supplies the trim cap.
    const config = this.readConfig();
    if (config.auditEnabled === false) return;
    this.hydrate();

    const record: PluginActionAuditRecord = {
      id: randomUUID(),
      ts: Date.now(),
      pluginId: input.pluginId,
      actionId: input.actionId,
      argsHash: input.argsHash,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      result: input.result,
      schemaVersion: PLUGIN_AUDIT_SCHEMA_VERSION,
    };
    if (input.recordType !== undefined) record.recordType = input.recordType;
    if (input.source !== undefined) record.source = input.source;
    if (input.danger !== undefined) record.danger = input.danger;
    if (input.argsPlaintext !== undefined) record.argsPlaintext = input.argsPlaintext;
    if (input.turnId !== undefined) record.turnId = input.turnId;
    if (input.channel !== undefined) record.channel = input.channel;
    if (input.failureMode !== undefined) record.failureMode = input.failureMode;
    if (input.scope !== undefined) record.scope = input.scope;
    if (input.contributionId !== undefined) record.contributionId = input.contributionId;
    if (input.errorMessage !== undefined) record.errorMessage = input.errorMessage;

    this.enqueueAndTrim(record, this.normalizeMaxRecords(config.auditMaxRecords));
  }

  private enqueueAndTrim(record: PluginActionAuditRecord, cap: number): void {
    this.records.push(record);
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

  private flush(sync = false): void {
    if (!this.hydrated) return;
    try {
      this.logStore.write([...this.records], { sync });
    } catch (err) {
      console.error("[PluginAudit] Failed to flush audit log:", err);
    }
  }

  // Critical-moment flush (clear, dispose, shutdown): persists synchronously
  // on the main connection instead of the fire-and-forget worker path, so the
  // snapshot is durable when this returns.
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(true);
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
    // `store` is the lazy electron-store Proxy — importing it doesn't initialize
    // the backing store, and the singleton is only constructed on first use.
    // The spread merge keeps a legacy `plugins.auditLog` carryover intact for
    // installs where migration023 deferred (audit-logs store not durable).
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
