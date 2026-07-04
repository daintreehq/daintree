import { randomUUID } from "node:crypto";
import type {
  McpAnomalySignal,
  McpAuditRecord,
  McpAuditResult,
  McpAuditStats,
  McpConfirmationDecision,
  McpGrantActorType,
  McpGrantRecord,
  McpGrantRecordType,
  McpGrantRevokedReason,
  McpLogRecord,
} from "../../../shared/types/ipc/mcpServer.js";
import {
  MCP_AUDIT_DEFAULT_MAX_RECORDS,
  MCP_AUDIT_MAX_RECORDS,
  MCP_AUDIT_MIN_RECORDS,
  MCP_AUDIT_SCHEMA_VERSION,
  computeMcpAuditSeverity,
  isAuditRecord,
  isGrantRecord,
} from "../../../shared/types/ipc/mcpServer.js";
import { auditRingStore } from "../persistence/auditRingStore.js";
import type { McpTier } from "./shared.js";
import {
  AUDIT_FLUSH_DEBOUNCE_MS,
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  USER_REJECTED_CODE,
  CONFIRMATION_TIMEOUT_CODE,
  MCP_DEDUP_KEY_COLLISION_CODE,
  minimumPermittingTier,
  PRE_AUTH_FAILED_CODE,
} from "./shared.js";

// Legacy error code, read-only. The CallTool rate limiter was removed (#10764),
// so nothing emits this anymore — it survives only to classify `rate_limited`
// outcomes deserialized from historical on-disk audit records.
const MCP_RATE_LIMITED_CODE = "MCP_RATE_LIMITED";

const ANOMALY_MIN_RECORDS = 50;
const LATENCY_SIGMA_THRESHOLD = 3;
const FAILURE_CLUSTER_WINDOW = 10;
const FAILURE_CLUSTER_MIN_FAILURES = 3;
const MAD_SCALE_FACTOR = 0.6745;
const P95_Z_SCORE_MIN_TOOLS = 5;

export interface McpAuditLogStore {
  read(): unknown;
  write(records: McpLogRecord[], options?: { sync?: boolean }): void;
}

// Persists the ring in the dedicated audit-logs store so settings writes to
// config.json stay decoupled from audit appends and bootstrap never pays the
// parse cost of the rings. `auditEnabled` / `auditMaxRecords` stay in
// config.json (`mcpServer`), read via the injected config closures.
const defaultLogStore: McpAuditLogStore = {
  read: () => auditRingStore.readAll("mcpAuditLog"),
  write: (records, options) =>
    auditRingStore.writeAll("mcpAuditLog", records, MCP_AUDIT_DEFAULT_MAX_RECORDS, options),
};

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
  /** Pre-auth record coalescing state — see `recordAuth401()`. */
  private lastPreAuthRecordId: string | null = null;
  private lastPreAuthRecordAt = 0;

  constructor(
    private readonly saveConfig: (patch: Record<string, unknown>) => void,
    private readonly readConfig: () => Record<string, unknown>,
    private readonly logStore: McpAuditLogStore = defaultLogStore
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
      // Grant records (post-#8442) carry a `type` discriminator and never
      // need audit-specific backfilling — pass them through unchanged,
      // but only when the discriminator is a known `McpGrantRecordType`
      // value. A stringly-typed `type: "dispatch"` (or any unknown
      // discriminator) would otherwise be misclassified as a grant and
      // misrendered in the viewer (#10027).
      if (isGrantRecord(r as unknown as McpLogRecord)) {
        return r as unknown as McpLogRecord;
      }
      return {
        ...r,
        schemaVersion: (r.schemaVersion as number) ?? MCP_AUDIT_SCHEMA_VERSION,
        severity:
          (r.severity as string) ??
          computeMcpAuditSeverity(r.result as McpAuditResult, r.errorCode as string | undefined),
      } as McpAuditRecord;
    }) as McpLogRecord[];
    this.records = backfilled.length > cap ? backfilled.slice(backfilled.length - cap) : backfilled;
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
    return classifyMcpDispatchResult(outcome);
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
    helpSessionId?: string;
    resultSummary?: string;
    resultMeta?: McpAuditRecord["resultMeta"];
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
      schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
      severity: computeMcpAuditSeverity(classification.result, classification.errorCode),
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
    if (input.helpSessionId !== undefined) {
      record.helpSessionId = input.helpSessionId;
    }
    if (input.resultSummary !== undefined) {
      record.resultSummary = input.resultSummary;
    }
    if (input.resultMeta !== undefined) {
      record.resultMeta = input.resultMeta;
    }

    this.enqueueAndTrim(record);
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
    tier?: McpTier;
    previousTier?: McpTier;
    grantId?: string;
    maxUses?: number;
    remainingUses?: number;
    actorId?: string;
    actorType?: McpGrantActorType;
    allowedTools?: string[];
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
    if (input.tier !== undefined) record.tier = input.tier;
    if (input.previousTier !== undefined) record.previousTier = input.previousTier;
    if (input.grantId !== undefined) record.grantId = input.grantId;
    if (input.maxUses !== undefined) record.maxUses = input.maxUses;
    if (input.remainingUses !== undefined) record.remainingUses = input.remainingUses;
    if (input.actorId !== undefined) record.actorId = input.actorId;
    if (input.actorType !== undefined) record.actorType = input.actorType;
    if (input.allowedTools !== undefined) record.allowedTools = input.allowedTools;

    this.enqueueAndTrim(record);
  }

  /**
   * Increment the session-scoped 401 counter and emit a rate-limited
   * pre-auth audit record. Called from the HTTP lifecycle on bearer auth
   * failures (missing/malformed/revoked) before any tool dispatch occurs.
   * Gated by the same `auditEnabled` kill switch as `appendRecord`.
   *
   * Rate limit: the first 401 writes a record immediately. Subsequent 401s
   * within the coalesce window (1s) increment `repeatCount` on the most
   * recent pre-auth record rather than writing duplicates. `repeatCount` on
   * the record body tracks the total occurrences, with `undefined` for
   * a single occurrence and `>= 2` once coalescing kicks in.
   */
  recordAuth401(): void {
    if (this.readConfig().auditEnabled === false) return;
    this.auth401Count += 1;
    this.hydrate();

    const now = Date.now();
    const COALESCE_WINDOW_MS = 1000;

    if (this.lastPreAuthRecordId !== null && now - this.lastPreAuthRecordAt < COALESCE_WINDOW_MS) {
      const existing = this.records.find((r) => r.id === this.lastPreAuthRecordId);
      // Narrow to McpAuditRecord — grant records carry a `type` discriminator;
      // audit records do not. See `McpLogRecord` in shared/types/ipc/mcpServer.ts.
      if (existing && isAuditRecord(existing) && existing.errorCode === PRE_AUTH_FAILED_CODE) {
        existing.timestamp = now;
        existing.repeatCount = (existing.repeatCount ?? 1) + 1;
        this.lastPreAuthRecordAt = now;
        this.scheduleFlush();
        return;
      }
    }

    const record: McpAuditRecord = {
      id: randomUUID(),
      timestamp: now,
      toolId: "mcp.pre-auth",
      sessionId: "",
      tier: "system",
      argsSummary: "pre-auth request rejected",
      result: "unauthorized",
      errorCode: PRE_AUTH_FAILED_CODE,
      durationMs: 0,
      schemaVersion: MCP_AUDIT_SCHEMA_VERSION,
      severity: computeMcpAuditSeverity("unauthorized", PRE_AUTH_FAILED_CODE),
    };

    this.lastPreAuthRecordId = record.id;
    this.lastPreAuthRecordAt = now;

    this.enqueueAndTrim(record);
  }

  private enqueueAndTrim(record: McpLogRecord): void {
    this.records.push(record);
    const cap = this.normalizeMaxRecords(this.readConfig().auditMaxRecords);
    if (this.records.length > cap) {
      const evicted = this.records.splice(0, this.records.length - cap);
      // If the coalesce target was evicted, reset so the next 401 writes a new record.
      if (this.lastPreAuthRecordId) {
        for (const r of evicted) {
          if (r.id === this.lastPreAuthRecordId) {
            this.lastPreAuthRecordId = null;
            this.lastPreAuthRecordAt = 0;
            break;
          }
        }
      }
    }
    this.scheduleFlush();
  }
  /**
   * Read the session-scoped audit health counters. Renderer-facing.
   *
   * `markSeen` controls whether `first-seen-combination` signals are
   * acknowledged (added to `knownCombinations`) as a side effect — see
   * {@link getSignals}. User-facing surfaces (the Settings audit log) keep the
   * default `true` so a combo fires once and then stays quiet. Passive pollers
   * that only need the ambient count (the toolbar/HelpPanel anomaly indicator,
   * #10022) must pass `false`, or their background cadence would consume the
   * transient first-seen signal before the user ever navigates to the log.
   */
  getAuditStats(markSeen = true): McpAuditStats {
    const signals = this.getSignals(markSeen);
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

  /**
   * Compute the current anomaly signals across the dispatch ring buffer.
   *
   * `markSeen` (default `true`) governs the one stateful signal kind,
   * `first-seen-combination`: when `true`, each newly-observed `toolId+tier`
   * combo is recorded in `knownCombinations` so it fires exactly once. A passive
   * caller passes `false` to read the same signals without acknowledging them —
   * so a background poll can surface the ambient indicator while leaving the
   * "fire once" acknowledgment to the user-facing audit log (#10022). The
   * initial baseline seeding always runs regardless of `markSeen`, otherwise
   * every pre-existing combo would read as first-seen on the first call. The
   * other three kinds (latency drift, failure clustering, p95 z-score) are
   * stateless recomputations and are unaffected by `markSeen`.
   */
  getSignals(markSeen = true): McpAnomalySignal[] {
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

    // 1. First-seen combinations — only for combos not yet in the set. A local
    // set dedupes within this call so a passive read (markSeen=false), which
    // doesn't persist to knownCombinations, still emits each combo at most once.
    const emittedThisCall = new Set<string>();
    for (const r of records) {
      const key = `${r.toolId} ${r.tier}`;
      if (!this.knownCombinations.has(key) && !emittedThisCall.has(key)) {
        emittedThisCall.add(key);
        if (markSeen) this.knownCombinations.add(key);
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
      const median = percentile(durations, 0.5);
      const absDeviations = durations.map((d) => Math.abs(d - median));
      const mad = percentile(absDeviations, 0.5);
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
    const medianP95 = percentile(p95s, 0.5);
    const absDeviations = p95s.map((p) => Math.abs(p - medianP95));
    const madP95 = percentile(absDeviations, 0.5);
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

  private flush(sync = false): void {
    if (!this.hydrated) return;
    try {
      this.logStore.write([...this.records], { sync });
    } catch (err) {
      console.error("[MCP] Failed to flush audit log:", err);
    }
  }

  // Critical-moment flush (clear, session teardown, shutdown): persists
  // synchronously on the main connection instead of the fire-and-forget
  // worker path, so the snapshot is durable when this returns.
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush(true);
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

  /**
   * Drop audit records older than `retentionDays`, then flush if anything was
   * removed. `retentionDays <= 0` is the "Off" setting — keep everything,
   * bounded only by the count cap. Filters on each record's own `.timestamp`
   * (event time, `Date.now()` at append), NOT the SQLite `created_at` column:
   * `writeAll` re-stamps `created_at` to the flush time on every flush, so it
   * cannot distinguish record ages. Records whose `timestamp` is not a finite
   * number are retained rather than dropped — a corrupt timestamp shouldn't
   * silently evict privacy-sensitive history.
   */
  pruneByAge(retentionDays: number): void {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
    this.hydrate();
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const before = this.records.length;
    this.records = this.records.filter(
      (r) => !(Number.isFinite(r.timestamp) && r.timestamp < cutoff)
    );
    if (this.records.length !== before) {
      // If the pre-auth coalesce target was pruned, reset the coalesce state so
      // the next 401 writes a fresh record rather than mutating a vanished one —
      // mirrors the eviction reset in `enqueueAndTrim`.
      if (
        this.lastPreAuthRecordId !== null &&
        !this.records.some((r) => r.id === this.lastPreAuthRecordId)
      ) {
        this.lastPreAuthRecordId = null;
        this.lastPreAuthRecordAt = 0;
      }
      this.flushNow();
    }
  }
}

export type AuditOutcome =
  | { kind: "result"; value: import("../../../shared/types/actions.js").ActionDispatchResult }
  | { kind: "throw"; error: unknown }
  | { kind: "unauthorized" }
  | { kind: "dedup" }
  | { kind: "collision" }
  // Legacy, dead for writers: nothing constructs this since the CallTool rate
  // limiter was removed (#10764). Retained so `classifyMcpDispatchResult` can
  // still map the `rate_limited` outcome carried by historical on-disk records.
  | { kind: "rate_limited"; retryAfter: number };

/**
 * Map a dispatch {@link AuditOutcome} to its persisted `result` class and
 * optional `errorCode`. Shared between the audit-record writer and the live
 * tool-activity push (#9759) so the activity strip's glyph/severity matches
 * exactly what the audit log records for the same dispatch.
 */
export function classifyMcpDispatchResult(outcome: AuditOutcome): {
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
  if (outcome.kind === "rate_limited") {
    return { result: "rate_limited", errorCode: MCP_RATE_LIMITED_CODE };
  }
  const value = outcome.value;
  if (value.ok) return { result: "success" };
  if (value.error.code === CONFIRMATION_REQUIRED_CODE) {
    return { result: "confirmation-pending", errorCode: value.error.code };
  }
  return { result: "error", errorCode: value.error.code };
}
