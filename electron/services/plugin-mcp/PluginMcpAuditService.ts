import { randomUUID } from "node:crypto";
import type {
  PluginMcpAuditConfig,
  PluginMcpAuditRecord,
  PluginMcpAuditResult,
} from "../../../shared/types/ipc/pluginMcpAudit.js";
import {
  PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS,
  PLUGIN_MCP_AUDIT_MAX_RECORDS,
  PLUGIN_MCP_AUDIT_MIN_RECORDS,
  PLUGIN_MCP_AUDIT_SCHEMA_VERSION,
} from "../../../shared/types/ipc/pluginMcpAudit.js";
import type {
  PluginMcpConsentDecision,
  PluginMcpConsentReason,
  PluginMcpDangerTier,
} from "../../../shared/types/pluginMcpConsent.js";
import { sha256Hex, stableArgsSha256 } from "../../utils/pluginMcpHash.js";

const FLUSH_DEBOUNCE_MS = 2000;

/**
 * Append-time input for {@link PluginMcpAuditService.append}. Raw values for
 * description, schema, and args are passed in; the service computes the
 * SHA-256 digests internally and **never retains the raw values** after the
 * hashes are taken. Callers do not pre-hash so the service is the single
 * choke point for the hashing-order invariant — raw bytes, pre-strip.
 */
export interface PluginMcpAuditInput {
  pluginId: string;
  serverId: string;
  toolName: string;
  dangerTier: PluginMcpDangerTier;
  /** Raw description bytes received from the server's `tools/list`. */
  descriptionRaw: string;
  /** Raw input schema object received from the server. `null` if absent. */
  inputSchema: unknown;
  /** Raw call arguments as the model sent them. `undefined` for no args. */
  rawArgs: unknown;
  durationMs: number;
  result: PluginMcpAuditResult;
  consentReason?: PluginMcpConsentReason;
  consentDecision?: PluginMcpConsentDecision;
  errorCode?: string;
}

/**
 * Bounded ring buffer for inbound plugin-MCP tool-call audit records. Mirrors
 * the storage pattern of `AuditService` and `PluginActionAuditService` —
 * hydrate / append / trim / debounced flush — without the anomaly detection
 * surface.
 *
 * Privacy invariants:
 * - Raw arguments are *never* persisted. The service hashes via
 *   `stableArgsSha256` and discards the raw value before constructing the
 *   record. There is no developer-mode opt-in to bypass this (unlike
 *   `PluginActionAuditService` which can store plaintext args under a flag),
 *   because plugin-MCP tool args have a much higher secret-leak surface — a
 *   plugin's MCP server can shape the schema to extract whatever the model
 *   passes.
 * - The raw description is hashed via `sha256Hex` and discarded. The hash is
 *   over the raw bytes (no ANSI/Markdown stripping) so a rug-pull payload
 *   hidden in invisible Unicode still flips the digest.
 */
/**
 * Persistence boundary for the ring buffer itself. Config flags stay behind
 * `saveConfig`/`readConfig` (the `pluginMcpAudit` config.json slice); the ring
 * lives in the dedicated audit-logs store (migration023). Injected so this
 * class stays store-free and unit-testable.
 */
export interface PluginMcpAuditLogStore {
  read(): unknown;
  write(records: PluginMcpAuditRecord[], options?: { sync?: boolean }): void;
}

export class PluginMcpAuditService {
  private records: PluginMcpAuditRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>,
    private readonly logStore: PluginMcpAuditLogStore
  ) {}

  append(input: PluginMcpAuditInput): void {
    // Single config read per append — the same result gates the kill switch
    // and supplies the trim cap.
    const config = this.readConfig();
    if (config.auditEnabled === false) return;
    this.hydrate();

    const tool_description_sha = sha256Hex(input.descriptionRaw);
    const input_schema_sha =
      input.inputSchema === null || input.inputSchema === undefined
        ? sha256Hex("")
        : stableArgsSha256(input.inputSchema);
    const arg_sha =
      input.rawArgs === undefined || input.rawArgs === null ? "" : stableArgsSha256(input.rawArgs);

    const record: PluginMcpAuditRecord = {
      id: randomUUID(),
      ts: Date.now(),
      pluginId: input.pluginId,
      serverId: input.serverId,
      toolName: input.toolName,
      dangerTier: input.dangerTier,
      tool_description_sha,
      input_schema_sha,
      arg_sha,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      result: input.result,
      schemaVersion: PLUGIN_MCP_AUDIT_SCHEMA_VERSION,
    };
    if (input.consentReason !== undefined) record.consentReason = input.consentReason;
    if (input.consentDecision !== undefined) record.consentDecision = input.consentDecision;
    if (input.errorCode !== undefined) record.errorCode = input.errorCode;

    this.enqueueAndTrim(record, this.normalizeMaxRecords(config.auditMaxRecords));
  }

  hydrate(): void {
    if (this.hydrated) return;
    const stored = this.logStore.read();
    const persisted = Array.isArray(stored) ? stored : [];
    const cap = this.normalizeMaxRecords(this.readConfig().auditMaxRecords);
    const safe: PluginMcpAuditRecord[] = [];
    for (const raw of persisted) {
      const record = pickKnownAuditFields(raw);
      if (record) safe.push(record);
    }
    this.records = safe.length > cap ? safe.slice(safe.length - cap) : safe;
    this.hydrated = true;
  }

  normalizeMaxRecords(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return PLUGIN_MCP_AUDIT_DEFAULT_MAX_RECORDS;
    if (n < PLUGIN_MCP_AUDIT_MIN_RECORDS) return PLUGIN_MCP_AUDIT_MIN_RECORDS;
    if (n > PLUGIN_MCP_AUDIT_MAX_RECORDS) return PLUGIN_MCP_AUDIT_MAX_RECORDS;
    return n;
  }

  private enqueueAndTrim(record: PluginMcpAuditRecord, cap: number): void {
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
      console.error("[PluginMcpAudit] Failed to flush audit log:", err);
    }
  }

  // Critical-moment flush (clear, shutdown): persists synchronously on the
  // main connection instead of the fire-and-forget worker path, so the
  // snapshot is durable when this returns.
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(true);
  }

  /** Newest-first view of all persisted records. */
  getRecords(): PluginMcpAuditRecord[] {
    this.hydrate();
    return [...this.records].reverse();
  }

  getConfig(): PluginMcpAuditConfig {
    const config = this.readConfig();
    return {
      enabled: config.auditEnabled !== false,
      maxRecords: this.normalizeMaxRecords(config.auditMaxRecords),
    };
  }

  setEnabled(enabled: boolean): PluginMcpAuditConfig {
    this.hydrate();
    this.saveConfig({ auditEnabled: enabled });
    return this.getConfig();
  }

  setMaxRecords(max: number): PluginMcpAuditConfig {
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

  _resetForTest(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.records = [];
    this.hydrated = false;
  }
}

/**
 * Allowlist-narrow a persisted record to the known `PluginMcpAuditRecord`
 * shape. Returns `null` for malformed entries, and silently drops any extra
 * fields that may have been written by a future schema version or injected by
 * local-filesystem tampering. The privacy invariant — "no raw values at rest"
 * — depends on this being an allowlist, not a passthrough: a future field
 * called `rawArgs` (or anything else not listed here) must NOT survive a
 * round-trip through the service.
 */
function pickKnownAuditFields(raw: unknown): PluginMcpAuditRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== "string" ||
    typeof r.ts !== "number" ||
    typeof r.pluginId !== "string" ||
    typeof r.serverId !== "string" ||
    typeof r.toolName !== "string" ||
    typeof r.dangerTier !== "string" ||
    typeof r.tool_description_sha !== "string" ||
    typeof r.input_schema_sha !== "string" ||
    typeof r.arg_sha !== "string" ||
    typeof r.durationMs !== "number" ||
    typeof r.result !== "string" ||
    typeof r.schemaVersion !== "number"
  ) {
    return null;
  }
  const out: PluginMcpAuditRecord = {
    id: r.id,
    ts: r.ts,
    pluginId: r.pluginId,
    serverId: r.serverId,
    toolName: r.toolName,
    dangerTier: r.dangerTier as PluginMcpAuditRecord["dangerTier"],
    tool_description_sha: r.tool_description_sha,
    input_schema_sha: r.input_schema_sha,
    arg_sha: r.arg_sha,
    durationMs: r.durationMs,
    result: r.result as PluginMcpAuditResult,
    schemaVersion: r.schemaVersion,
  };
  if (typeof r.consentReason === "string") {
    out.consentReason = r.consentReason as PluginMcpAuditRecord["consentReason"];
  }
  if (typeof r.consentDecision === "string") {
    out.consentDecision = r.consentDecision as PluginMcpAuditRecord["consentDecision"];
  }
  if (typeof r.errorCode === "string") out.errorCode = r.errorCode;
  return out;
}
