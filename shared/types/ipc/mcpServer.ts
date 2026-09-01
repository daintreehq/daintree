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
 * - `rate_limited`: legacy value, no longer emitted. The per-`(session,
 *   toolId)` token-bucket rate limiter was removed in #10764; this value is
 *   retained only so historical on-disk audit records (which carry it, with
 *   the wait in `resultMeta.retryAfter`) still render and classify.
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
  /**
   * When the record was written — the outcome-decision time, not the moment
   * the caller got its response. For the in-flight dedup gate that is when the
   * duplicate was detected, before the handler awaits the original promise.
   * Do not reconstruct the start as `timestamp - durationMs`: the two come
   * from different clock reads separated by the audit's own summarize/redact
   * work, so they disagree. Use {@link McpAuditRecord.startedAt} (#12122).
   */
  timestamp: number;
  /**
   * Epoch ms snapshotted once at CallTool-handler entry — the same value the
   * live {@link McpToolCallStartedPayload} carries, never a re-read. Lets a
   * reader order dispatches by true arrival and compute real overlap
   * (`startA < endB && startB < endA`) to tell whether an assistant backend
   * issues MCP calls concurrently or serially, which `durationMs` alone can't
   * answer (#12122).
   *
   * Present on every CallTool record including the gate outcomes
   * (unauthorized / dedup / collision) — those are real attempts the backend
   * made, so they count for concurrency. Presence does NOT imply the
   * underlying action ran; `result` is what says that. Absent on pre-auth
   * rejections (no handler exists yet) and on records written before the
   * field existed.
   */
  startedAt?: number;
  toolId: string;
  sessionId: string;
  /**
   * Public help-session id (the one persisted in the renderer's
   * `helpPanelStore`) when the dispatch came from an assistant bearer.
   * `sessionId` above is the per-connection MCP transport id, which the
   * renderer never sees — this field is the join the assistant panel's
   * recent-calls view and turn-outcome diagnostics filter on. Absent for
   * external/api-key sessions and for records written before the field
   * existed.
   */
  helpSessionId?: string;
  tier: string;
  argsSummary: string;
  /**
   * Redacted, bounded (1500-char) pretty-printed JSON of what the call
   * returned — or the error code + message for failed dispatches. Lets the
   * recent-calls popover show each call's actual output. Absent for gate
   * outcomes (unauthorized / dedup / collision) and old records. For
   * `rate_limited` the wait time travels in `resultMeta.retryAfter` (#10014).
   */
  resultSummary?: string;
  /**
   * Renderer-presented hints for gate outcomes that carry a meaningful
   * parameter the `result` label can't capture on its own. Currently set
   * only for `rate_limited` (`retryAfter`, integer seconds from the
   * `MCP_RATE_LIMITED_CODE` error). Absent on every other result, and on
   * old records written before the field existed (#10014).
   */
  resultMeta?: { retryAfter?: number };
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
 * - `grant.used`: a native session-scoped automation grant (#10648)
 *   authorized one tool dispatch and one use was consumed. `toolId` is the
 *   specific tool that consumed the use; `remainingUses` is the count left
 *   *after* the decrement. Distinct from a per-tool TTL grant, which has no
 *   use ceiling and emits no per-use record.
 * - `grant.exhausted`: a native grant's last use was consumed — a natural
 *   terminal lifecycle state, NOT a forced revocation (so it is deliberately
 *   a distinct record type rather than a {@link McpGrantRevokedReason}). The
 *   grant is deleted by record-write time; `toolId` is the tool whose call
 *   exhausted it.
 */
export type McpGrantRecordType =
  | "grant.issued"
  | "grant.expired"
  | "grant.revoked"
  | "grant.used"
  | "grant.exhausted"
  | "tier.elevated"
  | "tier.decayed";

/**
 * Identity class of the actor a native automation grant (#10648) was issued
 * to. Both are renderer-pinned internal bearers:
 * - `help-session`: the help-chat assistant panel (a full help session).
 * - `assistant-pane`: a `daintree-assistant` CLI pane bearer (#10647) pinned
 *   to its launching WebContents without being promoted to a help session.
 */
export type McpGrantActorType = "help-session" | "assistant-pane";

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
  /**
   * Stable UUID of the native automation grant (#10648) this record belongs
   * to. Set on `grant.issued`/`grant.used`/`grant.exhausted`/`grant.revoked`
   * for native grants; absent on per-tool "Approve once" grants and tier
   * records, so existing on-disk rows deserialize unchanged.
   */
  grantId?: string;
  /** Use ceiling a native grant was minted with. Native grants only. */
  maxUses?: number;
  /**
   * Uses left after this record's transition. On `grant.issued` it equals
   * `maxUses`; on `grant.used` it is the post-decrement count; on
   * `grant.exhausted` it is `0`. Native grants only.
   */
  remainingUses?: number;
  /** Public id of the actor the native grant was issued to. Native grants only. */
  actorId?: string;
  /** Actor identity class for a native grant. Native grants only. */
  actorType?: McpGrantActorType;
  /**
   * Dotted `BuiltInActionId`s a native grant authorizes. Carried on
   * `grant.issued`/`grant.revoked` (where `toolId` is `"*"`) so the audit
   * trail records the full approved scope. Native grants only.
   */
  allowedTools?: string[];
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
 * Runtime guard for the `type` discriminator on `McpGrantRecord`. The check
 * is intentionally the same as the main-process filter at
 * `electron/services/mcp-server/auditLog.ts` so renderer consumers and the
 * ring-buffer filter cannot drift on what counts as a grant record. The
 * legacy on-disk shape (no `type` field on `McpAuditRecord`) is load-bearing;
 * the discriminator must be a member of the literal `McpGrantRecordType`
 * union — a stringly-typed `type: "dispatch"` (or any other unknown
 * discriminator) on a hydrated dispatch record would otherwise be silently
 * reclassified as a grant and misrendered in the viewer (#10027).
 */
const GRANT_RECORD_TYPES: ReadonlySet<McpGrantRecordType> = new Set([
  "grant.issued",
  "grant.expired",
  "grant.revoked",
  "grant.used",
  "grant.exhausted",
  "tier.elevated",
  "tier.decayed",
]);

export function isGrantRecord(record: McpLogRecord): record is McpGrantRecord {
  return (
    typeof record === "object" &&
    record !== null &&
    "type" in record &&
    typeof (record as { type: unknown }).type === "string" &&
    GRANT_RECORD_TYPES.has((record as { type: string }).type as McpGrantRecordType)
  );
}

/**
 * Inverse of {@link isGrantRecord} — narrows to `McpAuditRecord` by
 * complement. Kept as a positive form so consumers can call it at the
 * prop boundary without writing `!isGrantRecord(r)` and reasoning about
 * the legacy no-`type` invariant at every site.
 */
export function isAuditRecord(record: McpLogRecord): record is McpAuditRecord {
  return !isGrantRecord(record);
}

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
  /** Native automation grant fields (#10648); absent for per-tool grants. */
  grantId?: string;
  maxUses?: number;
  remainingUses?: number;
  actorId?: string;
  actorType?: McpGrantActorType;
  allowedTools?: string[];
}

/**
 * Live event marking the start of an MCP tool dispatch, pushed to the pinned
 * help-session renderer so the Assistant panel can show an in-flight activity
 * strip (#9759). Emitted once per dispatch that actually enters the call path,
 * after the manifest entry is resolved (so `danger` is known) and before the
 * host-side confirmation wait. Pre-dispatch rejections (unauthorized, rate-limited,
 * dedup) do not emit — they settle in microseconds and would only flicker the
 * strip. Send is targeted to the minting WebContents, never broadcast.
 *
 * `argsSummary` is the same redacted single-level view persisted on
 * {@link McpAuditRecord} — raw argument values never cross the bridge.
 * `danger` is true when the resolved manifest entry is `danger: "confirm"`,
 * letting the strip show "awaiting confirmation" while the user decides.
 */
export interface McpToolCallStartedPayload {
  sessionId: string;
  toolId: string;
  argsSummary: string;
  startedAt: number;
  turnId?: string;
  danger: boolean;
}

/**
 * Live event marking the settlement of an MCP tool dispatch previously
 * announced by {@link McpToolCallStartedPayload}. Carries the audit-aligned
 * outcome fields so the activity strip can dim to a result glyph, show the
 * duration, and tint red on error. Send is targeted, never broadcast.
 */
export interface McpToolCallSettledPayload {
  sessionId: string;
  toolId: string;
  durationMs: number;
  result: McpAuditResult;
  errorCode?: string;
  severity: McpAuditSeverity;
  turnId?: string;
}

/**
 * Live event emitted when the assistant invokes the `help.displayImage` MCP
 * tool (#9828). The main process validates the URL against the daintree.org
 * allowlist and assigns `figureNumber` sequentially per help session, so the
 * model never picks its own number. The renderer keys figures by `imageId`
 * and references them inline as `[image #<figureNumber>]`. Send is targeted at
 * the pinned WebContents, never broadcast.
 */
export interface McpHelpDisplayImagePayload {
  sessionId: string;
  imageId: string;
  figureNumber: number;
  figureLabel: string;
  url: string;
  caption?: string;
  altText?: string;
}

/**
 * The subset of {@link TurnOutcomeClass} values that warrant a live, in-app
 * ambient signal in the Assistant panel (#10018). Both are silent
 * "needs-a-look" outcomes the user would otherwise only find by opening the
 * Settings diagnostics tab: the watchdog-driven `agent-stuck` and the
 * tight-tool-call-loop `reasoning-loop`. Narrowed via `Extract` so the alert
 * channel and pip can never carry a non-alertable outcome.
 */
export type TurnOutcomeAlertClass = Extract<TurnOutcomeClass, "agent-stuck" | "reasoning-loop">;

/**
 * Live event pushed to the pinned help-session renderer when a turn for that
 * session classifies as `agent-stuck` or `reasoning-loop` (#10018). Drives the
 * Assistant footer's ambient outcome pip — a Tier 1 indicator, never a toast.
 * Targeted at the WebContents that minted the session's bearer, never
 * broadcast. `turnId` is the turn the outcome was recorded for (absent for
 * `agent-stuck`, whose turn id is already cleared by the time the watchdog
 * fires); the renderer uses it to auto-clear the pip when a fresh turn begins.
 */
export interface McpTurnOutcomeAlertPayload {
  helpSessionId: string;
  outcome: TurnOutcomeAlertClass;
  turnId?: string;
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

/**
 * Result of a renderer-driven `issueNativeGrant` IPC (#10648). A native
 * session-scoped automation grant authorizes a bounded set of tools for the
 * pinned assistant session for a limited number of uses, without a per-call
 * modal. Returns the minted grant id and its scope/limit fields so the
 * renderer can render the grant card (allowed tools, remaining uses,
 * countdown) without polling.
 */
export interface McpIssueNativeGrantResult {
  grantId: string;
  sessionId: string;
  actorId: string;
  actorType: McpGrantActorType;
  allowedTools: string[];
  maxUses: number;
  remainingUses: number;
  ttlMs: number;
  expiresAt: number;
}

/**
 * Result of a renderer-driven `revokeNativeGrant` IPC (#10648). `revoked` is
 * true when a matching native grant existed for the caller's session and was
 * dropped; false when the grant id was already gone (exhausted, expired, or
 * torn down with the session) so a dismissal cleanup is an idempotent no-op.
 */
export interface McpRevokeNativeGrantResult {
  grantId: string;
  revoked: boolean;
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
  "latency-drift" | "first-seen-combination" | "failure-cluster" | "p95-z-score";

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
 * Read-only inventory of one renderer-pinned internal bearer — Daintree's own
 * MCP consumers (the help-chat assistant and in-panel agents, i.e. any
 * non-`external` tier) — surfaced as a separate "Internal connections" section
 * on the MCP Server settings tab (#10036). These bearers are deliberately
 * excluded from {@link ActiveBearerRecord}/the External clients row (#9151) —
 * this type gives the user passive visibility into them without offering a
 * disconnect control (they are severed via their owning surface, not here).
 *
 * Carries display fields only: no `tokenHash` (there is no disconnect action to
 * target) and no `token4LastChars` (the bearer suffix identifies an internal
 * credential and stays main-side, per #9318). `sessionCount` is the number of
 * live MCP transport sessions this bearer currently owns.
 */
export interface HelpSessionBearerRecord {
  userAgent: string;
  lastActiveAt: number;
  requestsSinceLaunch: number;
  sessionCount: number;
}

/**
 * How a session's bearer was authenticated, recorded explicitly at handshake
 * (#11789). Before this, "which renderer owns this session" was inferred from
 * presence in `sessionWebContentsMap` — but that map is simultaneously the
 * routing table and the authorization gate for `issueGrant` / `setSessionTier`,
 * so binding an external session to a workspace would have made it eligible for
 * renderer-driven privilege elevation it must never have.
 *
 * Routing reads the WebContents / workspace maps. Authorization, notifications
 * and external-client inventory read this. `external` covers api-key bearers,
 * unauthenticated loopback, and generic pane tokens — everything that is not one
 * of Daintree's own assistant surfaces.
 *
 * Lives here rather than in `electron/services/mcp-server/shared.ts` (which
 * re-exports it) because it now crosses the contextBridge on every dispatch
 * request, so the renderer can tell an assistant-launched run from an external
 * one (#11808). Mirroring it renderer-side instead would leave two unions free
 * to drift, silently reclassifying a surface as external the day they did.
 *
 * The same two Daintree-own surfaces this splits out are the ones
 * {@link McpGrantActorType} names; that type classifies who a grant was issued
 * to, this one classifies how the session itself authenticated.
 */
export type McpSessionOrigin = "help" | "assistant-pane" | "external";

/**
 * Display-only provenance for the external bearer behind a `danger: "confirm"`
 * dispatch, threaded into the MCP confirm dialog so the user can see which
 * client is asking before approving (#9157). Carries only the non-sensitive
 * fields — the 4-char token suffix and the client user-agent. Absent for
 * pinned help-session dispatch (the assistant's own panel is the context), so
 * the dialog stays provenance-free there.
 *
 * Distinct from {@link McpSessionOrigin}, which rides the same payload: this
 * names *which external client* is asking, for a pre-dispatch approval prompt;
 * that records *which class of surface* the session is, for post-dispatch run
 * provenance. An assistant session has no meaningful `callerInfo` and still has
 * an origin.
 */
export interface McpBearerIdentity {
  token4LastChars: string;
  userAgent: string;
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
