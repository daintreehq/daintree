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
import { dispatchCarriesRecipeId } from "../../../shared/utils/dispatchRecipeId.js";
import {
  readDispatchTerminalCommand,
  readDispatchTerminalCwd,
  TERMINAL_LAUNCH_ACTION_ID,
} from "../../../shared/utils/dispatchTerminalCommand.js";
import { isGenericNativeGrantEligible } from "../../../shared/config/nativeGrantUsePolicies.js";
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
  MCP_SERVER_INSTRUCTIONS,
  TIER_NOT_PERMITTED_CODE,
  CONFIRMATION_REQUIRED_CODE,
  MCP_DEDUP_ALLOWLIST,
  MCP_DEDUP_TTL_MS,
  MCP_DEDUP_MAX_ENTRIES_PER_SESSION,
  MCP_DEDUP_KEY_COLLISION_CODE,
  minimumPermittingTier,
  EXECUTION_ERROR_CODE,
  SESSION_BINDING_GONE,
  SESSION_GONE,
  INVALID_URL_CODE,
  RESOURCE_NOT_OWNED_CODE,
  buildToolError,
  buildMcpErrorPayload,
  withResolvedWorkspace,
  WORKSPACE_BINDING_CAPABILITY_KEY,
  type DispatchedWorkspaceRef,
  type McpWorkspaceBinding,
} from "./shared.js";
import {
  INTERACTIVE_WAIT_UNTIL_IDLE_TIMEOUT_CAP_MS,
  MAX_WAIT_UNTIL_IDLE_TIMEOUT_MS,
} from "../../../shared/types/terminalWaitUntilIdle.js";
import {
  McpRouteBindingError,
  RendererBridgeUnavailableError,
  WorkspaceBindingError,
} from "./rendererBridge.js";
import { getExternalBaseManifest } from "./baseManifest.js";
import {
  buildDedupKey,
  canonicalArgsHash,
  readDedupCache,
  type CallToolResultLike,
} from "./sessionDedup.js";
import {
  shouldExposeTool,
  isWithheldFromBoundSession,
  type SessionSurfacePolicy,
  isTierPermitted,
  buildToolInputSchema,
  buildAnnotations,
  buildToolOutputSchema,
  buildStructuredContent,
  parseToolArguments,
  filterIntrospectionResultForSession,
  type TargetPolicySessionSnapshot,
  getTierPermittedActionIds,
  readSearchLimit,
  readListPaging,
  readRequestedActionId,
  INTROSPECTION_TOOL_IDS,
  ACTIONS_LIST_TOOL_ID,
  ACTIONS_LIST_MAX_LIMIT,
  ACTIONS_SEARCH_TOOL_ID,
  ACTIONS_SEARCH_MAX_LIMIT,
  ACTIONS_SEARCH_DEFAULT_LIMIT,
} from "./tierAuth.js";
import { buildToolCallResult } from "./toolCallResult.js";
import { buildSurfaceManifest, MCP_SURFACE_TOOL_ID } from "./surfaceManifest.js";
import { extractOwnedResourcesFromDispatch, type OwnedResourceKind } from "./resourceOwnership.js";

/**
 * Backstop on the `actions.list` page walk. The registry is a few hundred
 * actions, so this only bounds a renderer that never stops reporting `hasMore`.
 */
const MAX_LIST_PAGE_WALK = 20;

const TERMINAL_WAIT_UNTIL_IDLE_TOOL = "terminal.waitUntilIdle";
const TERMINAL_WAIT_UNTIL_IDLE_BATCH_TOOL = "terminal.waitUntilIdleBatch";
const HELP_DISPLAY_IMAGE_TOOL = "help.displayImage";
const BROWSER_CAPTURE_SCREENSHOT_TOOL = "browser.captureScreenshot";
const SKILLS_SEARCH_TOOL = "skills.search";
const SKILLS_LOAD_TOOL = "skills.load";
const PROJECT_RUN_CHECK_TOOL = "project.runCheck";
/**
 * The session-scoped cleanup tools (#11909), and the action each one delegates
 * to once ownership checks out.
 *
 * They run here rather than as ordinary renderer actions because the thing they
 * authorize against — which session created which resource — is main-process
 * state keyed by the MCP transport session id. The renderer never sees that id
 * and must not: handing it over would make "am I allowed to close this?" a
 * question the caller's own dispatch could answer about itself.
 *
 * Delegation, not reimplementation. The check happens here; the close and the
 * delete are the shipped actions, dispatched under their own ids so
 * `terminal.close`'s trash/recovery behaviour and `worktree.delete`'s D2
 * confirmation with its real file-count preview
 * (`resolveMcpConfirmPreviewTarget` in `useMcpBridge`, which matches on the
 * literal action id) apply unchanged.
 */
const OWNED_CLEANUP_TOOLS: Record<
  string,
  { resourceKind: OwnedResourceKind; delegateTo: string; idArg: string }
> = {
  // `resourceKind`, not `kind`: this repo uses a bare `kind` for panel kinds
  // and guards comparisons against it with a lint rule, and an ownership
  // resource kind is a different taxonomy that would otherwise trip it.
  "terminal.closeOwned": {
    resourceKind: "terminal",
    delegateTo: "terminal.close",
    idArg: "terminalId",
  },
  "worktree.deleteOwned": {
    resourceKind: "worktree",
    delegateTo: "worktree.delete",
    idArg: "worktreeId",
  },
};

/**
 * Whether a `terminal.close` result reports the named panel as actually closed.
 *
 * Structural rather than trusting the action id: an empty `closedIds` is
 * `terminal.close`'s documented "nothing closed" answer, and the ownership
 * release must be able to tell that apart from a real close.
 */
function closedIdsInclude(result: unknown, id: string): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const closedIds = (result as { closedIds?: unknown }).closedIds;
  return Array.isArray(closedIds) && closedIds.includes(id);
}

/**
 * The resource id an `*Owned` cleanup call names, or `undefined` when the
 * argument is missing, the wrong type, or blank.
 *
 * Read here rather than trusting the renderer's schema validation, because the
 * ownership check runs before the dispatch that would perform it — and a
 * whitespace-only id must not reach a Map lookup that could only ever miss.
 */
function readOwnedResourceId(args: unknown, key: string): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") return undefined;
  // Blankness is judged on the trimmed form, but the ORIGINAL is returned: the
  // ledger stores ids exactly as the creating action reported them, and
  // `agent.launch`'s `requestedId` lets a caller create one with surrounding
  // whitespace. Handing the trimmed form to the lookup would make that
  // resource permanently uncleanable.
  return value.trim().length === 0 ? undefined : value;
}

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
  /**
   * The workspace this session was bound to at handshake (#11789), echoed in
   * the `initialize` result so a client can verify where its calls will land
   * before issuing a mutation. Absent for unbound sessions.
   */
  workspaceBinding?: McpWorkspaceBinding;
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
  /**
   * Execute `project.runCheck` in the main process (#11548). A check spawns a
   * real child process and reports its exit code, so it needs main-process
   * access, a cancellable `AbortSignal` (which cannot cross IPC), and a wait
   * far longer than the 30s renderer-dispatch wall. Throws {@link McpError} on
   * invalid args; throws for any reason the check could not start, and resolves
   * with `passed: false` when it ran and failed.
   */
  handleProjectRunCheck: (
    rawArgs: unknown,
    signal: AbortSignal
  ) => Promise<import("../../../shared/types/projectCheck.js").ProjectCheckRunResult>;
  appendAuditRecord: (input: {
    toolId: string;
    sessionId: string;
    tier: McpTier;
    args: unknown;
    durationMs: number;
    /**
     * The handler's dispatch-start snapshot (#12122), forwarded so the
     * persisted record carries the same start the live strip's started event
     * does. Required — the audit record's own `timestamp` is a later clock
     * read, so a site that omitted this would leave its row unable to be
     * ordered against its siblings. Every CallTool audit write has it in
     * scope; making it mandatory here is what stops the next one from
     * dropping it.
     */
    startedAt: number;
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
     * Minimum tier that permits the denied tool, or `null` if no non-external
     * help tier permits it — an unknown id, or a deliberately non-grantable
     * one. The renderer's "Set project default" elevates to it
     * via `setSessionTier`; its "Allow this tool" issues a per-tool grant for
     * the denied tool without changing the session tier at all. A `null`
     * withholds both affordances — the denial isn't actionable.
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
    /**
     * Whether this session is one of Daintree's own assistant surfaces, snapshot
     * alongside the pin and for the same reason (#11789): `revokeSession` clears
     * the origin too, so a callback re-reading it afterwards sees the
     * fail-closed `external` default and drops a notification the renderer needs
     * to show its recovery UI.
     */
    rendererOwned?: boolean;
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

/**
 * Refusal for a request whose session no longer exists (#11799). Static, and
 * names the only recovery there is: nothing about this session can be retried,
 * so a client must open a new one.
 */
const SESSION_GONE_MESSAGE =
  "This MCP session is no longer active. Reconnect to start a new session before retrying.";

/**
 * The `McpError` form of {@link SESSION_GONE_MESSAGE}, for the request paths
 * that signal failure by throwing (discovery and resources) rather than by
 * returning an `isError` tool result. `InternalError` matches how the sibling
 * structural failure `SESSION_BINDING_GONE` is already raised on `tools/list`,
 * so a client reads one JSON-RPC shape for both — the `data.code` is what
 * separates them.
 */
function sessionGoneError(): McpError {
  return new McpError(
    ErrorCode.InternalError,
    SESSION_GONE_MESSAGE,
    buildMcpErrorPayload({ code: SESSION_GONE, message: SESSION_GONE_MESSAGE })
  );
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
    handleProjectRunCheck,
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
    workspaceBinding,
  } = deps;

  /**
   * Whether every call from this session routes to one bound workspace
   * (#11789).
   *
   * Captured from the handshake binding, NOT read live off
   * `sessionWorkspaceMap`. The binding is immutable for the session's life — it
   * is written once at handshake and only ever deleted at teardown — so a live
   * read buys nothing and costs correctness: routing captures the same value
   * once (`boundWorkspaceId` in `buildSessionServerDeps`), so a live read here
   * would let teardown strip the confirm-gated ceiling from a call whose
   * dispatch closure still targets the bound workspace. The two must share one
   * lifetime, and the handshake value is the one that cannot go stale.
   */
  const sessionSurface: SessionSurfacePolicy = {
    workspaceBound: workspaceBinding !== undefined,
  };

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
        // Echo the resolved workspace binding so a client can verify it before
        // issuing a mutation (#11789). `experimental` is the SDK's sanctioned
        // slot for server-defined capabilities and the SDK folds it into the
        // initialize result verbatim — which is why this is declared here
        // rather than by registering our own `InitializeRequestSchema` handler,
        // a second handler would shadow the SDK's `_oninitialize` and lose the
        // `_clientCapabilities` capture that elicitation negotiation reads.
        ...(workspaceBinding
          ? {
              experimental: {
                [WORKSPACE_BINDING_CAPABILITY_KEY]: { ...workspaceBinding },
              },
            }
          : {}),
      },
      // The SDK folds this into the `initialize` result on its own, so no
      // handler of ours is involved (#11541). Passed at construction because
      // that result is built once, at the handshake, and instructions have no
      // update notification — there is no later seam to set them from.
      instructions: MCP_SERVER_INSTRUCTIONS,
    }
  );

  /**
   * The action manifest this session's tool surface is built from.
   *
   * Prefer a live fetch so runtime action-set changes (plugin enable/disable)
   * are reflected. On failure (renderer bridge unavailable / timed out /
   * destroyed) fall back to the last-known cached manifest instead of failing
   * the whole request (#9892). For pinned sessions (#7003) getCachedManifest
   * always returns null, so they correctly fail closed rather than serve
   * another window's tool surface. `=== null` (not `!manifest`) so an empty
   * manifest — a valid zero-tool surface — is not misread as "unavailable".
   *
   * Snapshot the fallback BEFORE the await: getCachedManifest() reads the live
   * session→WebContents map, and a pinned session can be torn down (map entry
   * deleted) while requestManifest() is in flight. Reading it after the await
   * would then see the session as unpinned and return the shared cache —
   * another window's tool surface — defeating #7003. Taken synchronously here,
   * the request is still in flight so the pin holds.
   *
   * Shared by `tools/list` and `mcp.surface` so the two cannot describe
   * different manifests: a surface report built off a stale cache while the
   * listing served a live fetch would be exactly the drift the report exists to
   * detect (#11549). The one place they separate is a workspace-bound session
   * with no reachable view (#12082) — `mcp.surface` is a tool call, so it meets
   * the bound pre-dispatch guard and reports the unreachable route before ever
   * arriving here, which is the honest answer for a report about what this
   * session can reach.
   */
  const resolveManifest = async (
    label: string
  ): Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]> => {
    const cachedFallback = getCachedManifest();
    try {
      return await requestManifest();
    } catch (err) {
      // A workspace this session cannot currently reach is not a reason to have
      // no tools (#12082). The workspace id outlives every view, so the route
      // comes back the moment the user opens that workspace — and a client told
      // "no tools" at discovery has no way to notice when it does. Answer from
      // the host's own base surface instead, and let the per-call route report
      // the truth about reachability.
      //
      // Emphatically NOT `cachedFallback`: that describes whichever other
      // window last reported a manifest, which is the cross-workspace leak the
      // bound path exists to prevent. The base surface is generated from the
      // action registry at commit time and describes nobody's view.
      if (err instanceof WorkspaceBindingError) {
        return getExternalBaseManifest();
      }
      // A dead *pin* still is a dead end (#11789). The session's identity is
      // the destroyed WebContents, not a workspace it can re-resolve, so there
      // is no later state in which this succeeds — and serving a cached
      // manifest would answer `tools/list` from a view this session can no
      // longer reach. Surface SESSION_BINDING_GONE in `data` so a client can
      // tell "reconnect and rebind" from "retry in a moment".
      const routed = routeBindingMcpError(err);
      if (routed) throw routed;
      if (cachedFallback === null) {
        throw new McpError(ErrorCode.InternalError, "Action manifest unavailable");
      }
      console.warn(`[MCP] ${label} using cached manifest after live fetch failed:`, err);
      return cachedFallback;
    }
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Resolve the tier before fetching anything (#11799). Two reasons to gate
    // here rather than after the await: a dead session should not cost a
    // manifest fetch, and `resolveManifest` can itself throw
    // SESSION_BINDING_GONE — which would answer "your workspace went away" to a
    // caller whose actual problem is that its session did.
    const tier = sessionStore.getTier(sessionId);
    // Throw rather than answer with an empty list: `{ tools: [] }` is a
    // well-formed, cacheable "you have no tools", indistinguishable from a
    // legitimately empty surface and carrying no hint that reconnecting is the
    // fix.
    if (tier === null) throw sessionGoneError();
    const manifest = await resolveManifest("tools/list");
    const tools = manifest
      .filter((entry) => shouldExposeTool(entry, tier, sessionSurface))
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
    // Gate 0 (#11799): no live session, no authorization. The SDK's own
    // transport await — body parse and JSON-RPC routing — sits between "the
    // request arrived on a live session" and this handler, so an idle-timer
    // expiry or an abuse trip on a concurrent call can revoke the session in
    // between. Refusing here, before the tier gate, keeps a revoked external
    // bearer off the workbench surface its own allowlist withholds.
    //
    // Returns before anything observable happens: no audit record (there is no
    // honest tier to record it under), no denial counter, no tier-mismatch
    // banner, no grant lookup, no dedup entry, and no dispatch.
    if (tier === null) {
      return buildToolError({ code: SESSION_GONE, message: SESSION_GONE_MESSAGE });
    }
    // Snapshot the turn id once, at dispatch start, before any guard or await
    // can yield to an active→passive FSM transition that would clear it (#10067).
    // Every consumer below — the started/settled strip events and all audit
    // records — receives this same value so one tool call can never split
    // across two turn groupings in the Assistant panel.
    const capturedTurnId: string | null = getCurrentTurnId?.() ?? null;

    const searchLimit = actionId === ACTIONS_SEARCH_TOOL_ID ? readSearchLimit(args) : null;
    const listPaging = actionId === ACTIONS_LIST_TOOL_ID ? readListPaging(args) : null;
    // Discovery must mirror dispatch authority (#11525). The introspection
    // tools enumerate the action registry from the renderer, which has no idea
    // which session called it, so main computes the effective surface here and
    // narrows the result on the way back.
    //
    // "Effective" is the static tier allowlist widened by every live grant —
    // the same three sources the dispatch gate below consults. Native
    // automation grants (#10648) matter most: they are issued up front with an
    // explicit `allowedTools` set, so ignoring them would leave an agent unable
    // to find the very tools it was just approved for. Reads go through the
    // non-evicting `getLive*` snapshots; `grantCache.check` / `peekNativeGrant`
    // would delete expired entries and push spurious `grant.expired` lifecycle
    // events on every discovery call.
    const introspectionSurface = INTROSPECTION_TOOL_IDS.has(actionId)
      ? (() => {
          // Snapshotted once and reused for both the permitted set and the
          // policy record (#11910), so the surface a lookup is filtered against
          // and the authorization it reports can never describe two different
          // instants.
          const perToolGrantedActionIds = new Set<string>(
            sessionStore.grantCache.getLiveGrants(sessionId).map((grant) => grant.toolId)
          );
          // Filtered to what the dispatch gate would actually honour: a grant
          // listing a per-resolved-target tool buys nothing, because
          // `peekNativeGrant` refuses it (#12121). Naming it here would produce
          // the discoverable-but-uncallable state #11585 rejects — an agent
          // would find `terminal.killAll` in `actions.search`, then be told
          // TIER_NOT_PERMITTED when it called it.
          const nativeGrantedActionIds = new Set<string>(
            sessionStore.grantCache
              .getLiveNativeGrants(sessionId)
              .flatMap((grant) => [...grant.allowedTools])
              .filter((toolId) => isGenericNativeGrantEligible(toolId))
          );
          return {
            permittedActionIds: new Set<string>([
              ...getTierPermittedActionIds(tier),
              ...perToolGrantedActionIds,
              ...nativeGrantedActionIds,
            ]),
            callerLimit: searchLimit ?? ACTIONS_SEARCH_DEFAULT_LIMIT,
            requestedActionId: readRequestedActionId(args),
            ...(listPaging ? { listPaging } : {}),
            policySnapshot: {
              tier,
              // Asked of the ORIGIN, never inferred from the tier: an
              // unrecognised bearer token resolves to `workbench` while its
              // origin still defaults to `external`, and grant issuance gates
              // on the origin.
              rendererOwnedOrigin: sessionStore.isRendererOwnedOrigin(sessionId),
              perToolGrantedActionIds,
              nativeGrantedActionIds,
            } satisfies TargetPolicySessionSnapshot,
          };
        })()
      : null;
    // `actions.search` ranks and slices in the renderer, before main can see
    // tier. Over-fetching the schema's maximum page makes that slice the
    // complete match set for any query matching at most that many actions, so
    // filtering it yields an exact count and a full page instead of a starved
    // one. Only the forwarded copy is widened — `args` still feeds the audit
    // record, which must report what the caller actually asked for. A `limit`
    // the tool contract forbids yields a null `searchLimit` and is left alone,
    // so the renderer's own validation still rejects it rather than having the
    // over-fetch quietly rewrite it into a legal request.
    const dispatchArgs =
      searchLimit !== null && args && typeof args === "object" && !Array.isArray(args)
        ? { ...(args as Record<string, unknown>), limit: ACTIONS_SEARCH_MAX_LIMIT }
        : args;

    // Set once the ownership gate inside the IIFE has cleared, and read by the
    // delegated dispatch and the post-cleanup release. Undefined for every
    // other tool and for a refused cleanup, so neither of those paths can
    // accidentally rewrite an action id or drop an ownership record (#11909).
    const ownedCleanup = OWNED_CLEANUP_TOOLS[actionId];
    let ownedResourceId: string | undefined;

    /**
     * Fold a completed dispatch into the session's ownership ledger (#11909):
     * record what it created, and release what it cleaned up.
     *
     * Both halves read the envelope the action returned — never the caller's
     * arguments — which is what makes the ledger an authorization boundary
     * rather than a claim the caller writes about itself.
     *
     * The release half is deliberately conditional on the resource actually
     * being gone. `terminal.close` reports an empty `closedIds` when it found
     * nothing to close, and dropping the record on that would let one no-op
     * call revoke the session's authority over a panel that is still running.
     */
    const recordDispatchOwnership = (envelope: DispatchEnvelope): void => {
      if (ownedCleanup !== undefined) {
        if (ownedResourceId === undefined || !envelope.result.ok) return;
        if (
          ownedCleanup.resourceKind === "terminal" &&
          !closedIdsInclude(envelope.result.result, ownedResourceId)
        ) {
          return;
        }
        sessionStore.resourceOwnership.release(
          sessionId,
          ownedCleanup.resourceKind,
          ownedResourceId
        );
        return;
      }
      const drafts = extractOwnedResourcesFromDispatch(actionId, envelope.result);
      if (drafts.length === 0) return;
      // Liveness guard, mirroring the dedup completion hook below: a creation
      // admitted before the session was revoked can land after
      // `clearSessionBinding` already dropped the ledger. Writing then would
      // resurrect a dead session's authority — and, worse, claim the id away
      // from whoever legitimately records it next.
      if (!sessionStore.sessions.has(sessionId) && !sessionStore.httpSessions.has(sessionId)) {
        return;
      }
      sessionStore.resourceOwnership.record(
        sessionId,
        drafts,
        envelope.dispatchedWorkspace?.workspaceId
      );
    };

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
    //   3. Native session-scoped automation grants (#10648) — the only layer
    //      that both widens past the floor AND pre-authorises the
    //      `danger: "confirm"` modal. Because that second job answers a
    //      different question from "may this call run at all", the lookup is
    //      independent of whichever layer admitted the call (#11878).
    //
    // The order means a session whose static tier already permits the action
    // never consults the per-tool grant cache — those grants only widen the
    // floor and never bypass confirmation, so they have nothing to add once
    // the floor allows the call. Native grants are not ordered that way: see
    // the peek below for why nesting them under any one admission source is
    // what made them unreachable in the first place.
    const tierPermitted = isTierPermitted(tier, actionId);
    let grantIssuedAt: number | undefined;
    // Set when a native session-scoped automation grant (#10648) authorized
    // this call. Captured here so the post-dispatch path can refresh the
    // grant's TTL window, and so the `danger: "confirm"` modal is bypassed —
    // a native grant is an explicit user approval of the tool's scope.
    let nativeGrantId: string | undefined;
    // True once something OTHER than a native grant has admitted this call —
    // the static floor, or a per-tool "Approve once" grant. It decides two
    // things below: whether a missing native grant is fatal, and how a lost
    // one is handled at the consume site.
    let authorizedWithoutNativeGrant = tierPermitted;
    if (!tierPermitted) {
      const grant = sessionStore.grantCache.check(sessionId, actionId);
      if (grant.granted) {
        // Grant authorised the call. Capture the `issuedAt` token so the
        // post-dispatch refresh can verify the entry wasn't revoked and
        // re-issued under us (race guard, lesson #2243).
        grantIssuedAt = grant.issuedAt;
        authorizedWithoutNativeGrant = true;
      }
    }
    // A native automation grant does two jobs, and only the first is a floor
    // concern: it widens past the floor, AND it pre-authorises the
    // `danger: "confirm"` modal. The second is orthogonal to whatever admitted
    // the call, so the peek cannot be nested under any one admission source
    // (#11878). It used to sit inside the tier-denied branch, behind the
    // per-tool check — which left the grant unreachable both for a tool the
    // tier already permitted (`worktree.delete` is `danger: "confirm"` and sits
    // on the `action` floor since #12116) and for one a per-tool grant had just
    // admitted.
    // Either way the modal still fired on every call despite an explicit
    // Settings pre-authorisation.
    //
    // The one exception: an introspection carrier is never confirm-gated, so
    // once the call is already admitted a grant buys it nothing — peeking
    // would only spend a use and evict entries on a discovery call. When the
    // call is NOT otherwise admitted the peek still runs, because there the
    // grant is doing its first job and is load-bearing for authorization.
    if (!authorizedWithoutNativeGrant || !INTROSPECTION_TOOL_IDS.has(actionId)) {
      // The use is NOT charged here: it is consumed only once the call is
      // committed to dispatching (below), so an unauthorized call can't burn
      // a use. The grant's allowlist gates which tools this authorizes.
      const native = sessionStore.grantCache.peekNativeGrant(sessionId, actionId);
      if (native.granted) {
        nativeGrantId = native.grantId;
      }
    }
    if (!authorizedWithoutNativeGrant && nativeGrantId === undefined) {
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
          startedAt,
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
          // Snapshot ownership with the pin, before revocation clears both.
          const rendererOwned = sessionStore.isRendererOwnedOrigin(sessionId);
          sessionStore.revokeSession(sessionId);
          clearDenialState?.(sessionId);
          if (notifySessionRevoked) {
            try {
              notifySessionRevoked({
                sessionId,
                denialKind: "tierMismatch",
                pinnedWebContentsId: pinnedId,
                rendererOwned,
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

    // Confirm-gated tools are unreachable for a workspace-bound external
    // session, so refuse them here — after tier/grant admission, but before a
    // native grant use is charged, before dedup can cache an answer, and long
    // before anything reaches a renderer (#11789).
    //
    // Placed after the tier gate so a tool that is simply outside the surface
    // still reports TIER_NOT_PERMITTED, which is the truer answer. Placed
    // before everything else because this is a hard ceiling: a live per-tool or
    // native grant widens dispatch past the tier floor, and must not widen past
    // this one — the dialog those grants would bypass is the same dialog nobody
    // is watching.
    if (sessionSurface.workspaceBound && tier === "external") {
      let boundManifest: import("../../../shared/types/actions.js").ActionManifestEntry[];
      try {
        boundManifest = getCachedManifest() ?? (await requestManifest());
      } catch (err) {
        // Fail closed. Proceeding on an unresolved manifest would erase the
        // only evidence that this action needs confirmation, turning a refusal
        // into an unattended dispatch. Audited as a throw, matching how the
        // post-dispatch binding failure below records the same class of error.
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            startedAt,
            outcome: { kind: "throw", error: err },
            capturedTurnId,
          });
        } catch (auditErr) {
          console.error("[MCP] Failed to append audit record:", auditErr);
        }
        if (err instanceof McpRouteBindingError) {
          // Deliberately NOT answered from the host base surface, unlike
          // `tools/list` (#12082). Discovery describes what exists; this gate
          // decides whether a specific call runs unattended, and the host
          // catalog is not evidence about the bound view. Fail closed, and say
          // so retriably when the route can come back.
          return buildToolError({
            code: SESSION_BINDING_GONE,
            message: err.message,
            retriable: err.retriable,
          });
        }
        return buildToolError({
          code: EXECUTION_ERROR_CODE,
          message: formatErrorMessage(
            err,
            `Could not resolve the action surface for workspace-bound tool '${actionId}'`
          ),
        });
      }

      const withheldIds = new Set(
        boundManifest
          .filter((entry) => isWithheldFromBoundSession(entry, tier, sessionSurface))
          .map((entry) => entry.id)
      );

      // Discovery must mirror dispatch authority (#11525): narrow the
      // introspection surface by the same ceiling, after the grant union, so a
      // grant can never make a withheld tool findable.
      if (introspectionSurface) {
        for (const withheldId of withheldIds) {
          introspectionSurface.permittedActionIds.delete(withheldId);
        }
      }

      // Which launch argument elevated a `terminal.new` dispatch, in the
      // resolver's own precedence — a command is the stronger claim, so it wins
      // when both are present. Scoped by action id for the reason the resolver
      // is: `command` is an ordinary field name that other safe actions take
      // without running anything.
      const terminalLaunchArg =
        actionId === TERMINAL_LAUNCH_ACTION_ID
          ? readDispatchTerminalCommand(args) !== undefined
            ? "command"
            : readDispatchTerminalCwd(args) !== undefined
              ? "cwd"
              : undefined
          : undefined;

      // A dispatch can need confirmation for any of three reasons, and none of
      // them is satisfiable here. The first is the manifest's own `danger:
      // "confirm"`, collected into `withheldIds` above. The other two are
      // args-conditional: the host elevates any agent-sourced dispatch carrying
      // a `recipeId` to `"confirm"` (#11860), so a statically-`safe` composite
      // like `worktree.createWithRecipe` clears the withheld set, and it
      // elevates a `terminal.new` carrying `command` or `cwd` for the same
      // reason (#12216) — both would then raise the very dialog this guard
      // exists to avoid. Read through the same extraction points the elevation
      // uses, so the refusal and the elevation can never disagree about which
      // dispatches are gated.
      const boundConfirmRefusal = withheldIds.has(actionId)
        ? `Action '${actionId}' requires confirmation, and this MCP session is bound to workspace ` +
          `'${workspaceBinding?.workspaceId}', which runs in the background with no one ` +
          `watching it to approve the dialog. The action was not run. Confirm-gated actions are not part ` +
          `of a workspace-bound session's tool surface — run this one from Daintree, or connect without a ` +
          `workspace binding.`
        : dispatchCarriesRecipeId(args)
          ? `Action '${actionId}' was called with a 'recipeId', so it would start that recipe's ` +
            `terminals and requires confirmation. This MCP session is bound to workspace ` +
            `'${workspaceBinding?.workspaceId}', which runs in the background with no one watching it ` +
            `to approve the dialog. The action was not run — call it without a 'recipeId', run the ` +
            `recipe from Daintree, or connect without a workspace binding.`
          : terminalLaunchArg !== undefined
            ? `Action '${actionId}' was called with a '${terminalLaunchArg}', so it would start a shell and ` +
              `requires confirmation. This MCP session is bound to workspace ` +
              `'${workspaceBinding?.workspaceId}', which runs in the background with no one watching it ` +
              `to approve the dialog. The action was not run — call it without 'command' or 'cwd', open ` +
              `the terminal from Daintree, or connect without a workspace binding.`
            : undefined;

      if (boundConfirmRefusal !== undefined) {
        const message = boundConfirmRefusal;
        const value: import("../../../shared/types/actions.js").ActionDispatchResult = {
          ok: false,
          error: {
            code: CONFIRMATION_REQUIRED_CODE,
            message,
            // Distinct from the `"unavailable"` a windowless host reports: that
            // one clears when a window opens, so retrying is sane. This one is
            // structural for the life of the session, so retrying never is.
            details: { confirmationChannel: "workspace-bound" },
          },
        };
        try {
          appendAuditRecord({
            toolId: actionId,
            sessionId,
            tier,
            args,
            durationMs: Date.now() - startedAt,
            startedAt,
            outcome: { kind: "result", value },
            capturedTurnId,
          });
        } catch (err) {
          console.error("[MCP] Failed to append audit record:", err);
        }
        return buildToolError({
          code: CONFIRMATION_REQUIRED_CODE,
          message,
          details: { confirmationChannel: "workspace-bound" },
        });
      }
    }

    // Charge the native automation grant's use now that the call has cleared
    // the tier/grant check and is committed to proceeding (#10648). Doing it
    // here — not at the peek above — means an unauthorized call never burns a
    // use. A `false` return is purely defensive: the grant was live at the
    // peek, so it can only have aged out or been revoked in between.
    //
    // How that failure lands depends on what else admitted the call (#11878).
    // When the grant WAS the authorization, losing it fails closed. When the
    // floor or a per-tool grant already admitted it, the grant only bought a
    // confirmation bypass — so drop the bypass and let the normal modal
    // decide. Refusing there would answer an `action`-tier `worktree.delete`
    // with "not permitted for the 'action' tier", which is simply untrue.
    //
    // Accounting note: a matching call spends a use even when the tool is not
    // confirm-gated, so the grant buys it nothing. Charging only where the
    // bypass is actually needed would mean resolving effective danger — the
    // async manifest plus args-conditional elevation — before this point,
    // which is a far larger change than the bug warrants. Two consequences
    // are worth knowing rather than assuming away: a matching call also
    // slides the whole grant's TTL, so a harmless tool in a mixed grant can
    // extend a confirm-gated sibling's bypass window (bounded by the hard
    // lifetime ceiling), and because this site precedes dedup, a replayed
    // duplicate spends a use without dispatching.
    //
    // One use is also the ONLY cost this site can express, which is why a tool
    // that fans out across every target it resolves at dispatch time is barred
    // from native grants entirely rather than charged here (#12121). Learning
    // that count would mean reaching into the renderer before the charge — the
    // async dependency the paragraph above rules out — so `peekNativeGrant`
    // never hands one back a grant id and `nativeGrantId` stays undefined:
    // no bypass, no use, and the confirm modal decides as it normally would.
    if (nativeGrantId !== undefined) {
      const consumed = sessionStore.grantCache.consumeNativeGrantUse(nativeGrantId, actionId);
      if (!consumed) {
        if (!authorizedWithoutNativeGrant) {
          return buildToolError({
            code: TIER_NOT_PERMITTED_CODE,
            message: `action '${actionId}' is not permitted for the '${tier}' tier.`,
          });
        }
        nativeGrantId = undefined;
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
                startedAt,
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
              startedAt,
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
              startedAt,
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
            startedAt,
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
        // Ownership gate for the `*Owned` cleanup tools (#11909). Placed at the
        // very top of the IIFE: a session that does not own the named resource
        // is refused here, before the activity strip is told a call started,
        // before any confirmation is raised, and — the acceptance criterion
        // that matters — before anything reaches a renderer, so a refused call
        // cannot have mutated a panel or a worktree.
        if (ownedCleanup !== undefined) {
          const resourceId = readOwnedResourceId(args, ownedCleanup.idArg);
          if (resourceId === undefined) {
            const message =
              `Action '${actionId}' requires a non-empty '${ownedCleanup.idArg}' naming a resource ` +
              `this session created.`;
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: "VALIDATION_ERROR", message } },
            };
            return buildToolError({ code: "VALIDATION_ERROR", message });
          }
          const record = sessionStore.resourceOwnership.get(
            sessionId,
            ownedCleanup.resourceKind,
            resourceId
          );
          // One message for "never existed", "another session's", and "the
          // user's" — see RESOURCE_NOT_OWNED_CODE for why the three must not be
          // distinguishable. The bound-workspace comparison below is
          // defence-in-depth only and fails OPEN when either side is unknown:
          // panel ids carry a UUID and worktree ids are absolute paths, so a
          // cross-workspace collision is not a live risk, and a strict check
          // would strand a caller's own cleanup whenever the creating dispatch
          // could not resolve its workspace.
          const boundWorkspaceId = sessionStore.sessionWorkspaceMap.get(sessionId);
          const workspaceMismatch =
            record !== undefined &&
            record.workspaceId !== undefined &&
            boundWorkspaceId !== undefined &&
            record.workspaceId !== boundWorkspaceId;
          if (record === undefined || workspaceMismatch) {
            const message =
              `No ${ownedCleanup.resourceKind} with id '${resourceId}' was created by this session, so ` +
              `'${actionId}' will not act on it. This tool only cleans up resources this ` +
              `connection created; ids from listings may belong to the user, another client, or a plugin.`;
            outcome = {
              kind: "result",
              value: { ok: false, error: { code: RESOURCE_NOT_OWNED_CODE, message } },
            };
            return buildToolError({ code: RESOURCE_NOT_OWNED_CODE, message });
          }
          ownedResourceId = resourceId;
        }

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

        // Short-circuit: mcp.surface runs entirely in the main process (#11549).
        // The action manifest entry (renderer) carries schema/tier/audit, but
        // the answer cannot be built there: the caller's authorization tier is
        // session state that only main holds, and the renderer has no idea
        // which MCP session dispatched it. Building it here also means the
        // report and `tools/list` apply one `shouldExposeTool` gate to one
        // manifest, rather than a renderer-side enumeration that a post-dispatch
        // filter then has to narrow back down (#11525).
        //
        // Read-only and never `danger: "confirm"` — it reports what this session
        // was already told, so the strip shows a plain in-flight row.
        if (actionId === MCP_SURFACE_TOOL_ID) {
          emitToolCallStarted(false);
          try {
            const manifest = await resolveManifest(MCP_SURFACE_TOOL_ID);
            // Build against the tier captured at dispatch start — the one the
            // permission gate above actually authorized this call at — rather
            // than re-reading after the await. Authorization has one lifetime
            // per call: revocation stops the *next* request, but does not
            // rewrite a call already admitted, and an elevation or decay landing
            // mid-fetch belongs to the next request too. Re-reading would make
            // the report disagree with both the gate that admitted the call and
            // the audit record, which logs this same value. A tier that changes
            // mid-call fires `notifications/tools/list_changed`, so a client
            // re-reads anyway.
            const result = buildSurfaceManifest(
              manifest,
              tier,
              app.getVersion(),
              // Same binding the gate above authorized this call against, and
              // the same one `tools/list` filters by — so the report can never
              // advertise a tool the listing withholds (#11789).
              sessionSurface
            );
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
              message: formatErrorMessage(err, "mcp.surface failed"),
            });
          }
        }

        // Short-circuit: project.runCheck runs entirely in the main process
        // (#11548). The action manifest entry (renderer) carries schema, tier,
        // and audit metadata, but execution must stay here because (a) it
        // spawns a real child process and reads its exit code, (b) the MCP
        // AbortSignal can't cross IPC — without it a runaway suite could never
        // be cancelled — and (c) renderer dispatch has a 30s wall, shorter than
        // almost any real test run. Same shape as the waitUntilIdle branch;
        // audit + strip-settle unify via the shared `finally`.
        if (actionId === PROJECT_RUN_CHECK_TOOL) {
          // Never `danger: "confirm"` — the runner is one the project already
          // declares, so the strip shows a plain in-flight row.
          emitToolCallStarted(false);
          try {
            const result = await handleProjectRunCheck(args, extra.signal);
            outcome = { kind: "result", value: { ok: true, result } };
            // A check can outlive the 15-min grant window, so mirror the main
            // path's post-dispatch grant refresh — otherwise a long suite
            // silently ages the grant out mid-run (same reasoning as #8442).
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
            // Reaching here means the check could not start at all (unknown
            // runner, unusable cwd, busy target). A check that ran and failed
            // resolved above with `passed: false` — the two must stay
            // distinguishable to the caller.
            return buildToolError({
              code: EXECUTION_ERROR_CODE,
              message: formatErrorMessage(err, "project.runCheck failed"),
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

        let entry: import("../../../shared/types/actions.js").ActionManifestEntry | undefined;
        try {
          entry = await lookupManifestEntry(actionId, getCachedManifest, requestManifest);
        } catch (err) {
          if (!(err instanceof McpRouteBindingError)) throw err;
          // Narrow in practice — the bound guard above resolves a manifest
          // first — but reachable if the route is lost between the two.
          outcome = { kind: "throw", error: err };
          return buildToolError({
            code: SESSION_BINDING_GONE,
            message: err.message,
            retriable: err.retriable,
          });
        }

        // An action the manifest doesn't describe has unknown danger, and
        // unknown is not safe: a stale or partial manifest that omits a
        // newly-registered confirm-gated action would otherwise let exactly the
        // call the guard above exists to refuse reach a renderer nobody is
        // watching (#11789). Sited here rather than beside that guard because
        // every main-process short circuit has already returned by this point,
        // so whatever is still running is renderer-bound by construction —
        // which beats maintaining a list of exempt tool ids that would silently
        // rot the next time a main-process tool is added.
        if (sessionSurface.workspaceBound && tier === "external" && entry === undefined) {
          const message =
            `Action '${actionId}' is not present in workspace '${workspaceBinding?.workspaceId}'s action surface, ` +
            `so this workspace-bound session cannot establish whether it needs confirmation. The action was not run.`;
          outcome = {
            kind: "result",
            value: { ok: false, error: { code: "NOT_FOUND", message } },
          };
          return buildToolError({ code: "NOT_FOUND", message });
        }

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

        /**
         * Collect every page of an `actions.list` match set. The renderer pages
         * before main can apply the tier filter (#11529), so filtering one of its
         * pages would return a short page whose `total`/`hasMore` counted actions
         * this session cannot dispatch. Walking the pages here lets the filter
         * page the *permitted* set instead, which keeps the contract coherent.
         * Entries carry no schemas, so this is a handful of cheap round trips.
         */
        const collectListPages = async (): Promise<DispatchEnvelope> => {
          const base = args && typeof args === "object" && !Array.isArray(args) ? args : {};
          const collected: unknown[] = [];
          let offset = 0;
          let confirmationDecision: DispatchEnvelope["confirmationDecision"];
          // The target is resolved once, before paging, so every page lands on
          // the same workspace — carrying the first page's ref out with the
          // synthesized envelope lets the caller stamp the paged result through
          // the same `withResolvedWorkspace` path the single-shot dispatch uses
          // (#11536). Skipping it would silently drop the field from exactly the
          // calls that walked more than one page.
          let pagedWorkspace: DispatchedWorkspaceRef | undefined;
          // The registry is a few hundred actions; the cap only stops a renderer
          // that never stops reporting `hasMore`.
          for (let page = 0; page < MAX_LIST_PAGE_WALK; page++) {
            const envelope = await dispatchAction(
              actionId,
              { ...(base as Record<string, unknown>), offset, limit: ACTIONS_LIST_MAX_LIMIT },
              dispatchConfirmed
            );
            confirmationDecision = confirmationDecision ?? envelope.confirmationDecision;
            pagedWorkspace = pagedWorkspace ?? envelope.dispatchedWorkspace;
            if (!envelope.result.ok) return envelope;
            const payload = envelope.result.result as
              { actions?: unknown; hasMore?: unknown } | null | undefined;
            if (!payload || !Array.isArray(payload.actions)) break;
            collected.push(...payload.actions);
            if (payload.hasMore !== true || payload.actions.length === 0) break;
            offset += ACTIONS_LIST_MAX_LIMIT;
          }
          return {
            result: { ok: true, result: { actions: collected } },
            confirmationDecision,
            ...(pagedWorkspace ? { dispatchedWorkspace: pagedWorkspace } : {}),
          };
        };

        try {
          // An `*Owned` cleanup that cleared the gate above delegates to the
          // real action under its own id, with arguments rebuilt from scratch
          // rather than forwarded (#11909). Rebuilding is the enforcement: the
          // renderer validates against `worktree.delete`'s schema, which still
          // accepts `force`, `deleteBranch` and `closeTerminals`, so anything
          // the caller sent beyond the id would otherwise pass straight
          // through the narrower tool that deliberately omits them.
          const envelope = listPaging
            ? await collectListPages()
            : ownedCleanup !== undefined && ownedResourceId !== undefined
              ? await dispatchAction(
                  ownedCleanup.delegateTo,
                  { [ownedCleanup.idArg]: ownedResourceId },
                  dispatchConfirmed
                )
              : await dispatchAction(actionId, dispatchArgs, dispatchConfirmed);
          // Narrow registry-enumerating results to this session's effective
          // surface before anything downstream reads them (#11525). Placed
          // ahead of the `outcome` assignment so the text content, the
          // structuredContent block, and the audit record all observe one
          // filtered value — and so both the pinned and unpinned dispatch
          // paths, which converge on this call, are covered by the same gate.
          outcome = {
            kind: "result",
            value: introspectionSurface
              ? filterIntrospectionResultForSession(
                  actionId,
                  envelope.result,
                  introspectionSurface.permittedActionIds,
                  introspectionSurface
                )
              : envelope.result,
          };
          // Ownership bookkeeping, from the envelope the action actually
          // returned rather than from anything the caller said (#11909).
          // Reads `envelope.result`, not `outcome.value`: the introspection
          // filter above rewrites results for the discovery tools, and the
          // ledger must observe the unnarrowed truth. Recorded for every tier
          // — "this session created it" is a fact about the session, not about
          // its privileges.
          recordDispatchOwnership(envelope);
          confirmationDecision = confirmationDecision ?? envelope.confirmationDecision;
          dispatchedWorkspace = envelope.dispatchedWorkspace;
        } catch (err) {
          outcome = { kind: "throw", error: err };
          if (err instanceof McpRouteBindingError) {
            return buildToolError({
              code: SESSION_BINDING_GONE,
              message: err.message,
              // Instance-derived: a workspace the user can reopen is retriable,
              // a destroyed pinned view never is, and both report this code.
              retriable: err.retriable,
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
            startedAt,
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

  // Each resource handler resolves the tier once at entry and threads it down
  // (#11799). One capture per request: the listing helpers await dispatches
  // mid-enumeration, and re-reading across those awaits would let one response
  // mix two authorization lifetimes.
  /**
   * Confirm a workspace-bound session can still reach its workspace, for a read
   * that would otherwise never consult it (#12082).
   *
   * Most resources are backed by a dispatch, so the binding is checked by the
   * routing itself. `agentState` is not: it answers from the process-global
   * `AgentAvailabilityStore`, and its tier gate (`terminal.list`) says nothing
   * about *which* workspace the agent belongs to. Before this issue a bound
   * session could not exist without a live view, so the viewless case was
   * unreachable; now it is, and a bound session with an unreachable workspace
   * must not read host-global state as if it were its own.
   *
   * Deliberately a route check, not an ownership check. Whether a given agent id
   * belongs to the bound workspace is a separate, pre-existing gap in #11789 —
   * a bound session with a *live* view can still read another workspace's agent
   * state, and closing that needs an agent→workspace map this layer does not
   * have. This closes only the half that is new.
   *
   * Probing through `requestManifest` rather than a bespoke resolver keeps the
   * answer identical to the one dispatch would get: it re-resolves the workspace
   * the same way and reads a warm per-view cache on success.
   */
  const assertBoundRouteReachable = async (): Promise<void> => {
    if (!sessionSurface.workspaceBound) return;
    try {
      await requestManifest();
    } catch (err) {
      const routed = routeBindingMcpError(err);
      if (routed) throw routed;
      // Anything else is a manifest failure, not a routing one. The read does
      // not need a manifest, so it is not this probe's business to fail it.
    }
  };

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const tier = sessionStore.getTier(sessionId);
    if (tier === null) throw sessionGoneError();
    return { resources: await listConcreteResources(tier, deps) };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const tier = sessionStore.getTier(sessionId);
    if (tier === null) throw sessionGoneError();
    return { resourceTemplates: listResourceTemplates(tier) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const tier = sessionStore.getTier(sessionId);
    if (tier === null) throw sessionGoneError();
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    if (!isResourcePermitted(tier, parsed.kind)) {
      const message = `Resource '${uri}' is not permitted for the '${tier}' tier.`;
      throw new McpError(
        ErrorCode.InvalidRequest,
        message,
        buildMcpErrorPayload({ code: TIER_NOT_PERMITTED_CODE, message })
      );
    }
    if (parsed.kind === "agentState") await assertBoundRouteReachable();
    try {
      return { contents: [await readResourceContents(uri, parsed, dispatchAction)] };
    } catch (err) {
      const routed = routeBindingMcpError(err);
      if (routed) throw routed;
      throw err;
    }
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    // Gated before `subscribeResource` can install an event listener, so a
    // revoked session never leaves a subscription behind for a transport that
    // is already gone.
    const tier = sessionStore.getTier(sessionId);
    if (tier === null) throw sessionGoneError();
    const uri = request.params.uri;
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource URI: ${uri}`);
    }
    if (!isResourcePermitted(tier, parsed.kind)) {
      const message = `Resource '${uri}' is not permitted for the '${tier}' tier.`;
      throw new McpError(
        ErrorCode.InvalidRequest,
        message,
        buildMcpErrorPayload({ code: TIER_NOT_PERMITTED_CODE, message })
      );
    }
    // Same reason as the read above: an `agentState` subscription installs a
    // listener on a process-global event and would push another workspace's
    // updates at a session that cannot reach its own.
    if (parsed.kind === "agentState") await assertBoundRouteReachable();
    subscribeResource(sessionId, server, uri, parsed, sessionStore);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    unsubscribeResource(sessionId, request.params.uri, sessionStore);
    return {};
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    if (sessionStore.getTier(sessionId) === null) throw sessionGoneError();
    return {
      prompts: PROMPT_DEFINITIONS.map((def) => ({
        name: def.name,
        description: def.description,
        arguments: def.arguments,
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    // Prompts render from live IDE state: `collectPromptContext` dispatches
    // `worktree.getCurrent`, and `triage_failed_agent` also reads terminal
    // output. That is a renderer dispatch on behalf of the session, so it
    // belongs behind the same liveness gate as `tools/call` — otherwise a
    // revoked bearer still reads worktree and terminal data through the prompt
    // surface, which is the leak this issue is about wearing a different hat.
    if (sessionStore.getTier(sessionId) === null) throw sessionGoneError();
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
  tier: McpTier,
  deps: SessionServerDeps
): Promise<Array<{ uri: string; name: string; mimeType: string; description?: string }>> {
  const resources: Array<{ uri: string; name: string; mimeType: string; description?: string }> =
    [];
  if (isResourcePermitted(tier, "issues")) {
    resources.push({
      uri: "daintree://project/current/issues",
      name: "Current project — open issues",
      mimeType: "application/json",
      description: "Open issues for the active project.",
    });
  }
  if (isResourcePermitted(tier, "pulse")) {
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
  if (isResourcePermitted(tier, "scrollback") || isResourcePermitted(tier, "agentState")) {
    const terminals = await tryDispatchList("terminal.list", deps.dispatchAction);
    for (const term of terminals) {
      const id = readStringField(term, ["id", "terminalId"]);
      const label = readStringField(term, ["title", "name"]) ?? id;
      if (id && isResourcePermitted(tier, "scrollback")) {
        resources.push({
          uri: `daintree://terminal/${encodeURIComponent(id)}/scrollback`,
          name: `Terminal scrollback — ${label ?? id}`,
          mimeType: "text/plain",
          description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
        });
      }
      const agentId = readStringField(term, ["agentId"]);
      if (agentId && isResourcePermitted(tier, "agentState")) {
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
  tier: McpTier
): Array<{ uriTemplate: string; name: string; mimeType: string; description?: string }> {
  const templates: Array<{
    uriTemplate: string;
    name: string;
    mimeType: string;
    description?: string;
  }> = [];
  if (isResourcePermitted(tier, "pulse")) {
    templates.push({
      uriTemplate: "daintree://worktree/{id}/pulse",
      name: "Worktree pulse",
      mimeType: "application/json",
      description: "Git status summary, recent commits, and pull-request signal.",
    });
  }
  if (isResourcePermitted(tier, "scrollback")) {
    templates.push({
      uriTemplate: "daintree://terminal/{id}/scrollback",
      name: "Terminal scrollback",
      mimeType: "text/plain",
      description: `Last ${RESOURCE_SCROLLBACK_TAIL_LINES} lines of terminal output.`,
    });
  }
  if (isResourcePermitted(tier, "agentState")) {
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
    // Explicit rather than riding the action's default: this resource is read
    // whole and then truncated, so the compact projection is the point.
    const envelope = await dispatchAction("forge.listIssues", { view: "summary" });
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
    // An unreachable route is not an empty workspace (#12082). Swallowing it
    // here would answer `resources/list` with an authoritative-looking "you
    // have nothing" for a bound session whose workspace is simply not open —
    // the same lie the terminal handshake used to tell, in a quieter place.
    // Ordinary enumeration failures keep degrading to a partial listing.
    const routed = routeBindingMcpError(err);
    if (routed) throw routed;
    console.error(`[MCP] Failed to enumerate resources via ${actionId}:`, err);
    return [];
  }
}

/**
 * Pure tier check — takes the tier its caller already resolved rather than
 * reading the store again (#11799). The resource handlers resolve liveness once
 * at entry, so this helper is only ever reached for a live session, and the
 * twelve call sites across the two listing helpers share that one capture
 * instead of racing the store twelve separate times.
 */
function isResourcePermitted(tier: McpTier, kind: string): boolean {
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

/**
 * The structured envelope a route-binding failure must reach the client as
 * (#12082).
 *
 * `McpRouteBindingError` is one of ours: it carries a string `code` and no
 * `data`, and the SDK only preserves numeric codes and explicit `error.data`,
 * so letting one escape a handler serializes it as a bare `-32603` with the
 * `SESSION_BINDING_GONE` reason and the `retriable` verdict both stripped. Every
 * surface that can raise one converts it here, so a client reads one shape
 * whichever request hit it.
 */
function routeBindingMcpError(err: unknown): McpError | null {
  if (!(err instanceof McpRouteBindingError)) return null;
  return new McpError(
    ErrorCode.InternalError,
    err.message,
    buildMcpErrorPayload({
      code: SESSION_BINDING_GONE,
      message: err.message,
      retriable: err.retriable,
    })
  );
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
    } catch (err) {
      // A route that is gone is not a manifest that is merely unavailable
      // (#12082). Collapsing it to `undefined` here makes the bound-session
      // guard below report a non-retriable `NOT_FOUND` — "no such action" — for
      // a workspace the user is about to reopen.
      if (err instanceof McpRouteBindingError) throw err;
      return undefined;
    }
  }
  return manifest.find((e) => e.id === actionId);
}
