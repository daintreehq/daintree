import { randomUUID } from "node:crypto";
import type {
  ForgeAnomalySignal,
  ForgeAuditRecord,
  ForgeAuditResult,
  ForgeAuditStats,
  ForgeProviderMethodName,
} from "../../../shared/types/ipc/forge.js";
import {
  FORGE_AUDIT_ANOMALY_MIN_RECORDS,
  FORGE_AUDIT_DEFAULT_MAX_RECORDS,
  FORGE_AUDIT_MAX_RECORDS,
  FORGE_AUDIT_MIN_RECORDS,
  FORGE_AUDIT_SCHEMA_VERSION,
  computeForgeAuditSeverity,
} from "../../../shared/types/ipc/forge.js";

/**
 * Debounce window for flushing the ring buffer to disk. Mirrors the MCP
 * `AUDIT_FLUSH_DEBOUNCE_MS` (`electron/services/mcp-server/shared.ts`); kept
 * as a local constant rather than imported to avoid pulling the MCP module
 * graph into the forge surface for a single number.
 */
const FORGE_AUDIT_FLUSH_DEBOUNCE_MS = 2000;

const LATENCY_SIGMA_THRESHOLD = 3;
const MAD_SCALE_FACTOR = 0.6745;
// Forge calls are low-frequency, so the failure-cluster window and p95 method
// floor are smaller than MCP's (10/3 and 5): a 5-record window flagging 2
// failures, and p95 cross-method comparison needing only 3 distinct methods.
const FAILURE_CLUSTER_WINDOW = 5;
const FAILURE_CLUSTER_MIN_FAILURES = 2;
const P95_Z_SCORE_MIN_METHODS = 3;

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = p * (sorted.length - 1);
  const k = Math.floor(rank);
  const f = rank - k;
  const lower = sorted[k]!;
  const upper = sorted[k + 1] ?? lower;
  return lower + f * (upper - lower);
}

/**
 * Build a redacted, single-level argument summary for a forge call. Only safe
 * metadata is included — never credential values, never resource bodies.
 * `validateToken` returns `""` (the only argument is the raw token).
 */
export function summarizeForgeArgs(
  methodName: ForgeProviderMethodName | (string & {}),
  args: unknown
): string {
  switch (methodName) {
    case "listIssues":
    case "listPRs": {
      const opts = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      if (typeof opts.state === "string") summary.state = opts.state;
      if (Array.isArray(opts.labels) && opts.labels.length > 0) summary.labels = opts.labels.length;
      if (typeof opts.perPage === "number") summary.perPage = opts.perPage;
      return JSON.stringify(summary);
    }
    case "listIssueComments": {
      // Paging shape only. Comment bodies are the whole payload here and are
      // never summarized; the cursor is opaque but can encode position, so
      // only its presence is recorded.
      const opts = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      if (typeof opts.issueNumber === "number") summary.number = opts.issueNumber;
      if (typeof opts.perPage === "number") summary.perPage = opts.perPage;
      if (typeof opts.cursor === "string") summary.paged = true;
      return JSON.stringify(summary);
    }
    case "getIssue":
    case "getPR":
    case "getCIStatus":
    case "assignIssue":
    case "unassignIssue":
    case "approvePR":
    case "requestChanges":
    case "dismissReview":
    case "requestReviewers":
    case "closePR":
    case "reopenPR":
    case "mergePR":
    case "convertPRToDraft":
    case "markPRReadyForReview":
    case "commentOnPR":
    case "editPR":
    case "closeIssue":
    case "reopenIssue": {
      // These also receive content (review/comment body, dismissal message,
      // edit title/body, merge commit text), identifiers (review id), or PII
      // (username, reviewer logins) — deliberately omitted. Only the resource
      // number is safe metadata.
      const num = typeof args === "number" ? args : undefined;
      return JSON.stringify(num !== undefined ? { number: num } : {});
    }
    case "createPR":
      // head/base/title/body are all user content — and there's no number yet.
      return "";
    case "createIssue": {
      // Only the label count is safe metadata — title and body are user content.
      const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      if (Array.isArray(input.labels) && input.labels.length > 0) {
        summary.labels = input.labels.length;
      }
      return JSON.stringify(summary);
    }
    case "editIssue": {
      // Title/body are user content — log only which fields were touched.
      const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      if (typeof input.number === "number") summary.number = input.number;
      if (input.hasTitle) summary.hasTitle = true;
      if (input.hasBody) summary.hasBody = true;
      return JSON.stringify(summary);
    }
    case "addIssueComment": {
      // Comment body is user content — log only its length.
      const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      if (typeof input.number === "number") summary.number = input.number;
      if (typeof input.bodyLength === "number") summary.bodyLength = input.bodyLength;
      return JSON.stringify(summary);
    }
    case "addIssueLabel":
    case "removeIssueLabel": {
      // Label names are repo metadata, not PII — safe to log alongside the number.
      const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
      const summary: Record<string, unknown> = {};
      if (typeof input.number === "number") summary.number = input.number;
      if (typeof input.label === "string") summary.label = input.label;
      return JSON.stringify(summary);
    }
    case "validateToken":
      return "";
    case "getRepoMetadata":
      return "";
    case "getCurrentUser":
      // Read probe — takes no args worth summarizing.
      return "";
    default:
      return "";
  }
}

/**
 * Persistence boundary for the ring buffer itself. Config flags stay behind
 * `saveConfig`/`readConfig` (the `forgeAudit` config.json slice); the ring
 * lives in the dedicated audit-logs store (migration023). Injected so this
 * class stays store-free and unit-testable.
 */
export interface ForgeAuditLogStore {
  read(): unknown;
  write(records: ForgeAuditRecord[], options?: { sync?: boolean }): void;
}

export class ForgeAuditService {
  private records: ForgeAuditRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private hydrated = false;
  /**
   * Known {providerId, methodName} combinations observed across the process
   * lifetime. Seeded from hydrated records on the first `getSignals()` call so
   * existing combos don't fire first-seen signals retroactively. Survives
   * `clear()`.
   */
  private knownCombinations = new Set<string>();

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>,
    private readonly logStore: ForgeAuditLogStore
  ) {}

  hydrate(): void {
    if (this.hydrated) return;
    const stored = this.logStore.read();
    const persisted = Array.isArray(stored) ? stored : [];
    const cap = this.normalizeMaxRecords(this.readConfig().auditMaxRecords);
    const safe = persisted.filter(
      (r: unknown): r is Record<string, unknown> => r !== null && typeof r === "object"
    );
    const backfilled = safe.map((r: Record<string, unknown>) => {
      return {
        ...r,
        schemaVersion: (r.schemaVersion as number) ?? FORGE_AUDIT_SCHEMA_VERSION,
        severity: (r.severity as string) ?? computeForgeAuditSeverity(r.result as ForgeAuditResult),
      } as ForgeAuditRecord;
    });
    this.records = backfilled.length > cap ? backfilled.slice(backfilled.length - cap) : backfilled;
    this.hydrated = true;
  }

  normalizeMaxRecords(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : NaN;
    if (!Number.isFinite(n)) return FORGE_AUDIT_DEFAULT_MAX_RECORDS;
    if (n < FORGE_AUDIT_MIN_RECORDS) return FORGE_AUDIT_MIN_RECORDS;
    if (n > FORGE_AUDIT_MAX_RECORDS) return FORGE_AUDIT_MAX_RECORDS;
    return n;
  }

  appendRecord(input: {
    providerId: string;
    methodName: ForgeProviderMethodName | (string & {});
    result: ForgeAuditResult;
    durationMs: number;
    repoOwner?: string;
    repoName?: string;
    argsSummary?: string;
    errorMessage?: string;
  }): void {
    // Single config read per append — the same result gates the kill switch
    // and supplies the trim cap.
    const config = this.readConfig();
    if (config.auditEnabled === false) return;
    this.hydrate();

    const record: ForgeAuditRecord = {
      id: randomUUID(),
      timestamp: Date.now(),
      providerId: input.providerId,
      methodName: input.methodName,
      result: input.result,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      schemaVersion: FORGE_AUDIT_SCHEMA_VERSION,
      severity: computeForgeAuditSeverity(input.result),
    };
    if (input.repoOwner !== undefined) record.repoOwner = input.repoOwner;
    if (input.repoName !== undefined) record.repoName = input.repoName;
    if (input.argsSummary !== undefined) record.argsSummary = input.argsSummary;
    if (input.errorMessage !== undefined) record.errorMessage = input.errorMessage;

    this.enqueueAndTrim(record, this.normalizeMaxRecords(config.auditMaxRecords));
  }

  private enqueueAndTrim(record: ForgeAuditRecord, cap: number): void {
    this.records.push(record);
    if (this.records.length > cap) {
      this.records.splice(0, this.records.length - cap);
    }
    this.scheduleFlush();
  }

  getAuditStats(): ForgeAuditStats {
    const signals = this.getSignals();
    return {
      anomalySignals: signals,
      anomalySuppressed: this.records.length < FORGE_AUDIT_ANOMALY_MIN_RECORDS,
      anomalyRecordFloor: FORGE_AUDIT_ANOMALY_MIN_RECORDS,
    };
  }

  getSignals(): ForgeAnomalySignal[] {
    this.hydrate();
    const records = this.records;
    if (records.length < FORGE_AUDIT_ANOMALY_MIN_RECORDS) return [];

    const signals: ForgeAnomalySignal[] = [];

    // Seed knownCombinations on first call so existing combos don't fire
    // first-seen signals retroactively.
    const firstCall = this.knownCombinations.size === 0;
    if (firstCall) {
      for (const r of records) {
        this.knownCombinations.add(`${r.providerId} ${r.methodName}`);
      }
    }

    // 1. First-seen {provider, method} combinations.
    for (const r of records) {
      const key = `${r.providerId} ${r.methodName}`;
      if (!this.knownCombinations.has(key)) {
        this.knownCombinations.add(key);
        signals.push({
          id: `first-seen:${r.providerId}:${r.methodName}`,
          kind: "first-seen-method",
          providerId: r.providerId,
          methodName: r.methodName,
          severity: "danger",
          timestamp: r.timestamp,
          recordIds: [r.id],
        });
      }
    }

    signals.push(...this.computeLatencyDrift(records));
    signals.push(...this.computeFailureClusters(records));
    signals.push(...this.computeP95ZScores(records));

    return signals;
  }

  /** Group key isolates a provider's method baseline from other providers. */
  private groupKey(r: ForgeAuditRecord): string {
    return `${r.providerId} ${r.methodName}`;
  }

  private computeLatencyDrift(records: readonly ForgeAuditRecord[]): ForgeAnomalySignal[] {
    const signals: ForgeAnomalySignal[] = [];
    const byMethod = new Map<string, ForgeAuditRecord[]>();
    for (const r of records) {
      if (r.result !== "success") continue;
      const key = this.groupKey(r);
      const list = byMethod.get(key);
      if (list) list.push(r);
      else byMethod.set(key, [r]);
    }
    for (const methodRecords of byMethod.values()) {
      if (methodRecords.length < 2) continue;
      const durations = methodRecords.map((r) => r.durationMs);
      const median = percentile(durations, 0.5);
      const absDeviations = durations.map((d) => Math.abs(d - median));
      const mad = percentile(absDeviations, 0.5);
      if (mad === 0) continue;
      for (let i = 0; i < methodRecords.length; i++) {
        const duration = durations[i]!;
        const zScore = (MAD_SCALE_FACTOR * (duration - median)) / mad;
        if (zScore >= LATENCY_SIGMA_THRESHOLD) {
          const record = methodRecords[i]!;
          signals.push({
            id: `latency-drift:${record.id}`,
            kind: "latency-drift",
            providerId: record.providerId,
            methodName: record.methodName,
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

  private computeFailureClusters(records: readonly ForgeAuditRecord[]): ForgeAnomalySignal[] {
    const signals: ForgeAnomalySignal[] = [];
    const emitted = new Set<string>();
    for (let start = 0; start <= records.length - FAILURE_CLUSTER_WINDOW; start++) {
      const windowRecords = records.slice(start, start + FAILURE_CLUSTER_WINDOW);
      const failuresByMethod = new Map<string, ForgeAuditRecord[]>();
      for (const r of windowRecords) {
        if (r.result !== "error") continue;
        const key = this.groupKey(r);
        const list = failuresByMethod.get(key);
        if (list) list.push(r);
        else failuresByMethod.set(key, [r]);
      }
      for (const methodFailures of failuresByMethod.values()) {
        if (methodFailures.length < FAILURE_CLUSTER_MIN_FAILURES) continue;
        const latest = methodFailures[methodFailures.length - 1]!;
        const sigId = `failure-cluster:${latest.providerId}:${latest.methodName}:${latest.id}`;
        if (emitted.has(sigId)) continue;
        emitted.add(sigId);
        signals.push({
          id: sigId,
          kind: "failure-cluster",
          providerId: latest.providerId,
          methodName: latest.methodName,
          severity: "danger",
          timestamp: latest.timestamp,
          recordIds: methodFailures.map((r) => r.id),
          clusterSize: methodFailures.length,
          clusterWindow: FAILURE_CLUSTER_WINDOW,
        });
      }
    }
    return signals;
  }

  private computeP95ZScores(records: readonly ForgeAuditRecord[]): ForgeAnomalySignal[] {
    const signals: ForgeAnomalySignal[] = [];
    const byMethod = new Map<string, ForgeAuditRecord[]>();
    for (const r of records) {
      if (r.result !== "success") continue;
      const key = this.groupKey(r);
      const list = byMethod.get(key);
      if (list) list.push(r);
      else byMethod.set(key, [r]);
    }
    if (byMethod.size < P95_Z_SCORE_MIN_METHODS) return signals;

    const methodP95s: { record: ForgeAuditRecord; p95: number }[] = [];
    for (const methodRecords of byMethod.values()) {
      if (methodRecords.length < 2) continue;
      const sorted = methodRecords.map((r) => r.durationMs).sort((a, b) => a - b);
      const p95 = percentile(sorted, 0.95);
      methodP95s.push({ record: methodRecords[methodRecords.length - 1]!, p95 });
    }
    if (methodP95s.length < P95_Z_SCORE_MIN_METHODS) return signals;

    const p95s = methodP95s.map((t) => t.p95);
    const medianP95 = percentile(p95s, 0.5);
    const absDeviations = p95s.map((p) => Math.abs(p - medianP95));
    const madP95 = percentile(absDeviations, 0.5);
    if (madP95 === 0) return signals;

    for (const entry of methodP95s) {
      const zScore = (MAD_SCALE_FACTOR * (entry.p95 - medianP95)) / madP95;
      if (zScore >= LATENCY_SIGMA_THRESHOLD) {
        signals.push({
          id: `p95-z-score:${entry.record.providerId}:${entry.record.methodName}`,
          kind: "p95-z-score",
          providerId: entry.record.providerId,
          methodName: entry.record.methodName,
          severity: "danger",
          timestamp: entry.record.timestamp,
          recordIds: [entry.record.id],
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
    }, FORGE_AUDIT_FLUSH_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flush(sync = false): void {
    if (!this.hydrated) return;
    try {
      this.logStore.write([...this.records], { sync });
    } catch (err) {
      console.error("[Forge] Failed to flush audit log:", err);
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

  /** Newest-first view of the ring buffer. */
  getRecords(): ForgeAuditRecord[] {
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
    // knownCombinations intentionally preserved — clearing the ring should not
    // re-trigger first-seen signals for combos already observed.
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
