import { randomUUID } from "node:crypto";
import { app } from "electron";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { getAgentAvailabilityStore } from "../AgentAvailabilityStore.js";
import { events } from "../events.js";
import type { AuditOutcome } from "./auditLog.js";
import type {
  McpTier,
  ParsedResourceUri,
  PromptDefinition,
  PromptRenderContext,
  DispatchEnvelope,
} from "./shared.js";
import {
  PROMPT_DEFINITIONS,
  PROMPT_TERMINAL_OUTPUT_MAX_CHARS,
  RESOURCE_SCROLLBACK_TAIL_LINES,
  parseResourceUri,
  serializeResourcePayload,
  unwrapDispatchResult,
  truncateText,
  readStringField,
  RESOURCE_BACKING_ACTIONS,
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  MCP_DEDUP_ALLOWLIST,
  MCP_DEDUP_TTL_MS,
  MCP_DEDUP_MAX_ENTRIES_PER_SESSION,
  MCP_DEDUP_KEY_COLLISION_CODE,
  minimumPermittingTier,
  EXECUTION_ERROR_CODE,
  SESSION_BINDING_GONE,
  INVALID_URL_CODE,
  buildToolError,
  buildMcpErrorPayload,
  withResolvedWorkspace,
  type DispatchedWorkspaceRef,
} from "./shared.js";
import {
  INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
} from "../../../shared/types/terminalWaitUntilIdle.js";
import { SessionBindingError, RendererBridgeUnavailableError } from "./rendererBridge.js";
import {
  buildDedupKey,
  canonicalArgsHash,
  readDedupCache,
  type CallToolResultLike,
} from "./sessionDedup.js";
import {
  shouldExposeTool,
  isTierPermitted,
  buildToolInputSchema,
  buildAnnotations,
  buildToolOutputSchema,
  buildStructuredContent,
  parseToolArguments,
} from "./tierAuth.js";
import { buildToolCallResult } from "./toolCallResult.js";

const TERMINAL_WAIT_UNTIL_IDLE_TOOL = "terminal.waitUntilIdle";
const TERMINAL_WAIT_UNTIL_IDLE_BATCH_TOOL = "terminal.waitUntilIdleBatch";
const HELP_DISPLAY_IMAGE_TOOL = "help.displayImage";
const BROWSER_CAPTURE_SCREENSHOT_TOOL = "browser.captureScreenshot";
const SKILLS_SEARCH_TOOL = "skills.search";
const SKILLS_LOAD_TOOL = "skills.load";

/**
 * Narrow a `browser.captureScreenshot` result to its base64-PNG payload so the
 * tool response can carry a real MCP `image` content block (the generic path
 * only ever text-serializes results). Guarded structurally rather than trusting
 * the action id alone.
 */
function asScreenshotResult(
  result: unknown
): { pngBase64: string; width: number; height: number } | null {
  if (
    result !== null &&
    typeof result === "object" &&
    typeof (result as { pngBase64?: unknown }).pngBase64 === "string" &&
    typeof (result as { width?: unknown }).width === "number" &&
    typeof (result as { height?: unknown }).height === "number"
  ) {
    return result as { pngBase64: string; width: number; height: number };
  }
  return null;
}
import type { SessionStore } from "./sessionStore.js";

/**
 * Validate a `help.displayImage` URL (#9828). Only `https://daintree.org` and
 * its subdomains are accepted; `data:`/`blob:`/other-host URLs are rejected so
 * the assistant can't smuggle arbitrary content into the panel. The explicit
 * `data:`/`blob:` pre-check gives a clearer message than the generic
 * protocol failure (`new URL("data:...")` parses with `protocol === "data:"`).
 */
export function validateDisplayImageUrl(
  url: string
): { valid: true } | { valid: false; message: string } {
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    return {
      valid: false,
      message: "data: and blob: URIs are not permitted; provide an https://daintree.org URL.",
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, message: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "https:") {
    return {
      valid: false,
      message: `Only https: URLs are accepted; got '${parsed.protocol}'.`,
    };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "daintree.org" && !hostname.endsWith(".daintree.org")) {
    return {
      valid: false,
      message: `URL host must be daintree.org (or a subdomain); got '${parsed.hostname}'.`,
    };
  }
  // Reject non-default ports: the CSP `img-src https://daintree.org` matches
  // port 443 only, so a non-standard port would pass validation here but get
  // blocked at render time — a success/render mismatch the model can't recover
  // from. `URL.port` is "" when the default 443 was used.
  if (parsed.port !== "" && parsed.port !== "443") {
    return {
      valid: false,
      message: `Only the default https port is accepted; got port '${parsed.port}'.`,
    };
  }
  return { valid: true };
}

export interface SessionServerDeps {
  sessionStore: SessionStore;
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchAction: (
    actionId: string,
    args: unknown,
    confirmed?: boolean
  ) => Promise<DispatchEnvelope>;
  handleWaitUntilIdle: (
    rawArgs: unknown,
    signal: AbortSignal,
    options?: { maxTimeoutMs?: number }
  ) => Promise<import("./shared.js").WaitUntilIdleResult>;
  handleWaitUntilIdleBatch: (
    rawArgs: unknown,
    signal: AbortSignal,
    options?: { maxTimeoutMs?: number }
  ) => Promise<import("../../../shared/types/terminalWaitUntilIdle.js").WaitUntilIdleBatchResult>;
  /**
   * Execute `skills.search` in the main process (#10892). The renderer holds no
   * skill data (parsed plugin markdown lives in the main-process registry), so
   * this tool short-circuits renderer dispatch — same rationale as
   * `handleWaitUntilIdle`. Throws {@link McpError} on invalid args.
   */
  handleSkillsSearch: (
    rawArgs: unknown
  ) => import("../../../shared/types/skills.js").SkillSearchResult;
  /**
   * Execute `skills.load` in the main process (#10892). Throws {@link McpError}
   * on invalid args or an unknown skill id.
   */
  handleSkillsLoad: (rawArgs: unknown) => import("../../../shared/types/skills.js").SkillLoadResult;
  appendAuditRecord: (input: {
    toolId: string;
    sessionId: string;
    tier: McpTier;
    args: unknown;
    durationMs: number;
    outcome: AuditOutcome;
    confirmationDecision?: import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision;
    bannerSuppressed?: boolean;
    /**
     * Turn id snapshotted once at dispatch start (#10067). Forwarded so the
     * audit record is stamped with the same turn the live activity strip's
     * started/settled events carry — never re-read at write time, where an
     * active→passive FSM transition could have cleared it and split one call
     * across two groupings.
     */
    capturedTurnId?: string | null;
  }) => void;
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  /**
   * Optional renderer notifier fired when a help-session tool call is denied
   * because the session tier doesn't permit it. Implemented by httpLifecycle
   * for help-session bearers (pinned WebContents); absent for external/api-key
   * sessions, which have no associated UI.
   */
  notifyTierMismatch?: (payload: {
    sessionId: string;
    toolId: string;
    tier: McpTier;
    /**
     * Minimum tier that permits the denied tool, or `null` if no tier permits
     * it (unknown tool). The renderer uses this to label the elevation buttons
     * — "Allow Action tier" / "Allow System tier" — and to drive the
     * `setSessionTier` call.
     */
    targetTier: "workbench" | "action" | "system" | null;
  }) => void;
  /**
   * Feed a denial into the abuse policy — both 401s and tier-mismatches
   * share the same per-session sliding-window counter. Returns
   * `{ tripped: true }` when the threshold is exceeded. Implemented by
   * httpLifecycle; absent in test fixtures that don't wire the policy.
   */
  recordDenial?: (sessionId: string, kind: "auth401" | "tierMismatch") => { tripped: boolean };
  /**
   * Optional renderer notifier fired when a session is revoked by the abuse
   * policy. Follows the same pinned-WebContents pattern as
   * `notifyTierMismatch` so only help-session bearers surface the
   * notification. External / api-key sessions have no associated UI so the
   * callback is a no-op.
   */
  notifySessionRevoked?: (payload: {
    sessionId: string;
    denialKind: string;
    /** Saved before revokeSession clears the map, so the callback can route. */
    pinnedWebContentsId?: number;
  }) => void;
  /**
   * Remove a session from the abuse policy state so a reconnected session
   * doesn't inherit stale counters. Called after revokeSession and drain().
   */
  clearDenialState?: (sessionId: string) => void;
  /**
   * Resolve the help-session turn id live (#10067). Called exactly once per
   * dispatch — at the top of the CallTool handler — so a single snapshot feeds
   * the started event, the settled event, and the audit record. Returns `null`
   * for sessions with no help binding (external/api-key) or no active turn.
   * Implemented by httpLifecycle (it closes over the help-session id); absent
   * in test fixtures that don't exercise turn correlation.
   */
  getCurrentTurnId?: () => string | null;
  /**
   * Optional renderer notifier fired when an MCP tool dispatch enters the call
   * path (after tier/rate/dedup guards pass and the manifest entry resolves).
   * Drives the Assistant panel's live activity strip (#9759). Implemented by
   * httpLifecycle for help-session bearers (pinned WebContents) — it computes
   * the redacted `argsSummary` and resolves the `turnId` before the targeted
   * send. Absent for external/api-key sessions, which have no associated UI.
   */
  notifyToolCallStarted?: (payload: {
    sessionId: string;
    toolId: string;
    args: unknown;
    startedAt: number;
    /** True when the resolved manifest entry is `danger: "confirm"`. */
    danger: boolean;
    /** Turn id snapshotted at dispatch start (#10067); see {@link SessionServerDeps.getCurrentTurnId}. */
    capturedTurnId: string | null;
  }) => void;
  /**
   * Optional renderer notifier fired when a dispatch announced via
   * {@link SessionServerDeps.notifyToolCallStarted} settles. Receives the same
   * `AuditOutcome` the audit record is written from so the strip's result glyph
   * and severity match the audit log exactly (#9759).
   */
  notifyToolCallSettled?: (payload: {
    sessionId: string;
    toolId: string;
    durationMs: number;
    outcome: AuditOutcome;
    /** Turn id snapshotted at dispatch start (#10067); matches the started event's value. */
    capturedTurnId: string | null;
  }) => void;
  /**
   * Optional renderer notifier fired when the assistant invokes
   * `help.displayImage` (#9828). Pushes the validated image URL and the
   * session-assigned figure number to the pinned WebContents so the Assistant
   * panel can render the figure inline. Implemented by httpLifecycle for
   * help-session bearers; absent for external/api-key sessions (which can't
   * call the tool — it's outside their allowlist — so it never fires for them).
   */
  notifyDisplayImage?: (payload: {
    sessionId: string;
    imageId: string;
    figureNumber: number;
    figureLabel: string;
    url: string;
    caption?: string;
    altText?: string;
  }) => void;
}

export function createSessionServer(sessionId: string, deps: SessionServerDeps): Server {
  const {
    sessionStore,
    requestManifest,
    dispatchAction,
    handleWaitUntilIdle: waitUntilIdle,
    handleWaitUntilIdleBatch: waitUntilIdleBatch,
    handleSkillsSearch,
    handleSkillsLoad,
    appendAuditRecord,
    getCachedManifest,
    notifyTierMismatch,
    recordDenial,
    notifySessionRevoked,
    clearDenialState,
    getCurrentTurnId,
    notifyToolCallStarted,
    notifyToolCallSettled,
    notifyDisplayImage,
  } = deps;

  const server = new Server(
    { name: "Daintree", version: app.getVersion() },
    {
      capabilities: {
        // `listChanged: true` is required for clients to process the
        // `notifications/tools/list_changed` we send when a session's tier
        // elevates or decays (#8462). Must be declared at construction —
        // the SDK rejects post-connect capability registration in ^1.20+.
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: false },
        prompts: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Prefer a live fetch so runtime action-set changes (plugin enable/disable)
    // are reflected. On failure (renderer bridge unavailable / timed out /
    // destroyed) fall back to the last-known cached manifest instead of failing
    // the whole tools/list (#9892). For pinned sessions (#7003) getCachedManifest
    // always returns null, so they correctly fail closed rather than serve
    // another window's tool surface. `=== null` (not `!manifest`) so an empty
    // manifest — a valid zero-tool surface — is not misread as "unavailable".
    //
    // Snapshot the fallback BEFORE the await: getCachedManifest() reads the
    // live session→WebContents map, and a pinned session can be torn down
    // (map entry deleted) while requestManifest() is in flight. Reading it
    // after the await would then see the session as unpinned and return the
    // shared cache — another window's tool surface — defeating #7003. Taken
    // synchronously here, the request is still in flight so the pin holds.
    const cachedFallback = getCachedManifest();
    let manifest: import("../../../shared/types/actions.js").ActionManifestEntry[];
    try {
      manifest = await requestManifest();
    } catch (err) {
      if (cachedFallback === null) {
        throw new McpError(ErrorCode.InternalError, "Action manifest unavailable");
      }
      console.warn("[MCP] tools/list using cached manifest after live fetch failed:", err);
      manifest = cachedFallback;
    }
    const tier = sessionStore.getTier(sessionId);
    const tools = manifest
      .filter((entry) => shouldExposeTool(entry, tier))
      .map((entry) => {
        const outputSchema = buildToolOutputSchema(entry);
        const _meta =
          entry.examples && entry.examples.length > 0 ? { examples: entry.examples } : undefined;
        return {
          name: entry.id,
          description: entry.description,
          inputSchema: buildToolInputSchema(entry),
          annotations: buildAnnotations(entry),
          ...(outputSchema ? { outputSchema } : {}),
          ...(_meta ? { _meta } : {}),
        };
      });

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const actionId = request.params.name;
    const { args, requestKey } = parseToolArguments(request.params.arguments);
    const startedAt = Date.now();
    const tier = sessionStore.getTier(sessionId);
    // Snapshot the turn id once, at dispatch start, before any guard or await
    // can yield to an active→passive FSM transition that would clear it (#10067).
    // Every consumer below — the started/settled strip events and all audit
    // records — receives this same value so one tool call can never split
    // across two turn groupings in the Assistant panel.
    const capturedTurnId: string | null = getCurrentTurnId?.() ?? null;

    // Layered authorization (#8442):
    //   1. Static tier floor (`TIER_ALLOWLISTS`) — workbench/action/system
    //      membership stays the default. The "Always allow" project setting
    //      elevates the session tier so this check passes for everything
    //      below the chosen tier.
    //   2. Per-`(sessionId, toolId)` grant cache — the "Approve once" flow
    //      mints time-bounded grants that authorise a single tool without
    //      elevating the whole session. If the static check denies but a
    //      live grant exists, the dispatch proceeds and the grant's TTL
    //      is refreshed on success.
    //
    // The order means that a session whose static tier already permits the
    // action never consults the grant cache — grants are an additive layer,
    // never required when the floor already grants access.
    let grantIssuedAt: number | undefined;
    // Set when a native session-scoped automation grant (#10648) authorized
    // this call. Captured here so the post-dispatch path can refresh the
    // grant's TTL window, and so the `danger: "confirm"` modal is bypassed —
    // a native grant is an explicit user approval of the tool's scope.
    let nativeGrantId: string | undefined;
    if (!isTierPermitted(tier, actionId)) {
      const grant = sessionStore.grantCache.check(sessionId, actionId);
      const native = grant.granted
        ? null
        : sessionStore.grantCache.peekNativeGrant(sessionId, actionId);
      if (grant.granted) {
        // Grant authorised the call. Capture the `issuedAt` token so the
        // post-dispatch refresh can verify the entry wasn't revoked and
        // re-issued under us (race guard, lesson #2243).
        grantIssuedAt = grant.issuedAt;
      } else if (native?.granted) {
        // A native automation grant covers this tool and has a use left. It
        // overrides the static tier floor only because the user explicitly
        // approved this tool's scope — the grant's allowlist gates which tools
        // `peekNativeGrant` authorizes. The use is NOT charged here: it is
        // consumed only once the call is committed to dispatching (below), so
        // an unauthorized call can't burn a use.
        nativeGrantId = native.grantId;
      } else {
        // Increment first, then ask the cache whether to suppress. The
        // post-increment count reflects "this denial counted"; the cache's
        // threshold compares against that. With threshold=2 the 1st and
        // 2nd denials fire the banner and the 3rd+ are suppressed.
        sessionStore.grantCache.incrementDenial(sessionId, actionId);
        const suppressBanner = sessionStore.grantCache.shouldSuppressBanner(sessionId, actionId);
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            outcome: { kind: "unauthorized" },
            bannerSuppressed: suppressBanner ? true : undefined,
            capturedTurnId,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
        if (notifyTierMismatch && !suppressBanner) {
          try {
            notifyTierMismatch({
              sessionId,
              toolId: actionId,
              tier,
              targetTier: minimumPermittingTier(actionId),
            });
          } catch (err) {
            console.error("[MCP] Failed to notify tier-mismatch:", err);
          }
        }
        if (recordDenial) {
          const result = recordDenial(sessionId, "tierMismatch");
          if (result.tripped) {
            const pinnedId = sessionStore.sessionWebContentsMap.get(sessionId);
            sessionStore.revokeSession(sessionId);
            clearDenialState?.(sessionId);
            if (notifySessionRevoked) {
              try {
                notifySessionRevoked({
                  sessionId,
                  denialKind: "tierMismatch",
                  pinnedWebContentsId: pinnedId,
                });
              } catch (err) {
                console.error("[MCP] Failed to notify session-revoked:", err);
              }
            }
          }
        }
        return buildToolError({
          code: TIER_NOT_PERMITTED_CODE,
          message: `action '${actionId}' is not permitted for the '${tier}' tier.`,
        });
      }
    }

    // Charge the native automation grant's use now that the call has cleared
    // the tier/grant check and is committed to proceeding (#10648). Doing it
    // here — not at the peek above — means an unauthorized call never burns a
    // use. The peek→consume path is synchronous (no `await`), so the grant
    // can't be revoked between peek and consume; a `false` return is purely
    // defensive and fails closed.
    if (nativeGrantId !== undefined) {
      const consumed = sessionStore.grantCache.consumeNativeGrantUse(nativeGrantId, actionId);
      if (!consumed) {
        return buildToolError({
          code: TIER_NOT_PERMITTED_CODE,
          message: `action '${actionId}' is not permitted for the '${tier}' tier.`,
        });
      }
    }

    // Idempotency dedup for the creation-tool allowlist. Same-moment duplicates
    // share the original Promise (singleflight); post-completion duplicates
    // within MCP_DEDUP_TTL_MS return the cached result without redispatching.
    // Keyed by `requestKey` if the caller supplied one, otherwise a hash of
    // `(actionId, args)`. See #7531.
    let dedupKey: string | undefined;
    let argsHash: string | undefined;
    if (MCP_DEDUP_ALLOWLIST.has(actionId)) {
      dedupKey = buildDedupKey(actionId, requestKey, args);
      argsHash = canonicalArgsHash(actionId, args);

      const resultCache = sessionStore.dedupResultCache.get(sessionId);
      if (resultCache) {
        const cachedEntry = readDedupCache(resultCache, dedupKey, Date.now());
        if (cachedEntry) {
          if (cachedEntry.argsHash !== argsHash) {
            try {
              appendAuditRecord({
                toolId: actionId,
                sessionId,
                tier,
                args,
                durationMs: Date.now() - startedAt,
                outcome: { kind: "collision" },
                capturedTurnId,
              });
            } catch (err) {
              console.error("[MCP] Failed to append audit record:", err);
            }
            return buildToolError({
              code: MCP_DEDUP_KEY_COLLISION_CODE,
              message:
                "Idempotency key collision: the same requestKey was used with different arguments.",
              details: { actionId, requestKey },
            });
          }
          try {
            appendAuditRecord({
              toolId: actionId,
              sessionId,
              tier,
              args,
              durationMs: Date.now() - startedAt,
              outcome: { kind: "dedup" },
              capturedTurnId,
            });
          } catch (err) {
            console.error("[MCP] Failed to append audit record:", err);
          }
          return cachedEntry.result;
        }
      }

      const inFlightForSession = sessionStore.dedupInFlight.get(sessionId);
      const sharedEntry = inFlightForSession?.get(dedupKey);
      if (sharedEntry) {
        if (sharedEntry.argsHash !== argsHash) {
          try {
            appendAuditRecord({
              toolId: actionId,
              sessionId,
              tier,
              args,
              durationMs: Date.now() - startedAt,
              outcome: { kind: "collision" },
              capturedTurnId,
            });
          } catch (err) {
            console.error("[MCP] Failed to append audit record:", err);
          }
          return buildToolError({
            code: MCP_DEDUP_KEY_COLLISION_CODE,
            message:
              "Idempotency key collision: the same requestKey was used with different arguments.",
            details: { actionId, requestKey },
          });
        }
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            outcome: { kind: "dedup" },
            capturedTurnId,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
        return await sharedEntry.promise;
      }
    }

    let outcome:
      | { kind: "result"; value: import("../../../shared/types/actions.js").ActionDispatchResult }
      | { kind: "throw"; error: unknown }
      | undefined;
    let confirmationDecision:
      import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision | undefined;
    // A native automation grant is an explicit user approval of the tool's
    // scope, so it authorizes a `danger: "confirm"` dispatch without surfacing
    // a per-call modal — exactly as if the user had just approved it.
    const dispatchConfirmed = nativeGrantId !== undefined;
    // Tracks whether a live "tool-call-started" push fired for this dispatch so
    // the shared `finally` only emits the matching "settled" push for calls the
    // activity strip is actually showing (#9759). Pre-dispatch rejections never
    // reach the IIFE, so they never set this — and never settle the strip.
    let toolCallStartedEmitted = false;
    const emitToolCallStarted = (danger: boolean): void => {
      if (!notifyToolCallStarted) return;
      try {
        notifyToolCallStarted({
          sessionId,
          toolId: actionId,
          args,
          startedAt,
          danger,
          capturedTurnId,
        });
        toolCallStartedEmitted = true;
      } catch (err) {
        console.error("[MCP] Failed to notify tool-call-started:", err);
      }
    };

    // Wrapped in an inner IIFE so the dedup guard below can register this
    // Promise in `dedupInFlight` (singleflight) and attach a `.then()` cache
    // hook that fires before any other awaiter sees the resolved result.
    const dispatchPromise: Promise<CallToolResultLike> = (async () => {
      try {
        // Short-circuit: terminal.waitUntilIdle runs in the main process. The
        // action manifest entry handles schema, tier, and audit registration; the
        // execution must bypass renderer dispatch because (a) the MCP AbortSignal
        // can't cross IPC, and (b) renderer dispatch has a 30s wall — too short
        // for the multi-hour waits external sessions may request. Audit unifies
        // via the shared finally.
        if (actionId === TERMINAL_WAIT_UNTIL_IDLE_TOOL) {
          // waitUntilIdle is never `danger: "confirm"` — it's a passive wait,
          // so the strip shows a plain in-flight row (no "awaiting confirmation").
          emitToolCallStarted(false);
          try {
            // Interactive help sessions (workbench/action/system tiers) have a
            // human waiting on the conversation — a tool call held open blocks
            // the whole session, so the wait is clamped to the interactive cap
            // and the agent re-polls on `timedOut: true`. External (api-key)
            // sessions are headless scripts; they keep the full 2h ceiling.
            const maxTimeoutMs =
              tier === "external"
                ? MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS
                : INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS;
            const result = await waitUntilIdle(args, extra.signal, { maxTimeoutMs });
            outcome = { kind: "result", value: { ok: true, result } };
            // Mirror the post-dispatch grant refresh in the main path:
            // when the call was authorized by a grant, extend the TTL
            // window and reset the idle timer on success. `waitUntilIdle`
            // can run up to 2 hours on external sessions (longer than the
            // 15-min grant window), so this is the only block that prevents
            // the grant from silently aging out during a long wait (#8442).
            if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
              if (grantIssuedAt !== undefined) {
                sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              }
              if (nativeGrantId !== undefined) {
                sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
              }
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "waitUntilIdle failed"),
            });
          }
        }

        // Short-circuit: terminal.waitUntilIdleBatch is the batched sibling of
        // waitUntilIdle (watch N terminals, resolve on first/all idle). Same
        // main-process rationale and tier clamp; same grant-refresh-on-long-wait.
        if (actionId === TERMINAL_WAIT_UNTIL_IDLE_BATCH_TOOL) {
          emitToolCallStarted(false);
          try {
            const maxTimeoutMs =
              tier === "external"
                ? MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS
                : INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS;
            const result = await waitUntilIdleBatch(args, extra.signal, { maxTimeoutMs });
            outcome = { kind: "result", value: { ok: true, result } };
            if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
              if (grantIssuedAt !== undefined) {
                sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              }
              if (nativeGrantId !== undefined) {
                sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
              }
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "waitUntilIdleBatch failed"),
            });
          }
        }

        // Short-circuit: skills.search / skills.load run entirely in the main
        // process (#10892). The action manifest entries (renderer) carry
        // schema/tier/audit, but the skill registry — parsed plugin markdown —
        // only exists in main, so execution stays here rather than
        // round-tripping to a renderer that has no skill data. Synchronous
        // in-memory reads; never `danger: "confirm"`. Audit + strip-settle
        // unify via the shared `finally`.
        if (actionId === SKILLS_SEARCH_TOOL || actionId === SKILLS_LOAD_TOOL) {
          emitToolCallStarted(false);
          try {
            const result =
              actionId === SKILLS_SEARCH_TOOL ? handleSkillsSearch(args) : handleSkillsLoad(args);
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, `${actionId} failed`),
            });
          }
        }

        // Short-circuit: help.displayImage runs entirely in the main process
        // (#9828). The action manifest entry handles schema/tier/audit; the URL
        // allowlist check, the per-session figure-number assignment, and the
        // imageId mint are authoritative state that must live here, not in the
        // renderer. The figure is pushed to the pinned WebContents via
        // `notifyDisplayImage`. Audit + strip-settle unify via the shared
        // `finally`. Never `danger: "confirm"` — it's a passive display.
        if (actionId === HELP_DISPLAY_IMAGE_TOOL) {
          emitToolCallStarted(false);
          try {
            // Help-session bearers only. A pane-token session can also resolve
            // to the workbench tier and clear the static allowlist gate above,
            // but it has no pinned panel to render the figure and no public
            // help-session id to key the counter, so reject it here.
            const helpSessionId = sessionStore.sessionHelpIdMap.get(sessionId);
            if (helpSessionId === undefined) {
              const message = "help.displayImage is only available to help sessions.";
              outcome = {
                kind: "result",
                value: { ok: false, error: { code: TIER_NOT_PERMITTED_CODE, message } },
              };
              return buildToolError({ code: TIER_NOT_PERMITTED_CODE, message });
            }
            const params = (args ?? {}) as {
              url?: unknown;
              caption?: unknown;
              altText?: unknown;
            };
            const url = typeof params.url === "string" ? params.url : "";
            const validation = url
              ? validateDisplayImageUrl(url)
              : { valid: false as const, message: "A non-empty `url` string is required." };
            if (!validation.valid) {
              outcome = {
                kind: "result",
                value: {
                  ok: false,
                  error: { code: INVALID_URL_CODE, message: validation.message },
                },
              };
              return buildToolError({ code: INVALID_URL_CODE, message: validation.message });
            }
            const caption = typeof params.caption === "string" ? params.caption : undefined;
            const altText = typeof params.altText === "string" ? params.altText : undefined;
            const figureNumber = sessionStore.nextFigureNumber(helpSessionId);
            const figureLabel = `image #${figureNumber}`;
            const imageId = randomUUID();
            if (notifyDisplayImage) {
              try {
                notifyDisplayImage({
                  sessionId,
                  imageId,
                  figureNumber,
                  figureLabel,
                  url,
                  ...(caption !== undefined ? { caption } : {}),
                  ...(altText !== undefined ? { altText } : {}),
                });
              } catch (err) {
                console.error("[MCP] Failed to notify display-image:", err);
              }
            }
            const result = { imageId, figureNumber, figureLabel };
            outcome = { kind: "result", value: { ok: true, result } };
            return buildToolCallResult(result, {
              structuredContent: result as unknown as Record<string, unknown>,
            });
          } catch (err) {
            outcome = { kind: "throw", error: err };
            if (err instanceof McpError) {
              throw err;
            }
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "help.displayImage failed"),
            });
          }
        }

        const entry = await lookupManifestEntry(actionId, getCachedManifest, requestManifest);
        // Announce the in-flight call now that `danger` is known — before the
        // host-side confirmation wait, so the strip can show "awaiting
        // confirmation" while the user decides on a `danger: "confirm"`
        // dispatch (#9759). Confirmation for `danger: "confirm"` is always
        // performed host-side: the unconfirmed `dispatchAction` below routes to
        // the renderer's native ConfirmDialog (or `CONFIRMATION_REQUIRED` when
        // no window is open). A client's self-declared `elicitation.form`
        // capability and its in-band elicitation response are NEVER treated as
        // proof of human authorization — a headless/agentic client could
        // otherwise self-approve its own destructive call (#11342). Only a
        // host-issued native grant (`nativeGrantId`) pre-authorizes a dispatch.
        emitToolCallStarted(entry?.danger === "confirm");

        // The workspace the dispatch actually landed on, resolved renderer-side
        // at response time (#11536). Only ever set from a completed dispatch, so
        // every failure path below (no window, session binding gone, throw)
        // leaves it undefined and stamps nothing.
        let dispatchedWorkspace: DispatchedWorkspaceRef | undefined;
        try {
          const envelope = await dispatchAction(actionId, args, dispatchConfirmed);
          outcome = { kind: "result", value: envelope.result };
          confirmationDecision = confirmationDecision ?? envelope.confirmationDecision;
          dispatchedWorkspace = envelope.dispatchedWorkspace;
        } catch (err) {
          outcome = { kind: "throw", error: err };
          if (err instanceof SessionBindingError) {
            return buildToolError({
              code: SESSION_BINDING_GONE,
              message: err.message,
            });
          }
          // No live renderer to route the dispatch through (#10640). Every
          // unconfirmed `danger: "confirm"` dispatch is forwarded to the
          // renderer bridge so the human can approve it in a native
          // ConfirmDialog (#11342); with no Daintree window open,
          // `getActiveProjectWebContents` throws `RendererBridgeUnavailableError`.
          if (err instanceof RendererBridgeUnavailableError) {
            // Confirm-gated tool we KNOW needs human approval (manifest entry
            // resolved): the action could not be confirmed, not that it failed
            // mid-execution. Reclassify to CONFIRMATION_REQUIRED (audited as
            // `confirmation-pending`, never retriable) with a machine-readable
            // `confirmationChannel: "unavailable"` so an autonomous conductor
            // can tell "needs a human I can't reach" apart from a transient
            // error. Scoped to unconfirmed dispatches so an already-approved
            // call that fails for any other reason isn't mislabelled.
            if (entry?.danger === "confirm" && !dispatchConfirmed) {
              const message =
                `Action '${actionId}' requires confirmation, but no Daintree window is open to surface the ` +
                `approval dialog. The action was not run — a human must approve it in Daintree.`;
              const value: import("../../../shared/types/actions.js").ActionDispatchResult = {
                ok: false,
                error: {
                  code: CONFIRMATION_REQUIRED_CODE,
                  message,
                  details: { confirmationChannel: "unavailable" },
                },
              };
              outcome = { kind: "result", value };
              return buildToolError({
                code: CONFIRMATION_REQUIRED_CODE,
                message,
                details: { confirmationChannel: "unavailable" },
              });
            }
            // Either a non-confirm tool, or a cold-cache call whose manifest
            // entry couldn't be fetched (the manifest itself comes from the
            // renderer, so `entry` is undefined here and the tool's danger is
            // unknowable). We must not claim CONFIRMATION_REQUIRED without
            // knowing the tool is confirm-gated, so this stays a *retriable*
            // EXECUTION_ERROR — the renderer may come back when a window opens.
            // The message names the cause so the caller retries deliberately
            // rather than treating it as an opaque dispatch failure.
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message:
                "No Daintree window is open, so the action surface is unavailable. Retry once a project window is open.",
            });
          }
          return buildToolError({
            code: EXECUTION_ERROR_CODE,
            message: formatErrorMessage(err, "Action dispatch failed"),
          });
        }

        if (outcome.value.ok) {
          // Sliding-TTL refresh: a successful dispatch through a grant
          // extends its window AND resets the session idle timer. Without
          // resetting the idle timer, a 15-min grant could be silently
          // truncated by a 30-min idle reaper that started before the
          // grant was issued (#8442). The `grantIssuedAt` token guards
          // against a revoke-and-reissue race (#2243): if the entry was
          // replaced mid-dispatch, `refresh` is a silent no-op.
          if (grantIssuedAt !== undefined || nativeGrantId !== undefined) {
            if (grantIssuedAt !== undefined) {
              sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
            }
            if (nativeGrantId !== undefined) {
              sessionStore.grantCache.refreshNativeGrant(nativeGrantId);
            }
            if (sessionStore.sessions.has(sessionId)) {
              sessionStore.resetIdleTimer(sessionId);
            } else if (sessionStore.httpSessions.has(sessionId)) {
              sessionStore.resetHttpIdleTimer(sessionId);
            }
          }
          // browser.captureScreenshot returns PNG bytes — surface them as a real
          // MCP image content block so the model receives a usable image, not a
          // base64 blob text-serialized into the transcript.
          if (actionId === BROWSER_CAPTURE_SCREENSHOT_TOOL) {
            const shot = asScreenshotResult(outcome.value.result);
            if (shot) {
              return withResolvedWorkspace(
                {
                  content: [
                    { type: "image" as const, data: shot.pngBase64, mimeType: "image/png" },
                    {
                      type: "text" as const,
                      text: `Screenshot captured (${shot.width}×${shot.height})`,
                    },
                  ],
                },
                dispatchedWorkspace
              );
            }
          }
          const structuredContent = buildStructuredContent(entry, outcome.value.result);
          return withResolvedWorkspace(
            buildToolCallResult(outcome.value.result, {
              ...(structuredContent ? { structuredContent } : {}),
            }),
            dispatchedWorkspace
          );
        }

        // A renderer was reached and reported a failure, so the target is known
        // and worth reporting — unlike the pre-dispatch errors above.
        return withResolvedWorkspace(
          buildToolError({
            code: outcome.value.error.code,
            message: outcome.value.error.message,
            details: outcome.value.error.details,
          }),
          dispatchedWorkspace
        );
      } finally {
        const settledOutcome = outcome ?? { kind: "throw" as const, error: new Error("unknown") };
        // Compute the duration once so the audit record and the live strip
        // report the same wall-clock, not two reads a few µs apart (#9759).
        const durationMs = Date.now() - startedAt;
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs,
            outcome: settledOutcome,
            confirmationDecision,
            capturedTurnId,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
        // Settle the live activity strip for the matching started push. Guarded
        // so a dispatch that never announced (pre-dispatch rejection, or a
        // started-notify that threw) can't emit a dangling settle (#9759).
        if (toolCallStartedEmitted && notifyToolCallSettled) {
          try {
            notifyToolCallSettled({
              sessionId,
              toolId: actionId,
              durationMs,
              outcome: settledOutcome,
              capturedTurnId,
            });
          } catch (err) {
            console.error("[MCP] Failed to notify tool-call-settled:", err);
          }
        }
      }
    })();

    if (dedupKey !== undefined) {
      let inFlight = sessionStore.dedupInFlight.get(sessionId);
      if (!inFlight) {
        inFlight = new Map();
        sessionStore.dedupInFlight.set(sessionId, inFlight);
      }
      const ownedInFlight = inFlight;
      const cleanupKey = dedupKey;
      const ownedArgsHash = argsHash!;
      ownedInFlight.set(cleanupKey, { promise: dispatchPromise, argsHash: ownedArgsHash });

      dispatchPromise.then(
        (result) => {
          // Session-liveness guard: drain() clears `dedupInFlight` up-front,
          // so a torn-down session leaves `liveInFlight` undefined and we
          // skip both cleanup and caching. Same protection if the session
          // was recreated under the same id (different Map identity).
          const liveInFlight = sessionStore.dedupInFlight.get(sessionId);
          if (liveInFlight !== ownedInFlight) return;

          ownedInFlight.delete(cleanupKey);
          if (ownedInFlight.size === 0) {
            sessionStore.dedupInFlight.delete(sessionId);
          }

          // Cache only successful results — transient failures must retry.
          if (outcome?.kind === "result" && outcome.value.ok) {
            let cache = sessionStore.dedupResultCache.get(sessionId);
            if (!cache) {
              cache = new Map();
              sessionStore.dedupResultCache.set(sessionId, cache);
            }
            cache.set(cleanupKey, {
              result,
              expiresAt: Date.now() + MCP_DEDUP_TTL_MS,
              argsHash: ownedArgsHash,
            });
            // FIFO-evict the oldest entries when the per-session cap is
            // exceeded. Map iteration is insertion-order, so the first key
            // returned by `.keys()` is the oldest still-living entry.
            while (cache.size > MCP_DEDUP_MAX_ENTRIES_PER_SESSION) {
              const oldestKey = cache.keys().next().value;
              if (oldestKey === undefined) break;
              cache.delete(oldestKey);
            }
          }
        },
        () => {
          const liveInFlight = sessionStore.dedupInFlight.get(sessionId);
          if (liveInFlight !== ownedInFlight) return;
          ownedInFlight.delete(cleanupKey);
          if (ownedInFlight.size === 0) {
            sessionStore.dedupInFlight.delete(sessionId);
          }
        }
      );
    }

    return await dispatchPromise;
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: await listConcreteResources(sessionId, deps) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: listResourceTemplates(sessionId, deps) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    if (!isResourcePermitted(sessionId, deps, parsed.kind)) {
      const tier = sessionStore.getTier(sessionId);
      const message = `Resource '${uri}' is not permitted for the '${tier}' tier.`;
      throw new McpError(
        ErrorCode.InvalidRequest,
        message,
        buildMcpErrorPayload({ code: TIER_NOT_PERMITTED_CODE, message })
      );
    }
    const contents = await readResourceContents(uri, parsed, dispatchAction);
    return { contents: [contents] };
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    if (!isResourcePermitted(sessionId, deps, parsed.kind)) {
      const tier = sessionStore.getTier(sessionId);
      const message = `Resource '${uri}' is not permitted for the '${tier}' tier.`;
      throw new McpError(
        ErrorCode.InvalidRequest,
        message,
        buildMcpErrorPayload({ code: TIER_NOT_PERMITTED_CODE, message })
      );
    }
    subscribeResource(sessionId, server, uri, parsed, sessionStore);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    unsubscribeResource(sessionId, request.params.uri, sessionStore);
    return {};
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: PROMPT_DEFINITIONS.map((def) => ({
        name: def.name,
        description: def.description,
        arguments: def.arguments,
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    const definition = PROMPT_DEFINITIONS.find((def) => def.name === name);
    if (!definition) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    }

    const rawArgs = request.params.arguments ?? {};

    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      throw new McpError(ErrorCode.InvalidParams, "Prompt arguments must be an object");
    }

    for (const [key, value] of Object.entries(rawArgs)) {
      if (typeof value !== "string") {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Prompt argument '${key}' must be a string, got ${typeof value}`
        );
      }
    }

    const args = rawArgs as Record<string, string>;

    for (const arg of definition.arguments) {
      if (arg.required && !args[arg.name]?.trim()) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Missing required argument for prompt '${name}': ${arg.name}`
        );
      }
    }

    const context = await collectPromptContext(definition, args, dispatchAction);
    const text = definition.render(args, context);

    return {
      description: definition.description,
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text },
        },
      ],
    };
  });

  return server;
}

// --- Resource helpers ---

async function listConcreteResources(
  sessionId: string,
  deps: SessionServerDeps
): Promise<Array<{ uri: string; name: string; mimeType: string; description?: string }>> {
  const resources: Array<{ uri: string; name: string; mimeType: string; description?: string }> =
    [];
  if (isResourcePermitted(sessionId, deps, "issues")) {
    resources.push({
      uri: "daintree://project/current/issues",
      name: "Current project — open issues",
      mimeType: "application/json",
      description: "Open issues for the active project.",
    });
  }
  if (isResourcePermitted(sessionId, deps, "pulse")) {
    const worktrees = await tryDispatchList("worktree.list", deps.dispatchAction);
    for (const wt of worktrees) {
      const id = readStringField(wt, ["id", "worktreeId"]);
      const label = readStringField(wt, ["branch", "name", "path"]) ?? id;
      if (!id) continue;
      resources.push({
        uri: `daintree://worktree/${encodeURIComponent(id)}/pulse`,
        name: `Worktree pulse — ${label ?? id}`,
        mimeType: "application/json",
        description: "Git status summary, recent commits, and pull-request signal.",
      });
    }
  }
  if (
    isResourcePermitted(sessionId, deps, "scrollback") ||
    isResourcePermitted(sessionId, deps, "agentState")
  ) {
    const terminals = await tryDispatchList("terminal.list", deps.dispatchAction);
    for (const term of terminals) {
      const id = readStringField(term, ["id", "terminalId"]);
      const label = readStringField(term, ["title", "name"]) ?? id;
      if (id && isResourcePermitted(sessionId, deps, "scrollback")) {
        resources.push({
          uri: `daintree://terminal/${encodeURIComponent(id)}/scrollback`,
          name: `Terminal scrollback — ${label ?? id}`,
          mimeType: "text/plain",
          description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
        });
      }
      const agentId = readStringField(term, ["agentId"]);
      if (agentId && isResourcePermitted(sessionId, deps, "agentState")) {
        resources.push({
          uri: `daintree://agent/${encodeURIComponent(agentId)}/state`,
          name: `Agent state — ${label ?? agentId}`,
          mimeType: "application/json",
          description: "Current agent state-machine value (idle, working, waiting, etc.).",
        });
      }
    }
  }
  return resources;
}

function listResourceTemplates(
  sessionId: string,
  deps: SessionServerDeps
): Array<{ uriTemplate: string; name: string; mimeType: string; description?: string }> {
  const templates: Array<{
    uriTemplate: string;
    name: string;
    mimeType: string;
    description?: string;
  }> = [];
  if (isResourcePermitted(sessionId, deps, "pulse")) {
    templates.push({
      uriTemplate: "daintree://worktree/{id}/pulse",
      name: "Worktree pulse",
      mimeType: "application/json",
      description: "Git status summary, recent commits, and pull-request signal.",
    });
  }
  if (isResourcePermitted(sessionId, deps, "scrollback")) {
    templates.push({
      uriTemplate: "daintree://terminal/{id}/scrollback",
      name: "Terminal scrollback",
      mimeType: "text/plain",
      description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
    });
  }
  if (isResourcePermitted(sessionId, deps, "agentState")) {
    templates.push({
      uriTemplate: "daintree://agent/{id}/state",
      name: "Agent state",
      mimeType: "application/json",
      description: "Current agent state-machine value (idle, working, waiting, etc.).",
    });
  }
  return templates;
}

async function readResourceContents(
  uri: string,
  parsed: ParsedResourceUri,
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<{ uri: string; mimeType: string; text: string }> {
  if (parsed.kind === "pulse") {
    const envelope = await dispatchAction("git.getProjectPulse", {
      worktreeId: parsed.id,
      rangeDays: 60,
    });
    const text = serializeResourcePayload(unwrapDispatchResult(envelope));
    return { uri, mimeType: "application/json", text: truncateText(text) };
  }
  if (parsed.kind === "scrollback") {
    const envelope = await dispatchAction("terminal.getOutput", {
      terminalId: parsed.id,
      maxLines: RESOURCE_SCROLLBACK_TAIL_LINES,
      stripAnsi: true,
    });
    const value = unwrapDispatchResult(envelope);
    const text = typeof value === "string" ? value : serializeResourcePayload(value);
    return { uri, mimeType: "text/plain", text: truncateText(text) };
  }
  if (parsed.kind === "agentState") {
    const store = getAgentAvailabilityStore();
    const state = store.getState(parsed.id);
    const waitingReason = state === "waiting" ? store.getWaitingReason(parsed.id) : undefined;
    // Exit metadata only after the agent has finished. exitCode may be null
    // (signal kill), so gate on the agent being in a terminal state rather than
    // on the value being truthy.
    const hasExited = state === "completed" || state === "exited";
    const exitCode = hasExited ? store.getExitCode(parsed.id) : undefined;
    const exitSignal = hasExited ? store.getExitSignal(parsed.id) : undefined;
    const spawnedAt = store.getSpawnedAt(parsed.id);
    const lastTransitionAt = store.getLastStateChange(parsed.id);
    const text = JSON.stringify({
      agentId: parsed.id,
      state: state ?? null,
      ...(waitingReason ? { waitingReason } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(exitSignal !== undefined ? { exitSignal } : {}),
      ...(spawnedAt !== undefined ? { spawnedAt } : {}),
      ...(lastTransitionAt !== undefined ? { lastTransitionAt } : {}),
    });
    return { uri, mimeType: "application/json", text };
  }
  if (parsed.kind === "issues") {
    const envelope = await dispatchAction("forge.listIssues", {});
    const text = serializeResourcePayload(unwrapDispatchResult(envelope));
    return { uri, mimeType: "application/json", text: truncateText(text) };
  }
  throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
}

async function tryDispatchList(
  actionId: string,
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<unknown[]> {
  try {
    const envelope = await dispatchAction(actionId, {});
    const value = unwrapDispatchResult(envelope);
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      for (const key of ["items", "results", "list", "terminals", "worktrees"]) {
        const inner = (value as Record<string, unknown>)[key];
        if (Array.isArray(inner)) return inner;
      }
    }
    return [];
  } catch (err) {
    console.error(`[MCP] Failed to enumerate resources via ${actionId}:`, err);
    return [];
  }
}

function isResourcePermitted(sessionId: string, deps: SessionServerDeps, kind: string): boolean {
  const tier = deps.sessionStore.getTier(sessionId);
  return isTierPermitted(tier, (RESOURCE_BACKING_ACTIONS as Record<string, string>)[kind]);
}

function subscribeResource(
  sessionId: string,
  server: Server,
  uri: string,
  parsed: ParsedResourceUri,
  sessionStore: SessionStore
): void {
  if (parsed.kind !== "pulse" && parsed.kind !== "agentState") {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Subscriptions are not supported for resource '${uri}'.`
    );
  }
  let bucket = sessionStore.resourceSubscriptions.get(sessionId);
  if (!bucket) {
    bucket = new Map();
    sessionStore.resourceSubscriptions.set(sessionId, bucket);
  }
  if (bucket.has(uri)) return;

  const fire = () => {
    if (!sessionStore.sessions.has(sessionId) && !sessionStore.httpSessions.has(sessionId)) return;
    server.sendResourceUpdated({ uri }).catch((err) => {
      console.error(`[MCP] sendResourceUpdated failed for ${uri}:`, err);
    });
  };

  let unsub: () => void;
  if (parsed.kind === "agentState") {
    unsub = events.on("agent:state-changed", (payload) => {
      if (payload.agentId === parsed.id) fire();
    });
  } else {
    unsub = events.on("sys:worktree:update", (payload) => {
      if (payload.worktreeId === parsed.id) fire();
    });
  }
  bucket.set(uri, unsub);
}

function unsubscribeResource(sessionId: string, uri: string, sessionStore: SessionStore): void {
  const bucket = sessionStore.resourceSubscriptions.get(sessionId);
  if (!bucket) return;
  const unsub = bucket.get(uri);
  if (!unsub) return;
  try {
    unsub();
  } catch (err) {
    console.error(`[MCP] Failed to unsubscribe ${uri}:`, err);
  }
  bucket.delete(uri);
  if (bucket.size === 0) {
    sessionStore.resourceSubscriptions.delete(sessionId);
  }
}

export function cleanupResourceSubscriptions(sessionId: string, sessionStore: SessionStore): void {
  const bucket = sessionStore.resourceSubscriptions.get(sessionId);
  if (!bucket) return;
  for (const unsub of bucket.values()) {
    try {
      unsub();
    } catch (err) {
      console.error("[MCP] Resource subscription teardown failed:", err);
    }
  }
  sessionStore.resourceSubscriptions.delete(sessionId);
}

// --- Prompt helpers ---

async function collectPromptContext(
  definition: PromptDefinition,
  args: Record<string, string>,
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<PromptRenderContext> {
  const context: PromptRenderContext = {};

  // triage_terminals is a static recipe — render() ignores context, so skip
  // the worktree dispatch to avoid a 30s safeDispatch timeout penalty when the
  // renderer is unavailable (startup, view teardown, project switch).
  if (definition.name !== "triage_terminals") {
    const worktree = await safeDispatch("worktree.getCurrent", undefined, dispatchAction);
    if (worktree && typeof worktree === "object") {
      const w = worktree as Record<string, unknown>;
      if (typeof w.path === "string") context.worktreePath = w.path;
      if (typeof w.branch === "string") context.worktreeBranch = w.branch;
      if (typeof w.issueNumber === "number") context.worktreeIssueNumber = w.issueNumber;
    }
  }

  if (definition.name === "triage_failed_agent") {
    const terminalId = args.terminal_id?.trim();
    if (terminalId) {
      const result = await safeDispatch(
        "terminal.getOutput",
        {
          terminalId,
          maxLines: 100,
          stripAnsi: true,
        },
        dispatchAction
      );
      if (result && typeof result === "object") {
        const r = result as Record<string, unknown>;
        if (typeof r.content === "string") {
          const content = r.content;
          if (content.length > PROMPT_TERMINAL_OUTPUT_MAX_CHARS) {
            const tail = content.slice(-PROMPT_TERMINAL_OUTPUT_MAX_CHARS);
            context.terminalOutput = `… [truncated to last ${PROMPT_TERMINAL_OUTPUT_MAX_CHARS} chars]\n${tail}`;
          } else {
            context.terminalOutput = content;
          }
        }
      }
    }
  }

  return context;
}

async function safeDispatch(
  actionId: string,
  args: unknown,
  dispatchAction: SessionServerDeps["dispatchAction"]
): Promise<unknown> {
  try {
    const envelope = await dispatchAction(actionId, args);
    if (envelope.result.ok) {
      return envelope.result.result;
    }
    return null;
  } catch {
    return null;
  }
}

async function lookupManifestEntry(
  actionId: string,
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null,
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>
): Promise<import("../../../shared/types/actions.js").ActionManifestEntry | undefined> {
  let manifest = getCachedManifest();
  if (!manifest) {
    try {
      // Use the value returned directly — pinned sessions (#7002) deliberately
      // skip the shared `cachedManifest` so a re-read here would always return
      // null and silently drop host confirmation + structuredContent.
      manifest = await requestManifest();
    } catch {
      return undefined;
    }
  }
  return manifest.find((e) => e.id === actionId);
}
