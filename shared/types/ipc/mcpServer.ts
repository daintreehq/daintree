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
 */
export type McpAuditResult = "success" | "error" | "confirmation-pending" | "unauthorized";

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
}

/** Minimum and maximum values accepted for the configurable ring-buffer cap. */
export const MCP_AUDIT_MIN_RECORDS = 50;
export const MCP_AUDIT_MAX_RECORDS = 10000;
export const MCP_AUDIT_DEFAULT_MAX_RECORDS = 500;
