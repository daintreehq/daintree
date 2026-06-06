import type { RateLimitInfo } from "../forge.js";

/**
 * Provider-agnostic rate-limit kind. `primary` is quota exhaustion (the
 * provider's request budget is spent until `resetAt`); `secondary` is an
 * abuse / burst throttle. The vocabulary is intentionally generic — it is
 * not GitHub-specific even though GitHub is currently the only built-in
 * provider that reports it.
 */
export type ForgeRateLimitKind = "primary" | "secondary";

/**
 * Push payload for `forge:rate-limit-changed`. Carries the canonical
 * `providerId` so the renderer can key state per provider — GitHub and any
 * additional forge provider flow through the same channel and never
 * cross-contaminate. `state` is the provider-agnostic {@link RateLimitInfo}
 * the workspace-host observed; the renderer normalizes it per provider.
 */
export interface ForgeRateLimitChangedPayload {
  providerId: string;
  state: RateLimitInfo;
}

/**
 * Push payload for `forge:token-health-changed`. Forward-compat scaffolding:
 * the channel, store keying, and router broadcast are wired so a provider
 * implementation that gains token-health probing can emit this with no
 * further plumbing. No workspace-host emitter produces it yet — GitHub token
 * health still flows over the legacy `github:token-health-changed` channel.
 */
export interface ForgeTokenHealthChangedPayload {
  providerId: string;
  isUnhealthy: boolean;
}

/**
 * Result classification for a single forge-provider method invocation.
 *
 * - `success`: the call resolved normally.
 * - `not-found`: the call resolved with `null` for a lookup that distinguishes
 *   "absent" from "failed" (`getIssue`/`getPR` return `Issue | null`). Forge
 *   APIs surface a 404 as a null return, not a thrown error, so this is a
 *   nominal outcome — not a failure.
 * - `error`: the call threw (network failure, auth rejection, malformed
 *   response). Recorded even when the caller's UI banner is suppressed, per
 *   the #8442 audit-even-when-silenced doctrine.
 */
export type ForgeAuditResult = "success" | "not-found" | "error";

/**
 * Derived severity for a forge audit record, computed at write time so
 * readers triage without re-deriving from `result`.
 *
 * - `info`: success — nominal call.
 * - `notice`: not-found — a lookup miss, expected during normal use.
 * - `error`: the provider call threw.
 */
export type ForgeAuditSeverity = "info" | "notice" | "error";

/**
 * Known `ForgeProviderImpl` methods that emit audit records. Kept as an open
 * union (`| (string & {})`) so a provider method added later still type-checks
 * as a `methodName` while the known names autocomplete and stay greppable.
 */
export type ForgeProviderMethodName =
  | "listIssues"
  | "listPRs"
  | "getIssue"
  | "getPR"
  | "getRepoMetadata"
  | "createIssue"
  | "assignIssue"
  | "unassignIssue"
  | "validateToken";

export const FORGE_AUDIT_SCHEMA_VERSION = 1;

/** Minimum and maximum values accepted for the configurable ring-buffer cap. */
export const FORGE_AUDIT_MIN_RECORDS = 50;
export const FORGE_AUDIT_MAX_RECORDS = 10000;
export const FORGE_AUDIT_DEFAULT_MAX_RECORDS = 500;

const FORGE_SEVERITY_BY_RESULT: Record<ForgeAuditResult, ForgeAuditSeverity> = {
  success: "info",
  "not-found": "notice",
  error: "error",
};

export function computeForgeAuditSeverity(result: ForgeAuditResult): ForgeAuditSeverity {
  return FORGE_SEVERITY_BY_RESULT[result];
}

/**
 * Persisted audit record for a single `ForgeProviderImpl` method call. Written
 * once per invocation regardless of outcome — slow providers, credential
 * failures, and malformed responses all leave a trail. Distinct from
 * {@link import("./mcpServer.js").McpAuditRecord} (no `tier`/`sessionId`:
 * forge calls originate from the main process, not agent sessions).
 *
 * `argsSummary` is a redacted, single-level view of the call arguments — only
 * safe metadata (issue/PR number, list filters). Raw credential values are
 * never persisted: `validateToken` records an empty summary.
 *
 * `repoOwner`/`repoName` carry the owner/repo identity from the resolved
 * `RepoRef` — never the raw remote URL or any auth material. Absent on calls
 * with no repo context (`validateToken`).
 */
export interface ForgeAuditRecord {
  id: string;
  timestamp: number;
  /** Canonical `{pluginId}.{contributionId}` provider id. */
  providerId: string;
  methodName: ForgeProviderMethodName | (string & {});
  result: ForgeAuditResult;
  durationMs: number;
  repoOwner?: string;
  repoName?: string;
  /** Redacted single-level argument summary. Empty for credential calls. */
  argsSummary?: string;
  /** Provider error message on `result: "error"`. Absent otherwise. */
  errorMessage?: string;
  /** Schema version for forward-compat. New records always carry the current version. */
  schemaVersion: number;
  /** Derived severity so readers triage without re-deriving from result. */
  severity: ForgeAuditSeverity;
}

export type ForgeAnomalySeverity = "danger";

export type ForgeAnomalyKind =
  | "latency-drift"
  | "first-seen-method"
  | "failure-cluster"
  | "p95-z-score";

/**
 * Anomaly signal computed across the forge audit ring buffer. Mirrors
 * {@link import("./mcpServer.js").McpAnomalySignal} but keys on `methodName`
 * rather than `toolId`, and is scoped per `providerId` so a slow provider
 * doesn't poison another provider's baseline.
 */
export interface ForgeAnomalySignal {
  id: string;
  kind: ForgeAnomalyKind;
  providerId: string;
  methodName: string;
  severity: ForgeAnomalySeverity;
  timestamp: number;
  recordIds: string[];
  zScore?: number;
  durationMs?: number;
  baselineMedianMs?: number;
  p95Ms?: number;
  clusterSize?: number;
  clusterWindow?: number;
}

/**
 * Audit health snapshot for the forge audit ring buffer. Anomaly detection is
 * suppressed below {@link FORGE_AUDIT_ANOMALY_MIN_RECORDS} records — forge
 * calls are lower-frequency than MCP dispatches, so the floor is lower (10 vs
 * 50) and accrues across sessions via the persisted ring.
 */
export interface ForgeAuditStats {
  anomalySignals: ForgeAnomalySignal[];
  anomalySuppressed: boolean;
  anomalyRecordFloor: number;
}

/** Anomaly suppression floor — lower than MCP's 50 because forge calls are low-frequency. */
export const FORGE_AUDIT_ANOMALY_MIN_RECORDS = 10;
