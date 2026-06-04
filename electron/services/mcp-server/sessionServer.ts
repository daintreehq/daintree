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
import { summarizeMcpArgs } from "../../../shared/utils/mcpArgsSummary.js";
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
  safeSerializeToolResult,
  readStringField,
  RESOURCE_BACKING_ACTIONS,
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_TIMEOUT_CODE,
  USER_REJECTED_CODE,
  ELICITATION_FAILED_CODE,
  MCP_DEDUP_ALLOWLIST,
  MCP_DEDUP_TTL_MS,
  MCP_DEDUP_MAX_ENTRIES_PER_SESSION,
  MCP_DEDUP_KEY_COLLISION_CODE,
  MCP_RATE_LIMITED_CODE,
  minimumPermittingTier,
  EXECUTION_ERROR_CODE,
  SESSION_BINDING_GONE,
  buildToolError,
  buildMcpErrorPayload,
} from "./shared.js";
import {
  INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
} from "../../../shared/types/terminalWaitUntilIdle.js";
import { SessionBindingError } from "./rendererBridge.js";
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

const TERMINAL_WAIT_UNTIL_IDLE_TOOL = "terminal.waitUntilIdle";
import type { SessionStore } from "./sessionStore.js";

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
  appendAuditRecord: (input: {
    toolId: string;
    sessionId: string;
    tier: McpTier;
    args: unknown;
    durationMs: number;
    outcome: AuditOutcome;
    confirmationDecision?: import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision;
    bannerSuppressed?: boolean;
  }) => void;
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  getFullToolSurface: () => boolean;
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
}

export function createSessionServer(sessionId: string, deps: SessionServerDeps): Server {
  const {
    sessionStore,
    requestManifest,
    dispatchAction,
    handleWaitUntilIdle: waitUntilIdle,
    appendAuditRecord,
    getCachedManifest,
    getFullToolSurface,
    notifyTierMismatch,
    recordDenial,
    notifySessionRevoked,
    clearDenialState,
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
    const manifest = await requestManifest();
    const tier = sessionStore.getTier(sessionId);
    const fullToolSurface = getFullToolSurface();
    const tools = manifest
      .filter((entry) => shouldExposeTool(entry, tier, fullToolSurface))
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
    const fullToolSurface = getFullToolSurface();

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
    if (!isTierPermitted(tier, actionId, fullToolSurface)) {
      const grant = sessionStore.grantCache.check(sessionId, actionId);
      if (!grant.granted) {
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
      // Grant authorised the call. Capture the `issuedAt` token so the
      // post-dispatch refresh can verify the entry wasn't revoked and
      // re-issued under us (race guard, lesson #2243).
      grantIssuedAt = grant.issuedAt;
    }

    // Runaway-loop guard (#8468): charge one token against the
    // per-`(session, toolId)` bucket before dedup or dispatch. Placed
    // after the tier/grant check (an unauthorized call shouldn't consume
    // tokens) and before dedup (a tight loop replaying the same dedup key
    // must still be bounded — dedup is an idempotency guard, not a
    // rate-limit bypass). Rejection is an explicit retriable tool-error
    // with a `retryAfter` hint, never a silent skip.
    const rateLimit = sessionStore.consumeRateLimitToken(sessionId, actionId);
    if (!rateLimit.allowed) {
      try {
        appendAuditRecord({
          toolId: actionId,
          sessionId,
          tier,
          args,
          durationMs: Date.now() - startedAt,
          outcome: { kind: "rate_limited", retryAfter: rateLimit.retryAfter },
        });
      } catch (err) {
        console.error("[MCP] Failed to append audit record:", err);
      }
      return buildToolError({
        code: MCP_RATE_LIMITED_CODE,
        message: `Rate limit exceeded for '${actionId}'. Retry after ${rateLimit.retryAfter}s.`,
        details: { retryAfter: rateLimit.retryAfter },
      });
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
      | import("../../../shared/types/ipc/mcpServer.js").McpConfirmationDecision
      | undefined;
    let dispatchConfirmed = false;

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
            if (grantIssuedAt !== undefined) {
              sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
              if (sessionStore.sessions.has(sessionId)) {
                sessionStore.resetIdleTimer(sessionId);
              } else if (sessionStore.httpSessions.has(sessionId)) {
                sessionStore.resetHttpIdleTimer(sessionId);
              }
            }
            return {
              content: [{ type: "text" as const, text: safeSerializeToolResult(result) }],
              structuredContent: result as unknown as Record<string, unknown>,
            };
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

        const entry = await lookupManifestEntry(actionId, getCachedManifest, requestManifest);
        if (!dispatchConfirmed && entry?.danger === "confirm") {
          const supportsForm = server.getClientCapabilities()?.elicitation?.form !== undefined;
          if (supportsForm) {
            const elicitationOutcome = await runElicitationConfirmation(server, entry, args);
            if (elicitationOutcome.kind === "throw") {
              const failureMessage = formatErrorMessage(
                elicitationOutcome.error,
                "Elicitation request failed"
              );
              const value: import("../../../shared/types/actions.js").ActionDispatchResult = {
                ok: false,
                error: {
                  code: ELICITATION_FAILED_CODE,
                  message: failureMessage,
                },
              };
              outcome = { kind: "result", value };
              return buildToolError({
                code: ELICITATION_FAILED_CODE,
                message: failureMessage,
              });
            }
            if (elicitationOutcome.kind === "rejected") {
              outcome = { kind: "result", value: elicitationOutcome.value };
              return buildToolError({
                code: elicitationOutcome.value.error.code,
                message: elicitationOutcome.value.error.message,
                details: elicitationOutcome.value.error.details,
              });
            }
            dispatchConfirmed = true;
            confirmationDecision = "approved";
          }
        }

        try {
          const envelope = await dispatchAction(actionId, args, dispatchConfirmed);
          outcome = { kind: "result", value: envelope.result };
          confirmationDecision = confirmationDecision ?? envelope.confirmationDecision;
        } catch (err) {
          outcome = { kind: "throw", error: err };
          if (err instanceof SessionBindingError) {
            return buildToolError({
              code: SESSION_BINDING_GONE,
              message: err.message,
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
          if (grantIssuedAt !== undefined) {
            sessionStore.grantCache.refresh(sessionId, actionId, grantIssuedAt);
            if (sessionStore.sessions.has(sessionId)) {
              sessionStore.resetIdleTimer(sessionId);
            } else if (sessionStore.httpSessions.has(sessionId)) {
              sessionStore.resetHttpIdleTimer(sessionId);
            }
          }
          const structuredContent = buildStructuredContent(entry, outcome.value.result);
          return {
            content: [
              {
                type: "text" as const,
                text:
                  outcome.value.result !== undefined && outcome.value.result !== null
                    ? safeSerializeToolResult(outcome.value.result)
                    : "OK",
              },
            ],
            ...(structuredContent ? { structuredContent } : {}),
          };
        }

        return buildToolError({
          code: outcome.value.error.code,
          message: outcome.value.error.message,
          details: outcome.value.error.details,
        });
      } finally {
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            outcome: outcome ?? { kind: "throw", error: new Error("unknown") },
            confirmationDecision,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
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
      description: "Open GitHub issues for the active project.",
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
    const text = JSON.stringify({
      agentId: parsed.id,
      state: state ?? null,
      ...(waitingReason ? { waitingReason } : {}),
    });
    return { uri, mimeType: "application/json", text };
  }
  if (parsed.kind === "issues") {
    const envelope = await dispatchAction("github.listIssues", {});
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
  const fullToolSurface = deps.getFullToolSurface();
  return isTierPermitted(
    tier,
    (RESOURCE_BACKING_ACTIONS as Record<string, string>)[kind],
    fullToolSurface
  );
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
      // null and silently drop confirmation elicitation + structuredContent.
      manifest = await requestManifest();
    } catch {
      return undefined;
    }
  }
  return manifest.find((e) => e.id === actionId);
}

async function runElicitationConfirmation(
  server: Server,
  entry: import("../../../shared/types/actions.js").ActionManifestEntry,
  args: unknown
): Promise<
  | { kind: "approved" }
  | {
      kind: "rejected";
      value: Extract<
        import("../../../shared/types/actions.js").ActionDispatchResult,
        { ok: false }
      >;
    }
  | { kind: "throw"; error: unknown }
> {
  const argsSummary = summarizeMcpArgs(args);
  const rationaleLine = entry.dangerRationale ? `\n${entry.dangerRationale}\n` : "";
  const message =
    argsSummary && argsSummary !== "{}"
      ? `Confirm ${entry.title}: ${entry.description}${rationaleLine}\nArguments: ${argsSummary}`
      : `Confirm ${entry.title}: ${entry.description}${rationaleLine}`;

  let result;
  try {
    result = await server.elicitInput({
      message,
      requestedSchema: {
        type: "object",
        properties: {},
      },
    });
  } catch (err) {
    return { kind: "throw", error: err };
  }

  if (result.action === "cancel") {
    return {
      kind: "rejected",
      value: {
        ok: false,
        error: {
          code: CONFIRMATION_TIMEOUT_CODE,
          message: "Confirmation request timed out before the user responded.",
        },
      },
    };
  }

  if (result.action !== "accept") {
    return {
      kind: "rejected",
      value: {
        ok: false,
        error: {
          code: USER_REJECTED_CODE,
          message: "User rejected the confirmation request.",
        },
      },
    };
  }

  return { kind: "approved" };
}
