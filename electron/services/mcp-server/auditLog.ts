import { randomUUID } from "node:crypto";
import type {
  McpAnomalySignal,
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

const ANOMALY_MIN_RECORDS = 50;
const LATENCY_SIGMA_THRESHOLD = 3;
const FAILURE_CLUSTER_WINDOW = 10;
const FAILURE_CLUSTER_MIN_FAILURES = 3;
const MAD_SCALE_FACTOR = 0.6745;
const P95_Z_SCORE_MIN_TOOLS = 5;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const rank = p * (sortedAsc.length - 1);
  const k = Math.floor(rank);
  const f = rank - k;
  const lower = sortedAsc[k]!;
  const upper = sortedAsc[k + 1] ?? lower;
  return lower + f * (upper - lower);
}

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
  /**
   * Known {toolId, tier} combinations observed across the entire process
   * lifetime. Seeded from hydrated records on the first `getSignals()` call.
   * Survives `clear()` — clearing the ring frees space but should not
   * re-trigger first-seen signals for combinations already observed.
   */
  private knownCombinations = new Set<string>();

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
    turnId?: string;
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
      schemaVersion: 1,
      severity: auditSeverityFromResult(classification.result),
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
    if (input.turnId !== undefined) {
      record.turnId = input.turnId;
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
    const signals = this.getSignals();
    return {
      auth401Count: this.auth401Count,
      anomalySignals: signals,
      anomalySuppressed: this.dispatchRecordCount() < ANOMALY_MIN_RECORDS,
      anomalyRecordFloor: ANOMALY_MIN_RECORDS,
    };
  }

  /**
   * Count of dispatch records (excluding grant-lifecycle entries) currently
   * in the ring buffer. Anomaly detection operates strictly on dispatch
   * records, so the suppression floor is measured against this count.
   */
  private dispatchRecordCount(): number {
    let n = 0;
    for (const r of this.records) {
      if (!isGrantRecord(r)) n += 1;
    }
    return n;
  }

  getSignals(): McpAnomalySignal[] {
    this.hydrate();
    const records: McpAuditRecord[] = [];
    for (const r of this.records) {
      if (!isGrantRecord(r)) records.push(r);
    }
    if (records.length < ANOMALY_MIN_RECORDS) return [];

    const signals: McpAnomalySignal[] = [];

    // Seed knownCombinations from all records on first call so existing
    // combos don't fire first-seen signals retroactively.
    const firstCall = this.knownCombinations.size === 0;
    if (firstCall) {
      for (const r of records) {
        this.knownCombinations.add(`${r.toolId} ${r.tier}`);
      }
    }

    // 1. First-seen combinations — only for combos not yet in the set.
    for (const r of records) {
      const key = `${r.toolId} ${r.tier}`;
      if (!this.knownCombinations.has(key)) {
        this.knownCombinations.add(key);
        signals.push({
          id: `first-seen:${r.toolId}:${r.tier}`,
          kind: "first-seen-combination",
          toolId: r.toolId,
          tier: r.tier,
          severity: "danger",
          timestamp: r.timestamp,
          recordIds: [r.id],
        });
      }
    }

    // 2. Latency drift — per-tool modified z-score (MAD-based).
    const latencySignals = this.computeLatencyDrift(records);
    signals.push(...latencySignals);

    // 3. Failure clustering — sliding window over chronological records.
    const failureSignals = this.computeFailureClusters(records);
    signals.push(...failureSignals);

    // 4. P95 z-score — cross-tool outlier detection.
    const p95Signals = this.computeP95ZScores(records);
    signals.push(...p95Signals);

    return signals;
  }

  private computeLatencyDrift(records: readonly McpAuditRecord[]): McpAnomalySignal[] {
    const signals: McpAnomalySignal[] = [];
    const byTool = new Map<string, McpAuditRecord[]>();
    for (const r of records) {
      if (r.result !== "success") continue;
      const list = byTool.get(r.toolId);
      if (list) list.push(r);
      else byTool.set(r.toolId, [r]);
    }
    for (const [toolId, toolRecords] of byTool) {
      if (toolRecords.length < 2) continue;
      const durations = toolRecords.map((r) => r.durationMs);
      const sortedDurations = [...durations].sort((a, b) => a - b);
      const median = percentile(sortedDurations, 0.5);
      const absDeviations = durations.map((d) => Math.abs(d - median));
      const sortedAbsDeviations = [...absDeviations].sort((a, b) => a - b);
      const mad = percentile(sortedAbsDeviations, 0.5);
      if (mad === 0) continue;
      for (let i = 0; i < toolRecords.length; i++) {
        const duration = durations[i]!;
        const zScore = (MAD_SCALE_FACTOR * (duration - median)) / mad;
        if (zScore >= LATENCY_SIGMA_THRESHOLD) {
          const record = toolRecords[i]!;
          signals.push({
            id: `latency-drift:${record.id}`,
            kind: "latency-drift",
            toolId,
            tier: record.tier,
            severity: "danger",
            timestamp: record.timestamp,
            recordIds: [record.id],
            zScore: Math.round(zScore * 100) / 100,
            durationMs: duration,
            baselineMedianMs: Math.round(median),
          });
        }
      }
    }
    return signals;
  }

  private computeFailureClusters(records: readonly McpAuditRecord[]): McpAnomalySignal[] {
    const signals: McpAnomalySignal[] = [];
    const emitted = new Set<string>();
    for (let start = 0; start <= records.length - FAILURE_CLUSTER_WINDOW; start++) {
      const windowRecords = records.slice(start, start + FAILURE_CLUSTER_WINDOW);
      const failuresByTool = new Map<string, McpAuditRecord[]>();
      for (const r of windowRecords) {
        if (r.result === "success" || r.result === "dedup") continue;
        const list = failuresByTool.get(r.toolId);
        if (list) list.push(r);
        else failuresByTool.set(r.toolId, [r]);
      }
      for (const [toolId, toolFailures] of failuresByTool) {
        if (toolFailures.length < FAILURE_CLUSTER_MIN_FAILURES) continue;
        const latest = toolFailures[toolFailures.length - 1]!;
        const sigId = `failure-cluster:${toolId}:${latest.id}`;
        if (emitted.has(sigId)) continue;
        emitted.add(sigId);
        signals.push({
          id: sigId,
          kind: "failure-cluster",
          toolId,
          severity: "danger",
          timestamp: latest.timestamp,
          recordIds: toolFailures.map((r) => r.id),
          clusterSize: toolFailures.length,
          clusterWindow: FAILURE_CLUSTER_WINDOW,
        });
      }
    }
    return signals;
  }

  private computeP95ZScores(records: readonly McpAuditRecord[]): McpAnomalySignal[] {
    const signals: McpAnomalySignal[] = [];
    const byTool = new Map<string, McpAuditRecord[]>();
    for (const r of records) {
      if (r.result !== "success") continue;
      const list = byTool.get(r.toolId);
      if (list) list.push(r);
      else byTool.set(r.toolId, [r]);
    }
    if (byTool.size < P95_Z_SCORE_MIN_TOOLS) return signals;

    const toolP95s: { toolId: string; p95: number; latestRecord: McpAuditRecord }[] = [];
    for (const [toolId, toolRecords] of byTool) {
      if (toolRecords.length < 2) continue;
      const sorted = toolRecords.map((r) => r.durationMs).sort((a, b) => a - b);
      const p95 = percentile(sorted, 0.95);
      toolP95s.push({ toolId, p95, latestRecord: toolRecords[toolRecords.length - 1]! });
    }
    if (toolP95s.length < P95_Z_SCORE_MIN_TOOLS) return signals;

    const p95s = toolP95s.map((t) => t.p95);
    const sortedP95s = [...p95s].sort((a, b) => a - b);
    const medianP95 = percentile(sortedP95s, 0.5);
    const absDeviations = p95s.map((p) => Math.abs(p - medianP95));
    const sortedAbsDeviations = [...absDeviations].sort((a, b) => a - b);
    const madP95 = percentile(sortedAbsDeviations, 0.5);
    if (madP95 === 0) return signals;

    for (const entry of toolP95s) {
      const zScore = (MAD_SCALE_FACTOR * (entry.p95 - medianP95)) / madP95;
      if (zScore >= LATENCY_SIGMA_THRESHOLD) {
        signals.push({
          id: `p95-z-score:${entry.toolId}`,
          kind: "p95-z-score",
          toolId: entry.toolId,
          severity: "danger",
          timestamp: entry.latestRecord.timestamp,
          recordIds: [entry.latestRecord.id],
          zScore: Math.round(zScore * 100) / 100,
          p95Ms: Math.round(entry.p95),
        });
      }
    }
    return signals;
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
    // knownCombinations intentionally preserved — clearing the ring frees
    // space but should not re-trigger first-seen signals for combos already
    // observed in this process lifetime.
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

function auditSeverityFromResult(
  result: McpAuditResult
): import("../../../shared/types/ipc/mcpServer.js").McpAuditSeverity {
  switch (result) {
    case "success":
    case "dedup":
      return "info";
    case "confirmation-pending":
      return "notice";
    case "unauthorized":
    case "collision":
      return "warning";
    case "error":
      return "error";
  }
}

export type AuditOutcome =
  | { kind: "result"; value: import("../../../shared/types/actions.js").ActionDispatchResult }
  | { kind: "throw"; error: unknown }
  | { kind: "unauthorized" }
  | { kind: "dedup" }
  | { kind: "collision" };
