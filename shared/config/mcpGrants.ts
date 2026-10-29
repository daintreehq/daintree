import { HELP_TIER_CUMULATIVE } from "./helpAssistantTierAllowlists.js";
import { isGenericNativeGrantEligible } from "./nativeGrantUsePolicies.js";

// Grant limits live here rather than in the main-process MCP module so the
// Settings grant form can state them before the user approves (#14982). Main
// re-exports them from `electron/services/mcp-server/shared.ts`.

/**
 * Sliding-TTL window for per-tool grants minted via the tier-mismatch
 * banner's "Allow this tool", and the default for native grants. A grant
 * issued for `(sessionId, toolId)` permits that exact tool for this session
 * for the duration, and any successful dispatch through the grant refreshes
 * the window. Sized comfortably below the 30-minute SSE idle reaper so it can
 * never silently cut a grant short — see #8442.
 */
export const MCP_GRANT_TTL_MS = 15 * 60 * 1000;

/**
 * Hard wall-clock ceiling on a grant's total lifetime, measured from its
 * immutable `issuedAt`. The sliding {@link MCP_GRANT_TTL_MS} window means a
 * model that calls a granted tool more often than once per TTL could
 * otherwise hold the grant indefinitely; this caps the total refreshable
 * lifetime so `refresh()` is blocked and the grant is forcibly revoked once
 * the ceiling elapses, mirroring `sudo`'s max-lifetime enforcement — the
 * next out-of-baseline call then re-triggers the tier-mismatch banner and
 * the user must re-approve (#9161). Intentionally equal to the SSE idle
 * timeout and the tier-elevation TTL so a grant can never outlive its SSE
 * session. A pane bearer's session outlives both (#13635); the grant still
 * expires on its own clock.
 */
export const MCP_GRANT_MAX_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Default use ceiling for a native session-scoped automation grant (#10648)
 * when the renderer issues one without specifying `maxUses`. A native grant
 * authorizes its allowed tools for at most this many dispatches before it
 * exhausts and the user must re-approve.
 */
export const MCP_NATIVE_GRANT_DEFAULT_MAX_USES = 10;

/**
 * Hard bounds on the use ceiling a renderer may request when issuing a native
 * grant. Keeps a single approval from authorizing an unbounded run of
 * automated tool calls — past the ceiling the grant must be re-approved.
 */
export const MCP_NATIVE_GRANT_MIN_MAX_USES = 1;
export const MCP_NATIVE_GRANT_MAX_MAX_USES = 100;

/**
 * Maximum number of tools a single native grant may authorize. A grant is a
 * deliberate, inspectable scope — an unbounded allowlist would defeat the
 * point. Issuance rejects an allowlist larger than this.
 */
export const MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS = 20;

/**
 * Lower bound on a native grant's requested TTL. Below a minute a grant would
 * expire before the assistant could meaningfully use it; the upper bound is
 * {@link MCP_GRANT_MAX_LIFETIME_MS} so a native grant can never outlive its
 * SSE session, matching the per-tool grant ceiling.
 */
export const MCP_NATIVE_GRANT_MIN_TTL_MS = 60 * 1000;

/**
 * Every tool a native automation grant can name: the help-tier universe minus
 * the fan-out tools a use count cannot bound. Derived from the same two
 * sources `issueNativeGrant` checks, so the Settings form never offers a tool
 * main would refuse. Main still validates every request on its own.
 */
export const NATIVE_GRANT_TOOL_IDS: readonly string[] = [
  ...new Set(HELP_TIER_CUMULATIVE.full),
].filter(isGenericNativeGrantEligible);
