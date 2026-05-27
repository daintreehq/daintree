/**
 * Result classification for an MCP tool dispatch.
 *
 * - `success`: dispatch resolved with `{ ok: true }`.
 * - `error`: dispatch threw, timed out, or resolved with `{ ok: false }` for
 *   any reason other than a missing confirmation.
 * - `confirmation-pending`: dispatch resolved with the canonical
 *   `CONFIRMATION_REQUIRED` error code — surfaced separately so audit
 *   readers can distinguish "agent forgot `_meta.confirmed`" from a real
 *   failure.
 * - `unauthorized`: the session's tier was not permitted to invoke the
 *   action — the dispatch was rejected before reaching the renderer. Carries
 *   `errorCode: "TIER_NOT_PERMITTED"`.
 * - `dedup`: a duplicate creation-tool call was suppressed by the
 *   per-session idempotency guard and the cached or in-flight result was
 *   returned. No second dispatch was performed.
 * - `rate_limited`: the per-`(session, toolId)` token bucket was exhausted
 *   and the call was rejected before dispatch with a `retryAfter` hint. No
 *   dispatch was performed — this is a runaway-loop guard, not a failure.
 */
export type McpAuditResult =
  | "success"
  | "error"
  | "confirmation-pending"
  | "unauthorized"
  | "dedup"
  | "collision"
  | "rate_limited";

/**
 * Persisted audit record for a single MCP tool dispatch. Written once per
 * `CallToolRequestSchema` invocation regardless of outcome.
 *
 * `argsSummary` is a redacted, single-level JSON-encoded view of the call
 * arguments — long strings are replaced with `<string: N chars>` and nested
 * objects are collapsed to `<object>`. Raw argument values are never
 * persisted because tool args may carry terminal output, file content, or
 * prompt text.
 *
 * `tier` records the source-tier classification of the connection that
 * issued the call (`workbench`, `action`, `system`, `external`). Sessions
 * that are not yet stamped fall back to `"workbench"` — the most
 * restrictive tier — so an unstamped session can never elevate access.
 */
/**
 * Outcome of a user-facing confirmation modal for `danger: "confirm"` MCP
 * dispatches. Set only when the renderer actually surfaced a modal — direct
 * agent-confirmed dispatches and safe actions leave this undefined.
 *
 * - `approved`: user clicked the destructive confirm button.
 * - `rejected`: user closed the modal or clicked cancel.
 * - `timeout`: modal aged out without a decision (mirrors the renderer's
 *   confirmation timer, which fires before the main-process dispatch
 *   timer).
 */
export type McpConfirmationDecision = "approved" | "rejected" | "timeout";

/**
 * Audit-record severity tier. Derived from the dispatch result at record-write
 * time so readers can triage without re-deriving from errorCode + result.
 *
 * - `info`: success or dedup — nominal dispatch.
 * - `notice`: confirmation-pending — gate waiting on user approval.
 * - `warning`: tier-rejected or rate-limited — legit user action blocked
 *   by policy.
 * - `error`: dispatch threw, timed out, or returned an error other than
 *   confirmation-pending/unauthorized.
 * - `critical`: reserved for systemic failures (not yet emitted).
 */
export type McpAuditSeverity = "info" | "notice" | "warning" | "error" | "critical";

export const MCP_AUDIT_SCHEMA_VERSION = 1;

const SEVERITY_BY_RESULT: Record<McpAuditResult, McpAuditSeverity> = {
  success: "info",
  dedup: "info",
  "confirmation-pending": "info",
  unauthorized: "error",
  error: "error",
  collision: "warning",
  rate_limited: "warning",
};

const SEVERITY_BY_ERROR_CODE: Record<string, McpAuditSeverity> = {
  USER_REJECTED: "warning",
  CONFIRMATION_TIMEOUT: "warning",
  CONFIRMATION_REQUIRED: "info",
  TIER_NOT_PERMITTED: "error",
  ELICITATION_FAILED: "error",
  PRE_AUTH_FAILED: "error",
  EXECUTION_ERROR: "critical",
  DISPATCH_THREW: "critical",
};

export function computeMcpAuditSeverity(
  result: McpAuditResult,
  errorCode?: string
): McpAuditSeverity {
  if (errorCode !== undefined && errorCode in SEVERITY_BY_ERROR_CODE) {
    return SEVERITY_BY_ERROR_CODE[errorCode]!;
  }
  return SEVERITY_BY_RESULT[result];
}

export interface McpAuditRecord {
  id: string;
  timestamp: number;
  toolId: string;
  sessionId: string;
  tier: string;
  argsSummary: string;
  result: McpAuditResult;
  errorCode?: string;
  durationMs: number;
  confirmationDecision?: McpConfirmationDecision;
  /**
   * For `unauthorized` outcomes, the lowest help-session tier that would have
   * permitted the dispatch — `workbench`, `action`, or `system`. Set at
   * record-write time from the static `TIER_ALLOWLISTS`. `null` means the
   * tool isn't permitted at any tier (unknown tool). Optional and absent on
   * non-unauthorized outcomes.
   */
  tierHint?: "workbench" | "action" | "system" | null;
  /**
   * For `unauthorized` outcomes only, true when the renderer banner was
   * suppressed for this denial because the per-`(sessionId, toolId)`
   * consecutive-denial counter had reached `MCP_DENIAL_SILENCE_THRESHOLD`.
   * The audit record is still written so persistent denials remain visible
   * in the audit panel even when no banner fired. See #8442.
   */
  bannerSuppressed?: boolean;
  /**
   * Stable correlation ID for the assistant turn this dispatch belongs to.
   * Minted at the `active` FSM transition boundary in `TurnOutcomeService`
   * and stamped on every audit record written within that turn window.
   * Absent on pre-auth rejections and dispatches outside a turn boundary.
   */
  turnId?: string;
  /** Schema version for forward-compat. New records always carry the current version. */
  schemaVersion: number;
  /** Derived severity so readers can triage without re-deriving from result/errorCode. */
  severity: McpAuditSeverity;
  /** Number of times this event repeated within the coalesce window. Absent when the event occurred once. */
  repeatCount?: number;
}

/**
 * Lifecycle event for a per-`(sessionId, toolId)` grant minted via the
 * "Approve once" flow that replaces sticky session-tier elevation (#8442).
 * Written in parallel with the dispatch audit ring buffer; renderers
 * subscribe to a separate live broadcast for the same payload shape.
 *
 * - `grant.issued`: the renderer's `Approve once` minted a fresh grant.
 *   `expiresAt` is set; `revokedReason` is absent.
 * - `grant.expired`: a `check()` lazily evicted an entry whose `expiresAt`
 *   passed. Emitted at most once per `(sessionId, toolId)` per grant. The
 *   periodic sweep also drives this when an idle session's grant ages out
 *   without a follow-up read.
 * - `grant.revoked`: an explicit `revokeSessionGrants` IPC, a session
 *   teardown, an idle reaper firing, or the hard max-lifetime ceiling being
 *   reached wiped the grant before its sliding TTL elapsed. `revokedReason`
 *   distinguishes those sources.
 * - `tier.elevated`: a renderer-approved session-tier elevation
 *   (`HttpLifecycle.setSessionTier`) raised the session above its
 *   token-resolved baseline. `tier` is the new tier, `previousTier` the
 *   pre-elevation tier, `ttlMs`/`expiresAt` the bounded elevation window.
 *   `toolId` is `"*"` — the elevation is session-scoped, not tool-scoped.
 * - `tier.decayed`: a bounded elevation aged out (`SessionStore.decayTier`)
 *   and the session silently fell back to its baseline. `tier` is the
 *   baseline it decayed to, `previousTier` the elevated tier it left.
 */
export type McpGrantRecordType =
  | "grant.issued"
  | "grant.expired"
  | "grant.revoked"
  | "tier.elevated"
  | "tier.decayed";

/**
 * Source of a `grant.revoked` transition.
 * - `user`: explicit user-initiated revoke.
 * - `session-ended`: the session was torn down.
 * - `session-idle`: the idle reaper collected the session.
 * - `grant-ceiling`: the hard max-lifetime ceiling from `issuedAt` elapsed
 *   while the grant was still being actively refreshed; the user must
 *   re-approve (#9161). Distinct from `grant.expired`, which is a passive
 *   sliding-TTL timeout with no recent use.
 */
export type McpGrantRevokedReason = "user" | "session-ended" | "session-idle" | "grant-ceiling";

export interface McpGrantRecord {
  type: McpGrantRecordType;
  id: string;
  timestamp: number;
  sessionId: string;
  toolId: string;
  /** TTL the grant was minted with, in milliseconds. */
  ttlMs: number;
  /**
   * Absolute epoch millis when the grant would expire without refresh.
   * Set on `grant.issued`; absent on `grant.expired`/`grant.revoked` (the
   * grant has already been deleted by record-write time).
   */
  expiresAt?: number;
  /** Source of the revocation; only set on `grant.revoked`. */
  revokedReason?: McpGrantRevokedReason;
  /**
   * Tier context for `tier.elevated`/`tier.decayed` records. `tier` is the
   * tier the session moved *to* (the elevated tier on elevation, the
   * baseline on decay); `previousTier` is the tier it moved *from*. Both are
   * absent on the `grant.*` variants so existing on-disk rows deserialize
   * unchanged. Typed as `string` to keep this shared shape free of the
   * main-process `McpTier` union.
   */
  tier?: string;
  previousTier?: string;
}

/**
 * Union of all records persisted to the MCP server's ring buffer. Existing
 * `McpAuditRecord` entries are implicitly the `dispatch` kind — they have
 * no `type` field — and predate this union; the discriminator lives only
 * on `McpGrantRecord` to keep the legacy on-disk shape unchanged. Readers
 * narrow with `"type" in record` rather than a typeof check on a missing
 * field.
 */
export type McpLogRecord = McpAuditRecord | McpGrantRecord;

/**
 * Live event payload broadcast to the pinned renderer for a grant
 * transition. Mirrors `McpGrantRecord` because renderers want the same
 * fields they'd see in the audit log. Send is targeted (never broadcast)
 * because grant state is session-scoped.
 */
export interface McpGrantLifecyclePayload {
  type: McpGrantRecordType;
  sessionId: string;
  toolId: string;
  ttlMs: number;
  expiresAt?: number;
  revokedReason?: McpGrantRevokedReason;
}

/**
 * Result of a renderer-driven `revokeSessionGrants` IPC. The handler
 * deletes every grant for the named session and reports how many entries
 * were affected — useful for UI confirmation copy ("Revoked N grants").
 */
export interface McpRevokeSessionGrantsResult {
  sessionId: string;
  revokedCount: number;
}

/**
 * Result of a renderer-driven `issueGrant` IPC. Returns the `expiresAt`
 * and `ttlMs` so the renderer can render a countdown without polling.
 */
export interface McpIssueGrantResult {
  sessionId: string;
  toolId: string;
  ttlMs: number;
  expiresAt: number;
}

/** Minimum and maximum values accepted for the configurable ring-buffer cap. */
export const MCP_AUDIT_MIN_RECORDS = 50;
export const MCP_AUDIT_MAX_RECORDS = 10000;
export const MCP_AUDIT_DEFAULT_MAX_RECORDS = 500;

/**
 * Session-scoped audit health counters. Reset on app restart by design —
 * these capture "since-launch" signals that complement the persisted
 * audit-record ring buffer.
 *
 * - `auth401Count`: number of MCP HTTP requests rejected with `401
 *   Unauthorized` since the current process started. Increments cover the
 *   missing-bearer, malformed-bearer, and revoked-bearer paths uniformly —
 *   none of which reach `appendRecord` because no `toolId`/`tier` is known
 *   when authentication fails.
 */
export interface McpAuditStats {
  auth401Count: number;
  anomalySignals: McpAnomalySignal[];
  anomalySuppressed: boolean;
  anomalyRecordFloor: number;
}

export type McpAnomalySeverity = "danger";

export type McpAnomalyKind =
  | "latency-drift"
  | "first-seen-combination"
  | "failure-cluster"
  | "p95-z-score";

export interface McpAnomalySignal {
  id: string;
  kind: McpAnomalyKind;
  toolId: string;
  tier?: string;
  severity: McpAnomalySeverity;
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
 * Outcome classification for a single assistant turn (one `active → passive`
 * FSM transition for an MCP-bound help session, or a pre-turn failure such
 * as `mcp-not-ready`). The waterfall below is the deterministic priority
 * applied by the classifier — earlier classes win when multiple signals are
 * present.
 *
 * - `tier-rejected`: a tool dispatch in the same session was blocked because
 *   the session's tier was not permitted to invoke it.
 * - `mcp-not-ready`: the in-process MCP server was not ready at provision
 *   time; the help session never reached a turn boundary.
 * - `agent-stuck`: the watchdog fired a `waiting → idle` timeout — the
 *   agent went silent without resolving its turn.
 * - `tool-error`: the most recent tool dispatch in this session resolved
 *   with `result: "error"` (and is not a tier rejection).
 * - `reasoning-loop`: the agent called the same tool with the same arguments
 *   at least 3 times within the turn window — a tight tool-call loop not
 *   covered by the watchdog-driven `agent-stuck` class.
 * - `refused`: the agent's recent output indicates it declined to act.
 * - `hedged`: the agent expressed uncertainty without producing a concrete
 *   answer.
 * - `docs-empty`: the agent reported it could not find the requested
 *   documentation or results.
 * - `hibernate-resume-stale`: an attempted `--resume` produced no prior
 *   conversation, so the session started without context.
 * - `answered`: the turn produced output and matched no failure pattern
 *   (the success default).
 * - `unknown`: classification fell through every rule (e.g. empty buffer);
 *   used as the explicit fallback rather than skipping the record.
 */
export type TurnOutcomeClass =
  | "answered"
  | "hedged"
  | "refused"
  | "docs-empty"
  | "tier-rejected"
  | "mcp-not-ready"
  | "agent-stuck"
  | "tool-error"
  | "reasoning-loop"
  | "hibernate-resume-stale"
  | "unknown";

/**
 * Persisted record for one assistant turn outcome. Written once per
 * `active → passive` FSM transition for an MCP-bound help session, or
 * synchronously at the failure site for pre-turn failures (`mcp-not-ready`).
 *
 * `terminalId` is the primary correlation key; `sessionId` is best-effort
 * (resolved from the `HelpSessionService` terminal↔session map at write
 * time) and may be null when the terminal is not currently bound to a
 * help session — e.g. for `mcp-not-ready` failures where provisioning
 * failed before any spawn.
 *
 * `trigger` records the FSM trigger that caused the boundary
 * (`output`, `timeout`, `activity`, …) so audit readers can distinguish
 * a watchdog-driven `agent-stuck` from a normal output-driven turn end.
 */
export interface AssistantTurnRecord {
  id: string;
  timestamp: number;
  terminalId: string | null;
  sessionId: string | null;
  outcome: TurnOutcomeClass;
  trigger?: string;
  /** Most recent agent state at the time the record was written. */
  state?: string;
  /** Previous state if this record was triggered by an FSM transition. */
  previousState?: string;
  /** Free-text diagnostic for non-classified failures (e.g. mcp-not-ready reason). */
  detail?: string;
  /**
   * Stable correlation ID shared with `McpAuditRecord.turnId` for every
   * dispatch inside this turn window. Minted at the `active` FSM transition
   * boundary and absent on pre-turn failures (`mcp-not-ready`).
   */
  turnId?: string;
}

/**
 * Coarse readiness state surfaced to the renderer for the in-process MCP
 * server. Distinct from the boolean `running` flag emitted by
 * `onStatusChange` because the renderer needs to distinguish "the user
 * disabled it" from "it's still starting" from "the bind failed and we
 * gave up after backoff" — all of which collapse to `running=false`.
 *
 * - `disabled`: persisted `enabled` flag is false; the server is not
 *   intended to run.
 * - `starting`: enabled but the listening socket is not yet bound (cold
 *   boot, deferred startup in flight, or an in-progress restart).
 * - `ready`: bound, listening, and accepting connections.
 * - `failed`: enabled but the most recent start attempt failed (port
 *   exhaustion, OS error, restart-budget exhausted). `lastError` carries
 *   the diagnostic message.
 */
export type McpRuntimeState = "disabled" | "starting" | "ready" | "failed";

export interface McpRuntimeSnapshot {
  enabled: boolean;
  state: McpRuntimeState;
  port: number | null;
  /** Most recent failure reason, if any. Cleared on successful start. */
  lastError: string | null;
}

/**
 * Compact status snapshot returned by the synchronous `mcp-server:get-status`,
 * `mcp-server:set-enabled`, and `mcp-server:set-port` IPC channels. Distinct
 * from {@link McpRuntimeSnapshot} (which carries the coarse readiness state
 * surfaced via the async event stream): this shape conveys just the persisted
 * configuration plus the currently bound port.
 */
export interface McpServerStatusSnapshot {
  enabled: boolean;
  port: number | null;
  configuredPort: number | null;
  apiKey: string;
}

/**
 * Descriptor for one externally-connected MCP client, returned by
 * `mcp-server:list-active-clients`. Powers the Tier-D2 confirmation that
 * names the clients about to be severed when the user disables the server
 * (#8779). Only sessions classified as `external` (api-key bearer or
 * unauthenticated loopback) are listed — renderer-pinned help-session
 * bearers and pane tokens are Daintree's own internal consumers and would
 * be recursive to name in a dialog the user is using to turn them off.
 *
 * `userAgent` is the raw `User-Agent` header captured at handshake (Claude
 * Code, Cursor, a custom script…), or `null` when the client sent none.
 * `connectedAtMs` is the wall-clock epoch the session handshook so the
 * renderer can render a relative "connected N minutes ago".
 */
export interface McpActiveClientInfo {
  sessionId: string;
  userAgent: string | null;
  connectedAtMs: number;
  transport: "sse" | "streamable-http";
}

/**
 * Live snapshot of one bearer token currently connected to the local MCP
 * server, surfaced on the MCP Server settings tab. Tracked per-token in a
 * register separate from the audit ring buffer — the audit log is an event
 * history, this is the current-connection view.
 *
 * `tokenHash` is the SHA-256 of the full `Authorization` header and is the
 * stable identity used to target {@link disconnectBearer}; the raw token is
 * never exposed across IPC. `token4LastChars` is the display-only suffix.
 * `requestsSinceLaunch` counts new session handshakes for this bearer since
 * the server last started (reset on restart), not per-message traffic.
 */
export interface ActiveBearerRecord {
  tokenHash: string;
  token4LastChars: string;
  userAgent: string;
  lastActiveAt: number;
  requestsSinceLaunch: number;
}

/**
 * Result of a renderer-driven `disconnectBearer` IPC. `disconnected` is true
 * when a matching bearer entry existed and its sessions were revoked — false
 * when the token hash was already absent (e.g. the client disconnected first).
 */
export interface DisconnectBearerResult {
  tokenHash: string;
  disconnected: boolean;
}
