import { randomUUID } from "node:crypto";
import type {
  McpAuditRecord,
  McpAuditResult,
  McpConfirmationDecision,
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
} from "./shared.js";

export class AuditService {
  private records: McpAuditRecord[] = [];
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
  }): void {
    if (this.readConfig().auditEnabled === false) return;
    this.hydrate();

    const classification = this.classifyDispatchResult(input.outcome);
    const decision = this.deriveConfirmationDecision(input.outcome, input.confirmationDecision);
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

  getRecords(): McpAuditRecord[] {
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
  | { kind: "unauthorized" };
