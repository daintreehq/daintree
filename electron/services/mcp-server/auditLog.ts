import { randomUUID } from "node:crypto";
import type {
  McpAuditRecord,
  McpAuditResult,
  McpAuditStats,
  McpConfirmationDecision,
  McpGrantRecord,
  McpGrantRecordType,
  McpGrantRevokedReason,
  McpLogRecord,
} from "../../../shared/types/ipc/mcpServer.js";
import {
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_MIN_RECORDS,
} from "../../../shared/types/ipc/mcpServer.js";
import type { McpTier } from "./shared.js";
import {
  AUDIT_FLUSH_DEBOUNCE_MS,
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  USER_REJECTED_CODE,
  CONFIRMATION_TIMEOUT_CODE,
  MCP_DEDUP_KEY_COLLISION_CODE,
  minimumPermittingTier,
} from "./shared.js";

/**
 * Hydrate predicate: existing on-disk records predate the discriminated
 * union (#8442) and have no `type` field; new entries written by
 * `appendGrantRecord` carry one. The union narrows on the presence of
 * the field, never on a sentinel value, so legacy records remain plain
 * `McpAuditRecord` instances.
 */
function isGrantRecord(record: McpLogRecord): record is McpGrantRecord {
  return "type" in record && typeof (record as McpGrantRecord).type === "string";
}

export class AuditService {
  private records: McpLogRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;
  /**
   * Session-scoped 401 counter. Tracks bearer auth rejections that fail
   * before any tool dispatch — those never reach `appendRecord` because
   * no `toolId`/`tier` is known. Reset on app restart by design.
   */
  private auth401Count = 0;

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>
  ) {}

  hydrate(): void {
    if (this.hydrated) return;
    const config = this.readConfig();
    const persisted = Array.isArray(config.auditLog) ? config.auditLog : [];
    const cap = this.normalizeMaxRecords(config.auditMaxRecords);
    this.records =
      persisted.length > cap ? persisted.slice(persisted.length - cap) : [...persisted];
    this.hydrated = true;
  }

  normalizeMaxRecords(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return MCP_AUDIT_DEFAULT_MAX_RECORDS;
    if (n < MCP_AUDIT_MIN_RECORDS) return MCP_AUDIT_MIN_RECORDS;
    if (n > MCP_AUDIT_MAX_RECORDS) return MCP_AUDIT_MAX_RECORDS;
    return n;
  }

  private classifyDispatchResult(outcome: AuditOutcome): {
    result: McpAuditResult;
    errorCode?: string;
  } {
    if (outcome.kind === "throw") {
      return { result: "error", errorCode: "DISPATCH_THREW" };
    }
    if (outcome.kind === "unauthorized") {
      return { result: "unauthorized", errorCode: TIER_NOT_PERMITTED_CODE };
    }
    if (outcome.kind === "dedup") {
      return { result: "dedup" };
    }
    if (outcome.kind === "collision") {
      return { result: "collision", errorCode: MCP_DEDUP_KEY_COLLISION_CODE };
    }
    const value = outcome.value;
    if (value.ok) return { result: "success" };
    if (value.error.code === CONFIRMATION_REQUIRED_CODE) {
      return { result: "confirmation-pending", errorCode: value.error.code };
    }
    return { result: "error", errorCode: value.error.code };
  }

  private deriveConfirmationDecision(
    outcome: AuditOutcome,
    hint: McpConfirmationDecision | undefined
  ): McpConfirmationDecision | undefined {
    if (outcome.kind === "result" && !outcome.value.ok) {
      if (outcome.value.error.code === USER_REJECTED_CODE) return "rejected";
      if (outcome.value.error.code === CONFIRMATION_TIMEOUT_CODE) return "timeout";
    }
    if (hint === "approved") {
      return "approved";
    }
    return undefined;
  }

  appendRecord(input: {
    toolId: string;
    sessionId: string;
    tier: McpTier;
    args: unknown;
    durationMs: number;
    outcome: AuditOutcome;
    confirmationDecision?: McpConfirmationDecision;
    argsSummary: string;
    bannerSuppressed?: boolean;
  }): void {
    if (this.readConfig().auditEnabled === false) return;
    this.hydrate();

    const classification = this.classifyDispatchResult(input.outcome);
    const decision = this.deriveConfirmationDecision(input.outcome, input.confirmationDecision);
    // `argsSummary` is expected to have already passed through the
    // `summarizeMcpArgs` redactor (key-name + scrub + sanitizePath) at the
    // call site in `httpLifecycle.ts`. Stored verbatim here.
    const record: McpAuditRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      toolId: input.toolId,
      sessionId: input.sessionId,
      tier: input.tier,
      argsSummary: input.argsSummary,
      result: classification.result,
      durationMs: Math.max(0, Math.round(input.durationMs)),
    };
    if (classification.errorCode !== undefined) {
      record.errorCode = classification.errorCode;
    }
    if (decision !== undefined) {
      record.confirmationDecision = decision;
    }
    if (classification.result === "unauthorized") {
      record.tierHint = minimumPermittingTier(input.toolId);
      if (input.bannerSuppressed) {
        record.bannerSuppressed = true;
      }
    }

    this.records.push(record);
    this.enforceCap();
    this.scheduleFlush();
  }

  /**
   * Append a grant-lifecycle record to the same ring buffer as dispatch
   * audit entries. Sharing the buffer keeps the audit-log surface honest:
   * a reader walking the records in order sees grants minted, dispatches
   * authorised under them, and the eventual expiry or revocation as a
   * single chronological trail.
   */
  appendGrantRecord(input: {
    type: McpGrantRecordType;
    sessionId: string;
    toolId: string;
    ttlMs: number;
    expiresAt?: number;
    revokedReason?: McpGrantRevokedReason;
  }): void {
    if (this.readConfig().auditEnabled === false) return;
    this.hydrate();

    const record: McpGrantRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      type: input.type,
      sessionId: input.sessionId,
      toolId: input.toolId,
      ttlMs: input.ttlMs,
    };
    if (input.expiresAt !== undefined) record.expiresAt = input.expiresAt;
    if (input.revokedReason !== undefined) record.revokedReason = input.revokedReason;

    this.records.push(record);
    this.enforceCap();
    this.scheduleFlush();
  }

  private enforceCap(): void {
    const cap = this.normalizeMaxRecords(this.readConfig().auditMaxRecords);
    if (this.records.length > cap) {
      this.records.splice(0, this.records.length - cap);
    }
  }

  /**
   * Increment the session-scoped 401 counter. Called from the HTTP lifecycle
   * on bearer auth failures (missing/malformed/revoked) before any tool
   * dispatch occurs. Gated by the same `auditEnabled` kill switch as
   * `appendRecord` so toggling audit logging off uniformly silences both
   * record writes and counter increments.
   */
  recordAuth401(): void {
    if (this.readConfig().auditEnabled === false) return;
    this.auth401Count += 1;
  }

  /**
   * Read the session-scoped audit health counters. Renderer-facing.
   */
  getAuditStats(): McpAuditStats {
    return { auth401Count: this.auth401Count };
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, AUDIT_FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    if (!this.hydrated) return;
    try {
      this.saveConfig({ auditLog: [...this.records] });
    } catch (err) {
      console.error("[MCP] Failed to flush audit log:", err);
    }
  }

  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /**
   * Newest-first view of dispatch records only. Grant lifecycle records
   * (#8442) are filtered out for the legacy renderer surface that still
   * shows `result`-keyed columns. {@link getLogRecords} returns the full
   * union for callers that understand the new discriminator.
   */
  getRecords(): McpAuditRecord[] {
    this.hydrate();
    const out: McpAuditRecord[] = [];
    for (const record of this.records) {
      if (!isGrantRecord(record)) out.push(record);
    }
    return out.reverse();
  }

  /**
   * Newest-first view of the full log union — audit + grant records
   * interleaved chronologically. Reserved for the audit panel surface
   * that explicitly handles both shapes.
   */
  getLogRecords(): McpLogRecord[] {
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

  setEnabled(enabled: boolean): { enabled: boolean; maxRecords: number } {
    this.hydrate();
    this.saveConfig({ auditEnabled: enabled });
    return this.getAuditConfig();
  }

  setMaxRecords(max: number): { enabled: boolean; maxRecords: number } {
    this.hydrate();
    const normalized = this.normalizeMaxRecords(max);
    if (this.records.length > normalized) {
      this.records.splice(0, this.records.length - normalized);
    }
    this.saveConfig({ auditMaxRecords: normalized });
    this.flushNow();
    return this.getAuditConfig();
  }
}

export type AuditOutcome =
  | { kind: "result"; value: import("../../../shared/types/actions.js").ActionDispatchResult }
  | { kind: "throw"; error: unknown }
  | { kind: "unauthorized" }
  | { kind: "dedup" }
  | { kind: "collision" };
