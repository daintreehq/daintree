// eager-import-allow: reads MCP server config via store.get synchronously during lifecycle setup
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { webContents as webContentsModule } from "electron";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { summarizeMcpArgs, summarizeMcpResult } from "../../../shared/utils/mcpArgsSummary.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { sanitizePath } from "../../utils/pathScrubber.js";
import type {
  HelpTokenValidator,
  HelpSessionWebContentsResolver,
  HelpSessionActionContextResolver,
  HelpSessionIdResolver,
  AssistantPaneWebContentsResolver,
  AssistantPaneActionContextResolver,
  McpTier,
  McpSessionOrigin,
  McpWorkspaceBinding,
} from "./shared.js";
import { parseWorkspaceSelector, type WorkspaceSelectorRejection } from "./workspaceSelector.js";
import { WorkspaceBindingError } from "./rendererBridge.js";
import { isProjectWorkspaceId, isScratchWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import type {
  ActiveBearerRecord,
  HelpSessionBearerRecord,
  McpActiveClientInfo,
  McpBearerIdentity,
  McpIssueGrantResult,
  McpIssueNativeGrantResult,
  McpRevokeNativeGrantResult,
  McpRevokeSessionGrantsResult,
  McpTurnOutcomeAlertPayload,
} from "../../../shared/types/ipc/mcpServer.js";
import {
  extractBearerToken,
  isAuthorized,
  precomputeApiKeyBearerHash,
  resolveTokenTier,
} from "./tierAuth.js";
import { createSessionServer, cleanupResourceSubscriptions } from "./sessionServer.js";
import type { SessionStore } from "./sessionStore.js";
import type { AuditService } from "./auditLog.js";
import { classifyMcpDispatchResult } from "./auditLog.js";
import { computeMcpAuditSeverity } from "../../../shared/types/ipc/mcpServer.js";
import { buildMcpClientConfig } from "../../../shared/config/mcpClientConfigs.js";
import { isGenericNativeGrantEligible } from "../../../shared/config/nativeGrantUsePolicies.js";
import type { TurnOutcomeService } from "./turnOutcomeLog.js";
import type { AbusePolicy } from "./abusePolicy.js";
import {
  DEFAULT_PORT,
  MAX_PORT_RETRIES,
  MAX_RESTART_ATTEMPTS,
  RESTART_BASE_DELAY_MS,
  RESTART_MAX_DELAY_MS,
  RESTART_JITTER_MS,
  RESTART_STABLE_RESET_MS,
  MCP_STOP_DRAIN_TIMEOUT_MS,
  MCP_TIER_ELEVATION_TTL_MS,
  MCP_GRANT_MAX_LIFETIME_MS,
  MCP_NATIVE_GRANT_DEFAULT_MAX_USES,
  MCP_NATIVE_GRANT_MIN_MAX_USES,
  MCP_NATIVE_GRANT_MAX_MAX_USES,
  MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS,
  MCP_NATIVE_GRANT_MIN_TTL_MS,
  MCP_WORKSPACE_ID_HEADER,
  MCP_WORKSPACE_ID_QUERY_PARAM,
  MCP_HANDSHAKE_REJECTED_CODE,
  minimumPermittingTier,
} from "./shared.js";

export interface HttpLifecycleDeps {
  sessionStore: SessionStore;
  auditService: AuditService;
  turnOutcomeService: TurnOutcomeService;
  abusePolicy: AbusePolicy;
  requestManifest: () => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchAction: (
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    callerInfo?: McpBearerIdentity,
    sessionOrigin?: McpSessionOrigin
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  // Pinned variants used for help-session bearers — route to the renderer
  // WebContents that minted the bearer at provision time (#7002). Optional
  // for backward-compat with test fixtures that don't wire help routing.
  requestManifestForWebContents?: (
    id: number
  ) => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchActionForWebContents?: (
    id: number,
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    contextOverride?: import("../../../shared/types/actions.js").ActionContext,
    sessionOrigin?: McpSessionOrigin
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  // Workspace-bound variants used for external sessions that named a workspace
  // at handshake (#11789). They resolve the workspace's current view per call,
  // so a session survives its view being replaced and fails closed rather than
  // following focus when it can't. Optional for the same reason as the pinned
  // variants above: test fixtures that don't wire workspace routing.
  requestManifestForWorkspace?: (
    workspaceId: string
  ) => Promise<import("../../../shared/types/actions.js").ActionManifestEntry[]>;
  dispatchActionForWorkspace?: (
    workspaceId: string,
    actionId: string,
    args: unknown,
    confirmed?: boolean,
    sessionOrigin?: McpSessionOrigin
  ) => Promise<import("./shared.js").DispatchEnvelope>;
  getCachedManifestForWorkspace?: (
    workspaceId: string
  ) => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  /**
   * Validate a handshake workspace selector, or throw when it names no live
   * view or more than one (#11789).
   */
  resolveWorkspaceBinding?: (workspaceId: string) => McpWorkspaceBinding;
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
  handleSkillsSearch: (
    rawArgs: unknown
  ) => import("../../../shared/types/skills.js").SkillSearchResult;
  handleSkillsLoad: (rawArgs: unknown) => import("../../../shared/types/skills.js").SkillLoadResult;
  handleProjectRunCheck: (
    rawArgs: unknown,
    signal: AbortSignal
  ) => Promise<import("../../../shared/types/projectCheck.js").ProjectCheckRunResult>;
  getCachedManifest: () => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  // Per-WebContents manifest cache read for pinned help sessions (#9887). Lets
  // the pinned `getCachedManifest` closure return the session's own window's
  // cached manifest instead of always re-fetching on every CallTool dispatch.
  // Optional for backward-compat with test fixtures that don't wire help
  // routing (mirrors `requestManifestForWebContents`).
  getCachedManifestForWebContents?: (
    id: number
  ) => import("../../../shared/types/actions.js").ActionManifestEntry[] | null;
  clearCachedManifest: () => void;
  cleanupListeners: Array<() => void>;
  pendingManifests: Map<
    string,
    import("./shared.js").PendingRequest<
      import("../../../shared/types/actions.js").ActionManifestEntry[]
    >
  >;
  pendingDispatches: Map<
    string,
    import("./shared.js").PendingRequest<import("./shared.js").DispatchEnvelope>
  >;
  setupIpcListeners: () => void;
  emitStatusChange: () => void;
  emitRuntimeStateChange: () => void;
  setConfig: (patch: Record<string, unknown>) => void;
}

/**
 * Best-effort client label for the bearer register. `user-agent` is always a
 * single string per Node's HTTP parser, but MCP clients aren't required to
 * send one — fall back to a neutral label so the settings row never shows a
 * blank.
 */
function resolveUserAgent(req: http.IncomingMessage): string {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" && ua.trim().length > 0 ? ua : "Unknown client";
}

/**
 * Render a dispatch outcome as a redacted, bounded result summary for the
 * audit record, so the recent-calls popover can show what each call actually
 * returned. Gate outcomes (unauthorized / dedup / collision / rate-limit)
 * return null — their `result` classification already says everything.
 */
function summarizeAuditOutcome(
  outcome: import("./auditLog.js").AuditOutcome,
  scrub: (value: string) => string
): string | null {
  if (outcome.kind === "result") {
    if (outcome.value.ok) {
      return summarizeMcpResult(outcome.value.result, scrub);
    }
    const { code, message } = outcome.value.error;
    return scrub(`${code}: ${message}`).slice(0, 500);
  }
  if (outcome.kind === "throw") {
    const text = formatErrorMessage(outcome.error, "Dispatch threw");
    return scrub(text).slice(0, 500);
  }
  return null;
}

/**
 * Live per-bearer connection record. Keyed in {@link HttpLifecycle.bearerRegister}
 * by the SHA-256 of the full `Authorization` header so distinct tokens never
 * collide on a shared 4-char suffix. `sessionIds` is the forward set used to
 * tear sessions down when the renderer disconnects the bearer; it is never
 * exposed across IPC.
 */
interface BearerEntry {
  tokenHash: string;
  token4LastChars: string;
  userAgent: string;
  lastActiveAt: number;
  requestsSinceLaunch: number;
  sessionIds: Set<string>;
  /**
   * True for renderer-pinned help-session bearers (any non-`external` tier).
   * They are tracked in the register so {@link HttpLifecycle.findHelpBearerHash}
   * can resolve a help session's live MCP sessions for eager teardown
   * (#9151), but filtered out of {@link HttpLifecycle.listActiveBearers} so the
   * External-clients settings row only ever lists genuine external clients.
   */
  isHelpSession: boolean;
  /**
   * The raw bearer token, retained only for help-session entries so the
   * eager-teardown path can resolve `record.token` → this entry's
   * `tokenHash` without reconstructing (and re-hashing) the exact
   * `Authorization` header the agent sent. Never exposed across IPC.
   */
  helpToken?: string;
}

export class HttpLifecycle {
  private httpServer: http.Server | null = null;
  private port: number | null = null;
  private apiKey: string | null = null;
  private apiKeyBearerHash: Buffer | null = null;
  private registry: WindowRegistry | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private helpTokenValidator: HelpTokenValidator | null = null;
  private helpSessionWebContentsResolver: HelpSessionWebContentsResolver | null = null;
  private helpSessionActionContextResolver: HelpSessionActionContextResolver | null = null;
  private helpSessionIdResolver: HelpSessionIdResolver | null = null;
  private assistantPaneWebContentsResolver: AssistantPaneWebContentsResolver | null = null;
  private assistantPaneActionContextResolver: AssistantPaneActionContextResolver | null = null;
  private lastError: string | null = null;
  private intentionalStop = false;
  private restartAttempts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  // Live register of bearers currently connected to the server, keyed by the
  // SHA-256 of the full Authorization header. Populated at session handshake
  // (`touchBearer`) and torn down per-session (`detachBearerSession`) plus
  // wholesale on stop/restart. Distinct from the audit ring buffer — this is
  // the current-connection view surfaced on the settings tab (#8778).
  private readonly bearerRegister = new Map<string, BearerEntry>();
  // Reverse lookup so the per-session teardown callbacks (idle expiry,
  // explicit revoke, transport close) can find which bearer owns a closing
  // session without re-parsing the header they no longer hold.
  private readonly sessionToTokenHash = new Map<string, string>();

  constructor(private readonly deps: HttpLifecycleDeps) {}

  get isRunning(): boolean {
    return this.httpServer !== null && this.httpServer.listening && this.port !== null;
  }

  /**
   * True while a `start()` is mid-flight (socket not yet bound). Lets
   * `setEnabled(false)` route through `stop()` — which awaits the start —
   * instead of no-op'ing and leaving a server that comes up after the user
   * already turned it off.
   */
  get isStartInFlight(): boolean {
    return this.startPromise !== null;
  }

  get currentPort(): number | null {
    return this.port;
  }

  get currentApiKey(): string | null {
    return this.apiKey;
  }

  setApiKey(key: string | null): void {
    this.apiKey = key;
    this.apiKeyBearerHash = precomputeApiKeyBearerHash(key);
  }

  get lastErrorState(): string | null {
    return this.lastError;
  }

  setLastError(err: string | null): void {
    this.lastError = err;
  }

  get isIntentionalStop(): boolean {
    return this.intentionalStop;
  }

  get httpServerInstance(): http.Server | null {
    return this.httpServer;
  }

  setPort(port: number | null): void {
    this.port = port;
  }

  setHelpTokenValidator(validator: HelpTokenValidator | null): void {
    this.helpTokenValidator = validator;
  }

  setHelpSessionWebContentsResolver(resolver: HelpSessionWebContentsResolver | null): void {
    this.helpSessionWebContentsResolver = resolver;
  }

  setHelpSessionActionContextResolver(resolver: HelpSessionActionContextResolver | null): void {
    this.helpSessionActionContextResolver = resolver;
  }

  setHelpSessionIdResolver(resolver: HelpSessionIdResolver | null): void {
    this.helpSessionIdResolver = resolver;
  }

  setAssistantPaneWebContentsResolver(resolver: AssistantPaneWebContentsResolver | null): void {
    this.assistantPaneWebContentsResolver = resolver;
  }

  setAssistantPaneActionContextResolver(resolver: AssistantPaneActionContextResolver | null): void {
    this.assistantPaneActionContextResolver = resolver;
  }

  /**
   * Parses a Bearer header and asks the help-session resolver — then the
   * assistant-pane resolver (#10647) — which renderer minted it, keeping *which*
   * resolver matched (#11789).
   *
   * The origin is the part that cannot be re-derived later: both resolvers
   * produce a bare WebContents id, and once it lands in `sessionWebContentsMap`
   * there is no way to tell a Daintree assistant surface from anything else that
   * happens to route to a renderer. Authorization, notification routing, and
   * external-client inventory all need that distinction, so it is recorded here
   * rather than inferred downstream.
   *
   * Returns null for bearers that own no renderer — api-key clients and generic
   * pane tokens — which are classified `external` and keep the focused-window
   * fallback in `buildSessionServerDeps` unless they bind a workspace.
   */
  private resolveSessionPin(
    authHeader: string
  ): { origin: McpSessionOrigin; webContentsId: number } | null {
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    const fromHelp = this.helpSessionWebContentsResolver?.(token) ?? null;
    if (fromHelp !== null) return { origin: "help", webContentsId: fromHelp };
    const fromPane = this.assistantPaneWebContentsResolver?.(token) ?? null;
    if (fromPane !== null) return { origin: "assistant-pane", webContentsId: fromPane };
    return null;
  }

  /**
   * Read and resolve a new session's workspace selector (#11789, #12082).
   *
   * Returns `null` when no selector was sent (the session keeps focused-window
   * routing, unchanged), a binding when the selector names a workspace this
   * session may bind to, or a rejection the caller turns into a 400 — creating
   * no session, no transport, and no `Mcp-Session-Id`.
   *
   * Only `external` sessions may bind. A help or assistant-pane bearer already
   * routes through the renderer that minted it, so a selector from one is a
   * configuration mistake with two plausible targets; refusing it keeps the two
   * binding models disjoint instead of silently letting one win.
   *
   * The refusal is deliberately narrower than it looks, because it is
   * permanent: no MCP client SDK retries a non-2xx `initialize`, so a 400 does
   * not mean "this attempt failed", it means "this client has no Daintree tools
   * until someone restarts it" (#12081). Four conditions used to share one
   * answer here; they are now separated by whether they can ever stop being
   * true.
   *
   * - **Malformed shape** — refuse. The id space is structural (a 64-hex
   *   project id or a UUIDv4 scratch id), so a value outside it names nothing
   *   that could ever exist, and accepting it would let an arbitrary string
   *   mint a session that can never route. The shape test lives here rather
   *   than in `parseWorkspaceSelector`, which stays a syntax-only parser that
   *   never interprets the id.
   * - **No resolver wired** — refuse. A build that cannot resolve bindings at
   *   all will not gain the ability mid-session.
   * - **Zero or many live views** — bind anyway, identity only. Which windows
   *   are open is user-controlled and changes minute to minute; the workspace
   *   id outlives every view, so the same call routes as soon as the user opens
   *   the workspace or closes the duplicate. `tools/list` answers from the
   *   host-owned base surface meanwhile, and each call reports the unreachable
   *   route as a retriable `SESSION_BINDING_GONE`.
   * - **Anything else thrown** — propagate. An unexpected resolver failure is a
   *   host bug of unknown duration, and this runs before any session state is
   *   allocated, so letting it reach the request handler's 500 leaves nothing
   *   behind while still refusing to guess on the client's behalf.
   */
  private resolveWorkspaceSelector(
    req: http.IncomingMessage,
    url: URL,
    tier: McpTier,
    origin: McpSessionOrigin
  ): { binding: McpWorkspaceBinding } | { rejection: WorkspaceSelectorRejection } | null {
    const parsed = parseWorkspaceSelector(
      req.headers[MCP_WORKSPACE_ID_HEADER],
      url.searchParams.getAll(MCP_WORKSPACE_ID_QUERY_PARAM)
    );
    if (parsed.kind === "absent") return null;
    if (parsed.kind === "reject") return { rejection: parsed.rejection };

    if (origin !== "external" || tier !== "external") {
      return {
        rejection: {
          code: "WORKSPACE_SELECTOR_NOT_ALLOWED",
          message:
            "This bearer is already bound to the Daintree window that issued it, so it cannot request a workspace. Drop the workspace selector, or connect with an API key.",
        },
      };
    }

    if (!isProjectWorkspaceId(parsed.workspaceId) && !isScratchWorkspaceId(parsed.workspaceId)) {
      return {
        rejection: {
          code: "WORKSPACE_SELECTOR_INVALID",
          message: `'${parsed.workspaceId}' is not shaped like a Daintree workspace id, so no workspace can ever match it. Copy the id from Settings → MCP → Copy config for this project.`,
        },
      };
    }

    const resolve = this.deps.resolveWorkspaceBinding;
    if (!resolve) {
      return {
        rejection: {
          code: "WORKSPACE_SELECTOR_NOT_ALLOWED",
          message:
            "This Daintree build cannot resolve workspace bindings. Drop the workspace selector to connect an unscoped client.",
        },
      };
    }
    try {
      return { binding: resolve(parsed.workspaceId) };
    } catch (err) {
      // Bind on the recoverable ones, and carry only the identity: `kind` and
      // `workspacePath` are read off the live view, so there is nothing
      // truthful to put there. Their absence is the whole signal a client
      // needs — a liveness flag would be a snapshot of handshake time echoed in
      // a capability that never updates, wrong within seconds of being read.
      if (err instanceof WorkspaceBindingError) {
        return { binding: { workspaceId: parsed.workspaceId } };
      }
      throw err;
    }
  }

  /**
   * Refuse a handshake before any session state exists. HTTP 400 with a
   * JSON-RPC error in the implementation-defined range, carrying a stable
   * `data.code` clients can branch on, and deliberately no `Mcp-Session-Id` —
   * there is no session to resume.
   */
  private rejectHandshake(res: http.ServerResponse, rejection: WorkspaceSelectorRejection): void {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: MCP_HANDSHAKE_REJECTED_CODE,
          message: rejection.message,
          data: { code: rejection.code },
        },
        id: null,
      })
    );
  }

  /**
   * Parses a Bearer header and asks the help-session resolver — then the
   * assistant-pane resolver (#10647) — for the `ActionContext` snapshot bound
   * to it at launch time (#8317). Returns null for non-pinned bearers so
   * external/api-key/generic-pane sessions keep their live focused-window
   * context in `buildSessionServerDeps`.
   */
  private resolveActionContext(
    authHeader: string
  ): import("../../../shared/types/actions.js").ActionContext | null {
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    const fromHelp = this.helpSessionActionContextResolver?.(token) ?? null;
    if (fromHelp !== null) return fromHelp;
    return this.assistantPaneActionContextResolver?.(token) ?? null;
  }

  /**
   * Parses a Bearer header and asks the help-session resolver for the public
   * help-session id minted at provision. Returns null for non-help bearers
   * so external/api-key sessions never enter `sessionHelpIdMap`.
   */
  private resolveHelpSessionId(authHeader: string): string | null {
    if (!this.helpSessionIdResolver) return null;
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    return this.helpSessionIdResolver(token);
  }

  /** Normalize a possibly-array request header to a trimmed string or null. */
  private headerString(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw?.trim();
    return trimmed ? trimmed : null;
  }

  /**
   * Record (or refresh) the bearer behind an authenticated session handshake.
   * Called once per new session — not per request — because only handshake
   * requests carry the `Authorization` header through this path. Only
   * `external`-tier bearers are tracked: the "External clients" row is for
   * third-party MCP clients (Claude Code, Cursor, scripts), never the
   * Daintree Assistant's own help-session or in-pane agent tokens — surfacing
   * those would let the user disconnect their own assistant.
   *
   * The hash of the full header is the stable per-token identity; `userAgent`
   * and `lastActiveAt` refresh on every (re)connect. `requestsSinceLaunch`
   * counts handshakes for the bearer since the server last started. Pushes a
   * runtime-state change so an open settings tab reflects the new connection
   * live (session handshakes are infrequent, so this is not chatty).
   */
  private touchBearer(
    authHeader: string,
    userAgent: string,
    sessionId: string,
    tier: McpTier
  ): void {
    // Help-session bearers (any non-`external` tier) used to be skipped
    // outright. They are now tracked so `revokeSession` can tear down their
    // live MCP sessions eagerly (#9151); the `isHelpSession` flag keeps them
    // out of the External-clients settings row.
    const isHelpSession = tier !== "external";
    const rawToken = extractBearerToken(authHeader);
    const tokenHash = createHash("sha256").update(authHeader).digest("hex");
    const token4LastChars = rawToken?.slice(-4) ?? "****";
    const now = Date.now();
    let entry = this.bearerRegister.get(tokenHash);
    if (!entry) {
      entry = {
        tokenHash,
        token4LastChars,
        userAgent,
        lastActiveAt: now,
        requestsSinceLaunch: 0,
        sessionIds: new Set<string>(),
        isHelpSession,
      };
      if (isHelpSession && rawToken) entry.helpToken = rawToken;
      this.bearerRegister.set(tokenHash, entry);
    }
    entry.userAgent = userAgent;
    entry.lastActiveAt = now;
    entry.requestsSinceLaunch += 1;
    entry.sessionIds.add(sessionId);
    this.sessionToTokenHash.set(sessionId, tokenHash);
    // Both external bearers (External clients row) and help-session bearers
    // (the "Daintree Assistant connections" row, #10036) surface on the
    // settings tab, so every handshake needs a runtime-state push to keep the
    // open tab live.
    this.deps.emitRuntimeStateChange();
  }

  /**
   * Bump a tracked bearer's `lastActiveAt` on a subsequent (non-handshake)
   * authenticated request so the settings row reflects real recency, not just
   * connection time. No-op for untracked (internal-tier) sessions. Does not
   * push a runtime-state change — per-message traffic would be far too chatty;
   * the refreshed value is picked up on the next list fetch.
   */
  private markBearerActive(sessionId: string): void {
    const tokenHash = this.sessionToTokenHash.get(sessionId);
    if (tokenHash === undefined) return;
    const entry = this.bearerRegister.get(tokenHash);
    if (entry) entry.lastActiveAt = Date.now();
  }

  /**
   * Resolve the display-only bearer identity behind a session so the confirm
   * dialog can show which external client is asking (#9157). Returns null for
   * help-session bearers (`isHelpSession`) — the assistant's own pinned panel
   * is its own context, so its dispatches stay provenance-free — and for any
   * session not currently tracked (internal-tier / already detached). The
   * lookup is O(1) over the two register Maps and runs at dispatch time, when
   * the entry is guaranteed live (teardown only fires on transport close).
   */
  private getBearerInfoForSession(sessionId: string): McpBearerIdentity | null {
    const tokenHash = this.sessionToTokenHash.get(sessionId);
    if (tokenHash === undefined) return null;
    const entry = this.bearerRegister.get(tokenHash);
    if (!entry || entry.isHelpSession) return null;
    return { token4LastChars: entry.token4LastChars, userAgent: entry.userAgent };
  }

  /**
   * Drop a closing session from its owning bearer entry. Idempotent — a
   * no-op when the session was never registered (non-handshake / internal
   * tier) or the entry was already cleared by an explicit disconnect. Removes
   * the bearer entry once its last session closes so the settings tab reflects
   * only live connections, and pushes a runtime-state change so an open tab
   * updates. Wired into every per-session teardown path via the
   * `dropBearerState` callback plus the inline transport-close handlers.
   */
  detachBearerSession(sessionId: string): void {
    const tokenHash = this.sessionToTokenHash.get(sessionId);
    if (tokenHash === undefined) return;
    this.sessionToTokenHash.delete(sessionId);
    const entry = this.bearerRegister.get(tokenHash);
    if (!entry) return;
    entry.sessionIds.delete(sessionId);
    if (entry.sessionIds.size === 0) {
      this.bearerRegister.delete(tokenHash);
    }
    // Both external and help-session bearers surface on the settings tab
    // (#10036), so every teardown needs a runtime-state push so an open tab
    // drops the row.
    this.deps.emitRuntimeStateChange();
  }

  /**
   * Push a turn-outcome alert (`agent-stuck` / `reasoning-loop`) to the
   * renderer pinned to the originating help session (#10018). The
   * `TurnOutcomeService` only knows the help-session id, so resolve it to a
   * live transport session via `sessionHelpIdMap` (transport → help), then to
   * the pinned WebContents. At most one transport session maps to a given help
   * session at a time, so the first match with a live pin wins. Targeted send
   * with the same `fromId` + `isDestroyed` guard as every other push — a
   * WebContents LRU-evicted between handshake and alert rejects harmlessly.
   */
  notifyTurnOutcomeAlert(payload: McpTurnOutcomeAlertPayload): void {
    for (const [transportSessionId, helpId] of this.deps.sessionStore.sessionHelpIdMap.entries()) {
      if (helpId !== payload.helpSessionId) continue;
      const pinnedId = this.deps.sessionStore.sessionWebContentsMap.get(transportSessionId);
      if (pinnedId === undefined) continue;
      const wc = webContentsModule.fromId(pinnedId);
      // A transport session whose WebContents was LRU-evicted/destroyed is
      // skipped, not treated as the answer — a reconnect or concurrent
      // transport for the same help session may still hold a live pin.
      if (!wc || wc.isDestroyed()) continue;
      try {
        wc.send(CHANNELS.MCP_TURN_OUTCOME_ALERT, {
          helpSessionId: payload.helpSessionId,
          outcome: payload.outcome,
          ...(payload.turnId !== undefined ? { turnId: payload.turnId } : {}),
        });
      } catch (err) {
        console.error("[MCP] turn-outcome-alert send failed:", err);
      }
      return;
    }
  }

  /**
   * Live snapshot for the settings tab. The raw token is never exposed.
   * Renderer-pinned help-session bearers are filtered out — they are
   * Daintree's own internal consumers, recursive to name in a dialog the
   * user opens to disconnect external clients (#9151).
   */
  listActiveBearers(): ActiveBearerRecord[] {
    const records: ActiveBearerRecord[] = [];
    for (const entry of this.bearerRegister.values()) {
      if (entry.isHelpSession) continue;
      records.push({
        tokenHash: entry.tokenHash,
        token4LastChars: entry.token4LastChars,
        userAgent: entry.userAgent,
        lastActiveAt: entry.lastActiveAt,
        requestsSinceLaunch: entry.requestsSinceLaunch,
      });
    }
    return records;
  }

  /**
   * Read-only inventory of the renderer-pinned help-session bearers (the
   * Daintree Assistant's own internal MCP connections) for the separate
   * "Daintree Assistant connections" settings row (#10036). The inverse filter
   * of {@link listActiveBearers}: only `isHelpSession` entries. Exposes display
   * fields only — never the `helpToken`, `tokenHash`, or `token4LastChars`
   * (those identify an internal credential and stay main-side, #9318); there is
   * no disconnect action for help sessions so no hash is needed to target one.
   */
  listHelpSessionBearers(): HelpSessionBearerRecord[] {
    const records: HelpSessionBearerRecord[] = [];
    for (const entry of this.bearerRegister.values()) {
      if (!entry.isHelpSession) continue;
      records.push({
        userAgent: entry.userAgent,
        lastActiveAt: entry.lastActiveAt,
        requestsSinceLaunch: entry.requestsSinceLaunch,
        sessionCount: entry.sessionIds.size,
      });
    }
    return records;
  }

  /**
   * Resolve a help-session bearer's raw token to its register key so the
   * eager-teardown path (#9151) can hand it to {@link disconnectBearer}
   * without re-hashing the original `Authorization` header (whose exact
   * whitespace it no longer holds). Returns null when the token isn't
   * currently tracked — the agent may never have connected, or already
   * disconnected. O(n) over the small bearer register; only called on revoke.
   */
  findHelpBearerHash(rawToken: string): string | null {
    for (const entry of this.bearerRegister.values()) {
      if (entry.isHelpSession && entry.helpToken === rawToken) return entry.tokenHash;
    }
    return null;
  }

  /**
   * Snapshot the session ids owned by a bearer so the caller can revoke each
   * one. Returns null when the token hash isn't currently connected.
   */
  getBearerSessionIds(tokenHash: string): string[] | null {
    const entry = this.bearerRegister.get(tokenHash);
    if (!entry) return null;
    return Array.from(entry.sessionIds);
  }

  /** Evict a bearer entry and its reverse-lookup rows. Idempotent. */
  clearBearer(tokenHash: string): void {
    const entry = this.bearerRegister.get(tokenHash);
    if (!entry) return;
    for (const sessionId of entry.sessionIds) {
      this.sessionToTokenHash.delete(sessionId);
    }
    this.bearerRegister.delete(tokenHash);
  }

  private clearAllBearers(): void {
    this.bearerRegister.clear();
    this.sessionToTokenHash.clear();
  }

  private getConfig() {
    return store.get("mcpServer");
  }

  private persistConfig(patch: Record<string, unknown>): void {
    this.deps.setConfig(patch);
  }

  isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  async start(registry: WindowRegistry): Promise<void> {
    this.registry = registry;

    if (this.stopPromise) {
      await this.stopPromise;
    }

    if (this.isRunning) {
      return;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    if (!this.isEnabled()) {
      console.log("[MCP] Server disabled — skipping start");
      return;
    }

    const hadPriorFailure = this.lastError !== null;
    this.lastError = null;
    if (hadPriorFailure) this.deps.emitRuntimeStateChange();

    this.startPromise = (async () => {
      try {
        if (!this.apiKey) {
          const persisted = this.getConfig().apiKey;
          if (persisted && persisted.length > 0) {
            this.setApiKey(persisted);
          } else {
            this.setApiKey(`daintree_${randomUUID().replace(/-/g, "")}`);
            this.persistConfig({ apiKey: this.apiKey });
          }
        }

        this.deps.auditService.hydrate();

        const server = http.createServer((req, res) => {
          this.handleRequest(req, res).catch((err) => {
            console.error("[MCP] Request handler error:", err);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Internal server error");
            }
          });
        });

        server.keepAliveTimeout = 30_000;
        server.headersTimeout = 60_000;

        const configuredPort = this.getConfig().port ?? DEFAULT_PORT;
        const boundPort = await this.listenWithRetry(server, configuredPort);

        if (boundPort === null) {
          throw new Error(
            `Failed to bind MCP server: ports ${configuredPort}–${configuredPort + MAX_PORT_RETRIES} all in use`
          );
        }

        this.port = boundPort;
        this.httpServer = server;
        this.deps.setupIpcListeners();
        this.attachServerSupervision(server);
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          this.restartAttempts = 0;
        }, RESTART_STABLE_RESET_MS);
        this.stableTimer.unref?.();
        console.log(
          `[MCP] Server started on http://127.0.0.1:${this.port}/mcp (Streamable HTTP) and /sse (legacy SSE)`
        );
        this.deps.emitStatusChange();
      } catch (err) {
        this.lastError = formatErrorMessage(err, "MCP server failed to start");
        this.deps.emitRuntimeStateChange();
        throw err;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  private attachServerSupervision(server: http.Server): void {
    server.on("error", (err) => {
      console.error("[MCP] HTTP server error after bind:", err);
    });
    server.on("close", () => {
      if (server !== this.httpServer || this.intentionalStop) return;
      console.warn("[MCP] HTTP server closed unexpectedly — scheduling restart");
      this.handleUnexpectedClose();
    });
  }

  private handleUnexpectedClose(): void {
    this.deps.auditService.flushNow();
    this.deps.turnOutcomeService.flushNow();

    // Drain sessions
    this.deps.sessionStore.drain();
    // Wipe the bearer register so a restart starts from zero live clients —
    // every external client must reconnect, re-registering on handshake.
    this.clearAllBearers();
    // Mirror the planned-stop path so an unexpected close also wipes
    // the abuse-policy state. Otherwise denial counters would leak
    // into the lifetime of any subsequent restart.
    this.deps.abusePolicy.clear();

    for (const cleanup of this.deps.cleanupListeners) {
      try {
        cleanup();
      } catch {
        // best-effort
      }
    }
    this.deps.cleanupListeners.length = 0;

    for (const [id, pending] of this.deps.pendingManifests) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server closed unexpectedly"));
      this.deps.pendingManifests.delete(id);
    }
    for (const [id, pending] of this.deps.pendingDispatches) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error("MCP server closed unexpectedly"));
      this.deps.pendingDispatches.delete(id);
    }
    this.deps.clearCachedManifest();

    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }

    this.httpServer = null;
    this.port = null;
    this.lastError = null;
    this.deps.emitStatusChange();

    if (!this.isEnabled() || !this.registry) return;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.lastError = `MCP server restart limit reached after ${MAX_RESTART_ATTEMPTS} attempts`;
      this.deps.emitRuntimeStateChange();
      return;
    }
    this.restartAttempts++;
    const baseDelay = RESTART_BASE_DELAY_MS * Math.pow(2, this.restartAttempts - 1);
    const jitter = Math.random() * RESTART_JITTER_MS;
    const delay = Math.min(baseDelay + jitter, RESTART_MAX_DELAY_MS);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.isEnabled() || !this.registry) return;
      void this.start(this.registry).catch((err) => {
        console.error("[MCP] Auto-restart attempt failed:", err);
        if (!this.isRunning && this.isEnabled() && this.registry) {
          this.scheduleRestart();
        }
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.restartAttempts = 0;
    this.intentionalStop = true;

    this.stopPromise = (async () => {
      try {
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // start failed; no server to close
          }
        }

        this.deps.auditService.flushNow();
        this.deps.turnOutcomeService.flushNow();
        this.deps.sessionStore.drain();
        this.clearAllBearers();
        // The drain wipes session-scoped state (grants, dedup, pins);
        // the abuse-policy denial Map is owned alongside but lives on
        // `HttpLifecycle.deps` so we clear it here in lockstep. Without
        // this, the policy retains denial counters across a stop/start
        // cycle for sessionIds that will never reappear.
        this.deps.abusePolicy.clear();

        for (const cleanup of this.deps.cleanupListeners) {
          try {
            cleanup();
          } catch {
            // best-effort
          }
        }
        this.deps.cleanupListeners.length = 0;

        for (const [id, pending] of this.deps.pendingManifests) {
          clearTimeout(pending.timer);
          pending.destroyedCleanup?.();
          pending.reject(new Error("MCP server stopped"));
          this.deps.pendingManifests.delete(id);
        }
        for (const [id, pending] of this.deps.pendingDispatches) {
          clearTimeout(pending.timer);
          pending.destroyedCleanup?.();
          pending.reject(new Error("MCP server stopped"));
          this.deps.pendingDispatches.delete(id);
        }
        this.deps.clearCachedManifest();

        let wasRunning = false;
        if (this.httpServer) {
          const server = this.httpServer;
          wasRunning = server.listening;
          // Graceful drain (#8779): stop accepting new connections, then let
          // in-flight requests finish naturally. `closeIdleConnections()`
          // drops bare keep-alive sockets immediately so they don't hold
          // `close()` open; active requests keep their socket until the
          // response ends. The eager `closeAllConnections()` that used to
          // run *here* force-destroyed in-flight tool calls before they
          // could complete — it now fires only as the deadline fallback
          // below so a hung external client can't block the toggle forever.
          let drained = false;
          await Promise.race([
            new Promise<void>((resolve) => {
              server.close(() => {
                drained = true;
                resolve();
              });
              server.closeIdleConnections();
            }),
            new Promise<void>((resolve) => {
              setTimeout(() => {
                if (!drained) {
                  console.warn(
                    "[MCP] server.close() timed out after 3s — force-closing connections"
                  );
                }
                resolve();
              }, MCP_STOP_DRAIN_TIMEOUT_MS).unref?.();
            }),
          ]);
          if (!drained) {
            // Deadline hit with sockets still active — sever them so the
            // listening port is released before the next start.
            server.closeAllConnections();
          }
          this.httpServer = null;
          this.port = null;
        }

        this.lastError = null;

        console.log("[MCP] Server stopped");
        if (wasRunning) {
          this.deps.emitStatusChange();
        } else {
          this.deps.emitRuntimeStateChange();
        }
      } finally {
        this.intentionalStop = false;
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  private async listenWithRetry(server: http.Server, startPort: number): Promise<number | null> {
    for (let attempt = 0; attempt <= MAX_PORT_RETRIES; attempt++) {
      const port = startPort + attempt;
      if (port > 65535) break;

      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error) => {
            server.removeListener("error", onError);
            reject(err);
          };
          server.on("error", onError);
          server.listen(port, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve();
          });
        });
        return (server.address() as AddressInfo)?.port ?? null;
      } catch {
        console.log(`[MCP] Port ${port} bind failed, trying next…`);
        continue;
      }
    }
    return null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Node drops some repeated headers and joins others. Trust decisions must
    // reject ambiguity before those normalised values select a bearer or session.
    const securityHeaders = new Set([
      "authorization",
      "host",
      "origin",
      "mcp-session-id",
      MCP_WORKSPACE_ID_HEADER,
    ]);
    const seen = new Set<string>();
    const rawHeaders = req.rawHeaders ?? [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      const name = rawHeaders[index].toLowerCase();
      if (!securityHeaders.has(name)) continue;
      if (seen.has(name)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Ambiguous request headers");
        return;
      }
      seen.add(name);
    }

    const host = req.headers.host ?? "";
    if (!(host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const origin = req.headers.origin;
    if (
      origin !== undefined &&
      origin !== `http://127.0.0.1:${this.port}` &&
      origin !== `http://localhost:${this.port}`
    ) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);

    const authHeader = req.headers.authorization ?? "";
    if (!isAuthorized(authHeader, this.apiKeyBearerHash, this.helpTokenValidator)) {
      // A session id is a routing handle, not proof of ownership. Attributing
      // this rejection to the claimed id lets an unauthenticated caller revoke
      // somebody else's session by repeatedly naming it. Keep global telemetry;
      // session abuse accounting belongs after bearer and ownership validation.
      this.deps.auditService.recordAuth401();
      res.writeHead(401, {
        "Content-Type": "text/plain",
        "WWW-Authenticate": 'Bearer realm="Daintree MCP"',
      });
      res.end("Unauthorized");
      return;
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      // Workspace binding is a `/mcp` feature (#11789). SSE was deprecated by
      // the MCP spec in revision 2025-03-26 and no external client is pointed
      // at it, so it isn't worth a second handshake path — but silently
      // ignoring a routing selector is worse than not supporting it, since the
      // caller would believe its calls were scoped when they still followed
      // focus. Refuse loudly instead, before the transport allocates a session.
      const sseSelector = parseWorkspaceSelector(
        req.headers[MCP_WORKSPACE_ID_HEADER],
        url.searchParams.getAll(MCP_WORKSPACE_ID_QUERY_PARAM)
      );
      if (sseSelector.kind !== "absent") {
        this.rejectHandshake(res, {
          code: "WORKSPACE_SELECTOR_NOT_ALLOWED",
          message:
            "Workspace binding is only supported on the /mcp (Streamable HTTP) endpoint. Point this client at /mcp.",
        });
        return;
      }

      const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
      const allowedOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
      const transport = new SSEServerTransport("/messages", res, {
        enableDnsRebindingProtection: true,
        allowedHosts,
        allowedOrigins,
      });
      const sessionId = transport.sessionId;
      const tier = resolveTokenTier(authHeader, this.apiKeyBearerHash, this.helpTokenValidator);
      this.deps.sessionStore.sessionTierMap.set(sessionId, tier);
      this.deps.sessionStore.registerClientMetadata(
        sessionId,
        this.headerString(req.headers["user-agent"]),
        "sse"
      );
      this.touchBearer(authHeader, resolveUserAgent(req), sessionId, tier);

      const pin = this.resolveSessionPin(authHeader);
      this.deps.sessionStore.sessionOriginMap.set(sessionId, pin?.origin ?? "external");
      const pinnedWebContentsId = pin?.webContentsId ?? null;
      if (pinnedWebContentsId !== null) {
        this.deps.sessionStore.sessionWebContentsMap.set(sessionId, pinnedWebContentsId);
      }

      const boundActionContext = this.resolveActionContext(authHeader);
      if (boundActionContext !== null) {
        this.deps.sessionStore.sessionContextMap.set(sessionId, boundActionContext);
      }

      const helpSessionId = this.resolveHelpSessionId(authHeader);
      if (helpSessionId !== null) {
        this.deps.sessionStore.sessionHelpIdMap.set(sessionId, helpSessionId);
      }

      const deps = this.buildSessionServerDeps(sessionId);
      const server = createSessionServer(sessionId, deps);

      const idleTimer = this.deps.sessionStore.createIdleTimer(sessionId);
      this.deps.sessionStore.sessions.set(sessionId, { transport, server, idleTimer });
      transport.onclose = () => {
        const session = this.deps.sessionStore.sessions.get(sessionId);
        if (session) {
          clearTimeout(session.idleTimer);
          this.deps.sessionStore.sessions.delete(sessionId);
        }
        this.deps.sessionStore.clearElevationTimer(sessionId);
        this.deps.sessionStore.sessionTierMap.delete(sessionId);
        // Revoke before deleting the WebContents pin so the lifecycle
        // emitter can still find the pinned renderer for the
        // `grant.revoked` push. The audit record carries the
        // `session-ended` reason. Without this, grants accumulate
        // forever in the cache across a long-running session lifecycle.
        this.deps.sessionStore.grantCache.revokeSession(sessionId, "session-ended");
        this.deps.sessionStore.clearSessionBinding(sessionId);
        // Resolve the public help-session id before deleting the map entry.
        this.deps.sessionStore.clearFigureCounter(sessionId);
        this.deps.sessionStore.sessionHelpIdMap.delete(sessionId);
        this.deps.sessionStore.clearDedupState(sessionId);
        this.deps.sessionStore.clearClientMetadata(sessionId);
        this.deps.abusePolicy.dropSession(sessionId);
        this.detachBearerSession(sessionId);
        cleanupResourceSubscriptions(sessionId, this.deps.sessionStore);
      };

      try {
        await server.connect(transport);
      } catch (err) {
        clearTimeout(idleTimer);
        this.deps.sessionStore.sessions.delete(sessionId);
        this.deps.sessionStore.clearElevationTimer(sessionId);
        this.deps.sessionStore.sessionTierMap.delete(sessionId);
        // Same pin-before-clear ordering — the connect failure path
        // mirrors normal close cleanup.
        this.deps.sessionStore.grantCache.revokeSession(sessionId, "session-ended");
        this.deps.sessionStore.clearSessionBinding(sessionId);
        // Resolve the public help-session id before deleting the map entry.
        this.deps.sessionStore.clearFigureCounter(sessionId);
        this.deps.sessionStore.sessionHelpIdMap.delete(sessionId);
        this.deps.sessionStore.clearDedupState(sessionId);
        this.deps.sessionStore.clearClientMetadata(sessionId);
        this.deps.abusePolicy.dropSession(sessionId);
        this.detachBearerSession(sessionId);
        transport.onclose = undefined;
        await transport.close().catch(() => {});
        throw err;
      }
    } else if (req.method === "POST" && url.pathname === "/messages") {
      const sid = url.searchParams.get("sessionId") ?? "";

      // SSE sessions can never be workspace-bound — the GET /sse handshake
      // refuses a selector outright. A selector arriving on the message leg is
      // therefore always a client that believes it is scoped and is not, which
      // is worse than an unsupported feature (#11789). This leg is the exact
      // place clients are already known to attach headers inconsistently.
      if (
        parseWorkspaceSelector(
          req.headers[MCP_WORKSPACE_ID_HEADER],
          url.searchParams.getAll(MCP_WORKSPACE_ID_QUERY_PARAM)
        ).kind !== "absent"
      ) {
        this.rejectHandshake(res, {
          code: "WORKSPACE_SELECTOR_NOT_ALLOWED",
          message:
            "Workspace binding is only supported on the /mcp (Streamable HTTP) endpoint. Point this client at /mcp.",
        });
        return;
      }

      const session = this.deps.sessionStore.sessions.get(sid);
      if (session) {
        this.deps.sessionStore.resetIdleTimer(sid);
        this.markBearerActive(sid);
        await session.transport.handlePostMessage(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Session not found");
      }
    } else if (url.pathname === "/mcp") {
      if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
        res.writeHead(405, {
          Allow: "GET, POST, DELETE",
          "Content-Type": "text/plain",
        });
        res.end("Method not allowed");
        return;
      }
      await this.handleStreamableHttpRequest(req, res, url);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }

  private async handleStreamableHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL
  ): Promise<void> {
    const headerValue = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

    if (sessionId !== undefined && sessionId !== "") {
      const session = this.deps.sessionStore.httpSessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Session not found" },
            id: null,
          })
        );
        return;
      }
      // A selector on an established session never rebinds it — the binding is
      // fixed at handshake — but it must not be ignored either (#11789). All
      // three generated configs put the header in a per-request `headers` map,
      // so a client that scoped itself repeats it on every call; one that
      // attaches headers inconsistently across legs (a real failure mode on
      // this server — see the `/sse` note in `mcpClientConfigs.ts`) could send
      // it on calls but not on `initialize`, ending up convinced its calls are
      // scoped while every one of them follows focus. That is precisely the
      // silent misrouting this feature exists to remove, so a selector that
      // disagrees with what the session actually resolved to is refused.
      // DELETE is exempt: it terminates the session and routes no action
      // anywhere, so refusing it over a selector would only strand a client
      // that can no longer clean up after itself.
      const boundWorkspaceId = this.deps.sessionStore.sessionWorkspaceMap.get(sessionId) ?? null;
      const liveSelector =
        req.method === "DELETE"
          ? ({ kind: "absent" } as const)
          : parseWorkspaceSelector(
              req.headers[MCP_WORKSPACE_ID_HEADER],
              url.searchParams.getAll(MCP_WORKSPACE_ID_QUERY_PARAM)
            );
      if (liveSelector.kind === "reject") {
        this.rejectHandshake(res, liveSelector.rejection);
        return;
      }
      if (liveSelector.kind === "selector" && liveSelector.workspaceId !== boundWorkspaceId) {
        this.rejectHandshake(res, {
          code: "WORKSPACE_SELECTOR_MISMATCH",
          message:
            boundWorkspaceId === null
              ? "This session is not bound to a workspace — its workspace selector was not present when it was created. Start a new session with the selector on the initialize request."
              : `This session is bound to workspace ${boundWorkspaceId} and cannot be rebound. Start a new session to target a different workspace.`,
        });
        return;
      }

      this.deps.sessionStore.resetHttpIdleTimer(sessionId);
      this.markBearerActive(sessionId);
      await session.transport.handleRequest(req, res);
      return;
    }

    const authHeader = req.headers.authorization ?? "";
    const tier = resolveTokenTier(authHeader, this.apiKeyBearerHash, this.helpTokenValidator);
    const pin = this.resolveSessionPin(authHeader);
    const origin: McpSessionOrigin = pin?.origin ?? "external";

    // Resolve the workspace selector before anything is allocated (#11789). A
    // refused handshake must leave nothing behind — no session id, no tier
    // entry, no client metadata, no transport — so this runs ahead of every
    // write below, and returns without creating a session.
    const selector = this.resolveWorkspaceSelector(req, url, tier, origin);
    if (selector !== null && "rejection" in selector) {
      this.rejectHandshake(res, selector.rejection);
      return;
    }
    const workspaceBinding = selector?.binding ?? null;

    const newSessionId = randomUUID();
    this.deps.sessionStore.sessionTierMap.set(newSessionId, tier);
    this.deps.sessionStore.sessionOriginMap.set(newSessionId, origin);
    this.deps.sessionStore.registerClientMetadata(
      newSessionId,
      this.headerString(req.headers["user-agent"]),
      "streamable-http"
    );

    if (pin !== null) {
      this.deps.sessionStore.sessionWebContentsMap.set(newSessionId, pin.webContentsId);
    }

    if (workspaceBinding !== null) {
      this.deps.sessionStore.sessionWorkspaceMap.set(newSessionId, workspaceBinding.workspaceId);
    }

    const boundActionContext = this.resolveActionContext(authHeader);
    if (boundActionContext !== null) {
      this.deps.sessionStore.sessionContextMap.set(newSessionId, boundActionContext);
    }

    const helpSessionId = this.resolveHelpSessionId(authHeader);
    if (helpSessionId !== null) {
      this.deps.sessionStore.sessionHelpIdMap.set(newSessionId, helpSessionId);
    }

    const deps = this.buildSessionServerDeps(newSessionId, workspaceBinding ?? undefined);
    const server = createSessionServer(newSessionId, deps);
    const allowedHosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    const allowedOrigins = [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
    // enableDnsRebindingProtection / allowedHosts / allowedOrigins are
    // deprecated in SDK ^1.27.1; the manual gate in handleRequest is authoritative.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      enableDnsRebindingProtection: true,
      allowedHosts,
      allowedOrigins,
      onsessioninitialized: (initializedSessionId) => {
        const idleTimer = this.deps.sessionStore.createHttpIdleTimer(initializedSessionId);
        this.deps.sessionStore.httpSessions.set(initializedSessionId, {
          transport,
          server,
          idleTimer,
        });
        // Register the bearer against the SDK-confirmed session id (not the
        // pre-generated `newSessionId`) so detachment keys match the ids the
        // teardown paths see.
        this.touchBearer(authHeader, resolveUserAgent(req), initializedSessionId, tier);
      },
    });

    transport.onclose = () => {
      // Fall back to `newSessionId` when the transport closes before
      // `onsessioninitialized` fires — otherwise the entries inserted under
      // `newSessionId` (tier + pin) leak. Mirrors the catch-block path.
      const id = transport.sessionId ?? newSessionId;
      const session = this.deps.sessionStore.httpSessions.get(id);
      if (session) {
        clearTimeout(session.idleTimer);
        this.deps.sessionStore.httpSessions.delete(id);
      }
      this.deps.sessionStore.clearElevationTimer(id);
      this.deps.sessionStore.sessionTierMap.delete(id);
      // Pin-before-revoke ordering identical to the SSE path above —
      // see `transport.onclose` in the GET /sse branch.
      this.deps.sessionStore.grantCache.revokeSession(id, "session-ended");
      this.deps.sessionStore.clearSessionBinding(id);
      // Resolve the public help-session id before deleting the map entry.
      this.deps.sessionStore.clearFigureCounter(id);
      this.deps.sessionStore.sessionHelpIdMap.delete(id);
      this.deps.sessionStore.clearDedupState(id);
      this.deps.sessionStore.clearClientMetadata(id);
      this.deps.abusePolicy.dropSession(id);
      this.detachBearerSession(id);
      cleanupResourceSubscriptions(id, this.deps.sessionStore);
    };

    /**
     * Reclaim everything written for a session the SDK never initialized.
     *
     * The SDK answers a malformed pre-initialize request — wrong `Accept`, an
     * unparseable body, a JSON-RPC method that is not `initialize` — by writing
     * a 4xx rather than throwing, so `onsessioninitialized` never fires and
     * nothing is inserted into `httpSessions`. Without this, the tier, origin,
     * client metadata and (since #12082) workspace rows above outlive the
     * request forever: the idle reaper walks `httpSessions`, which has no entry
     * to find.
     */
    const discardUninitializedSession = (): void => {
      this.deps.sessionStore.clearElevationTimer(newSessionId);
      this.deps.sessionStore.sessionTierMap.delete(newSessionId);
      this.deps.sessionStore.grantCache.revokeSession(newSessionId, "session-ended");
      this.deps.sessionStore.clearSessionBinding(newSessionId);
      // Resolve the public help-session id before deleting the map entry.
      this.deps.sessionStore.clearFigureCounter(newSessionId);
      this.deps.sessionStore.sessionHelpIdMap.delete(newSessionId);
      this.deps.sessionStore.clearDedupState(newSessionId);
      this.deps.sessionStore.clearClientMetadata(newSessionId);
      this.deps.abusePolicy.dropSession(newSessionId);
      this.detachBearerSession(newSessionId);
      cleanupResourceSubscriptions(newSessionId, this.deps.sessionStore);
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
      // Both conditions, because they answer the question from opposite ends:
      // the SDK sets `sessionId` when it accepts the handshake, and our own
      // `onsessioninitialized` is what files the session for the reaper. A
      // session is real only when both happened.
      if (
        transport.sessionId === undefined &&
        !this.deps.sessionStore.httpSessions.has(newSessionId)
      ) {
        discardUninitializedSession();
      }
    } catch (err) {
      console.error("[MCP] Streamable HTTP request failed:", err);
      const id = transport.sessionId;
      if (id !== undefined) {
        const session = this.deps.sessionStore.httpSessions.get(id);
        if (session) {
          clearTimeout(session.idleTimer);
          this.deps.sessionStore.httpSessions.delete(id);
        }
        this.deps.sessionStore.clearElevationTimer(id);
        this.deps.sessionStore.sessionTierMap.delete(id);
        this.deps.sessionStore.grantCache.revokeSession(id, "session-ended");
        this.deps.sessionStore.clearSessionBinding(id);
        // Resolve the public help-session id before deleting the map entry.
        this.deps.sessionStore.clearFigureCounter(id);
        this.deps.sessionStore.sessionHelpIdMap.delete(id);
        this.deps.sessionStore.clearDedupState(id);
        this.deps.sessionStore.clearClientMetadata(id);
        this.deps.abusePolicy.dropSession(id);
        this.detachBearerSession(id);
        cleanupResourceSubscriptions(id, this.deps.sessionStore);
      } else {
        discardUninitializedSession();
      }
      await transport.close().catch(() => {});
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  }

  /**
   * Builds per-session dispatch deps, routing on how the session was bound at
   * handshake. Three routes, in precedence order:
   *
   * 1. **Workspace-bound** (#11789) — an external session that named a
   *    workspace. Every operation re-resolves that workspace's current view, so
   *    the session survives its view being replaced and fails closed rather
   *    than following focus when the workspace has no single live view.
   * 2. **WebContents-pinned** (#7002) — help-session and assistant-pane
   *    bearers, routed to the renderer that minted them, with a cache-free
   *    manifest lookup so window A's manifest can never be served to window B.
   * 3. **Unbound** — api-key / pane tokens, which keep the shared dispatch and
   *    cached-manifest path and follow window focus, as documented.
   *
   * The two bound routes are mutually exclusive by construction: a selector
   * from a pinned bearer is refused at handshake.
   */
  private buildSessionServerDeps(
    sessionId: string,
    workspaceBinding?: McpWorkspaceBinding
  ): import("./sessionServer.js").SessionServerDeps {
    const pinnedDispatch = this.deps.dispatchActionForWebContents;
    const pinnedManifest = this.deps.requestManifestForWebContents;
    const workspaceDispatch = this.deps.dispatchActionForWorkspace;
    const workspaceManifest = this.deps.requestManifestForWorkspace;
    // Snapshotted for the same reason as the pin below: a session torn down
    // mid-call must keep failing closed to its own workspace rather than
    // silently reverting to the focused-window path.
    const boundWorkspaceId = workspaceBinding?.workspaceId ?? null;
    // Captured at build time (both handshakes populate the map before calling
    // this) so an in-flight dispatch settling after teardown deletes the map
    // entry still stamps its audit record / resolves its turnId correctly.
    // The turn-id register in TurnOutcomeService is keyed by HELP session id,
    // not the MCP transport id `sessionId` — passing the transport id there
    // always missed, which broke same-turn coalescing and turnId stamping.
    const helpSessionId = this.deps.sessionStore.sessionHelpIdMap.get(sessionId) ?? null;
    // Snapshot the pin at build time (set at handshake before this runs, and
    // only ever deleted on teardown — never re-pointed). Capturing it makes the
    // `getCachedManifest` closure below read strictly this session's own
    // per-WebContents cache, so a session torn down mid-call can never flip to
    // the shared cache and leak another window's tool surface (#7003 / #9887).
    const pinnedWebContentsId = this.deps.sessionStore.sessionWebContentsMap.get(sessionId) ?? null;
    // Snapshotted for the same reason as the pin: `clearSessionBinding` deletes
    // the origin entry on teardown, and `getOrigin` fails closed to `external`
    // — so an in-flight dispatch settling after that would downgrade one of the
    // assistant's own spawns to "an external client did this" (#11808). Read
    // here, before the closure, never inside it.
    const sessionOrigin = this.deps.sessionStore.getOrigin(sessionId);

    /**
     * A bound session whose workspace route is unwired must fail, never fall
     * through (#11789). The helpers are individually optional for the same
     * reason the pinned ones are — test fixtures that don't wire routing — but
     * "bound, and quietly following focus instead" is the precise bug this
     * feature exists to remove, so it can never be a fallback.
     */
    const missingWorkspaceRoute = (): Error =>
      new WorkspaceBindingError(boundWorkspaceId ?? "", "not-found");

    const requestManifest: import("./sessionServer.js").SessionServerDeps["requestManifest"] =
      () => {
        if (boundWorkspaceId !== null) {
          return workspaceManifest
            ? workspaceManifest(boundWorkspaceId)
            : Promise.reject(missingWorkspaceRoute());
        }
        const id = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
        if (id !== undefined && pinnedManifest) {
          return pinnedManifest(id);
        }
        return this.deps.requestManifest();
      };

    const dispatchAction: import("./sessionServer.js").SessionServerDeps["dispatchAction"] = (
      actionId,
      args,
      confirmed
    ) => {
      if (boundWorkspaceId !== null) {
        // No context override: unlike a help session, which replays the
        // ActionContext snapshot taken when the user launched it (#8317), a
        // bound external session has no launch moment to replay — and the bound
        // view's own live context already describes the right workspace.
        //
        // No `callerInfo` either: it exists solely to name the requesting client
        // in the confirm dialog (#9157), and a bound session's surface excludes
        // every confirm-gated tool, so nothing could ever read it.
        //
        // `sessionOrigin` is threaded even though only `external` sessions may
        // bind — a selector from a pinned bearer is refused at handshake — so
        // the payload is built the same way on all three routes rather than one
        // of them relying on a default that a later binding rule could falsify.
        return workspaceDispatch
          ? workspaceDispatch(boundWorkspaceId, actionId, args, confirmed, sessionOrigin)
          : Promise.reject(missingWorkspaceRoute());
      }
      const id = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
      if (id !== undefined && pinnedDispatch) {
        // Replay the provision-time context snapshot so the assistant's
        // tool call targets the worktree/terminal the user had focused
        // when they launched it — not wherever focus drifted to during
        // the model's turn (#8317). Absent for context-less sessions, in
        // which case pinned dispatch falls back to live renderer context.
        const boundContext = this.deps.sessionStore.sessionContextMap.get(sessionId);
        return pinnedDispatch(id, actionId, args, confirmed, boundContext, sessionOrigin);
      }
      // Unpinned external/api-key dispatch — surface the requesting bearer's
      // identity so the confirm dialog can name the client (#9157). Returns
      // null (→ undefined) for help-session bearers, so callerInfo never
      // reaches the renderer for the assistant's own dispatches.
      const callerInfo = this.getBearerInfoForSession(sessionId) ?? undefined;
      return this.deps.dispatchAction(actionId, args, confirmed, callerInfo, sessionOrigin);
    };

    const getCachedManifest: import("./sessionServer.js").SessionServerDeps["getCachedManifest"] =
      () => {
        // Pinned sessions never read the shared manifest cache (it could serve
        // another window's tool surface). Instead they read a per-WebContents
        // cache keyed by the build-time-captured pinned id (#9887), so the
        // per-call `lookupManifestEntry` hot path hits a warm cache rather than
        // re-fetching the full manifest on every dispatch — while still never
        // crossing windows. Reading the captured id (not a live map lookup)
        // means a session torn down mid-call stays pinned here and fails closed
        // to `null` (evicted cache) rather than flipping to the shared cache.
        // Workspace-bound sessions get the same treatment against the view that
        // currently owns their workspace (#11789).
        if (boundWorkspaceId !== null) {
          return this.deps.getCachedManifestForWorkspace?.(boundWorkspaceId) ?? null;
        }
        if (pinnedWebContentsId !== null) {
          return this.deps.getCachedManifestForWebContents?.(pinnedWebContentsId) ?? null;
        }
        return this.deps.getCachedManifest();
      };

    /**
     * Whether this session's events belong in a Daintree assistant surface
     * (#11789).
     *
     * The five notification closures below all used to gate on "is there a
     * WebContents pinned to this session", which was an accidental proxy for
     * "is this one of ours" — accidental because external sessions were never
     * pinned. Workspace-bound external sessions have a renderer route and are
     * still not ours: `HelpPanel` is mounted unconditionally in `AppLayout`, so
     * these events would genuinely land, putting a third-party client's tool
     * calls in the Assistant's activity strip and offering its tier-mismatch
     * approval controls — controls whose `issueGrant` / `setSessionTier` calls
     * the origin gate then has to refuse.
     */
    const isRendererOwned = (notifiedSessionId: string): boolean =>
      this.deps.sessionStore.isRendererOwnedOrigin(notifiedSessionId);

    const notifyTierMismatch: import("./sessionServer.js").SessionServerDeps["notifyTierMismatch"] =
      (payload) => {
        // Daintree's own assistant surfaces only — a third-party client has no
        // panel to show a banner in, and its denials are not the user's to
        // approve. Targeted at the pinned WebContents so the assistant panel
        // that triggered the call gets the event, even if a different project
        // view is currently focused.
        if (!isRendererOwned(payload.sessionId)) return;
        const id = this.deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
        if (id === undefined) return;
        const wc = webContentsModule.fromId(id);
        if (!wc || wc.isDestroyed()) return;
        try {
          wc.send(CHANNELS.MCP_TIER_NOT_PERMITTED, {
            sessionId: payload.sessionId,
            toolId: payload.toolId,
            tier: payload.tier,
            targetTier: payload.targetTier,
          });
        } catch (err) {
          console.error("[MCP] tier-not-permitted send failed:", err);
        }
      };

    const recordDenial: import("./sessionServer.js").SessionServerDeps["recordDenial"] = (
      sessionId,
      kind
    ) => {
      return this.deps.abusePolicy.recordDenial(sessionId, kind);
    };

    const notifySessionRevoked: import("./sessionServer.js").SessionServerDeps["notifySessionRevoked"] =
      (payload) => {
        // Prefer the caller's snapshot over a live read (#11789). This event
        // fires *after* `revokeSession`, which clears the origin along with
        // everything else — so re-reading it here would hit the fail-closed
        // `external` default and silently drop the recovery banner for a
        // genuine help session that tripped the abuse threshold. The caller
        // captured both fields before revoking for exactly this reason.
        if (!(payload.rendererOwned ?? isRendererOwned(payload.sessionId))) return;
        const id =
          payload.pinnedWebContentsId ??
          this.deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
        if (id === undefined) return;
        const wc = webContentsModule.fromId(id);
        if (!wc || wc.isDestroyed()) return;
        try {
          wc.send(CHANNELS.MCP_SESSION_REVOKED, {
            sessionId: payload.sessionId,
            denialKind: payload.denialKind,
          });
        } catch (err) {
          console.error("[MCP] session-revoked send failed:", err);
        }
      };

    const notifyToolCallStarted: import("./sessionServer.js").SessionServerDeps["notifyToolCallStarted"] =
      (payload) => {
        // Daintree's own assistant surfaces only — targeted at the pinned
        // WebContents so the assistant panel that triggered the call gets the
        // live activity event, even if a different project view is focused. A
        // third-party client's calls do not belong in that strip.
        if (!isRendererOwned(payload.sessionId)) return;
        const id = this.deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
        if (id === undefined) return;
        const wc = webContentsModule.fromId(id);
        if (!wc || wc.isDestroyed()) return;
        // Redact args with the same pipeline the audit record uses so the strip
        // never shows raw bearer tokens or absolute paths (#9759). The turn id
        // is the snapshot the dispatch took at call-start (#10067) — not a fresh
        // read here, which could disagree with the settled/audit value if the
        // FSM transitioned mid-call.
        const turnId = payload.capturedTurnId;
        try {
          wc.send(CHANNELS.MCP_TOOL_CALL_STARTED, {
            sessionId: payload.sessionId,
            toolId: payload.toolId,
            argsSummary: summarizeMcpArgs(payload.args, (s) => scrubSecrets(sanitizePath(s))),
            startedAt: payload.startedAt,
            danger: payload.danger,
            ...(turnId !== null ? { turnId } : {}),
          });
        } catch (err) {
          console.error("[MCP] tool-call-started send failed:", err);
        }
      };

    const notifyToolCallSettled: import("./sessionServer.js").SessionServerDeps["notifyToolCallSettled"] =
      (payload) => {
        if (!isRendererOwned(payload.sessionId)) return;
        const id = this.deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
        if (id === undefined) return;
        const wc = webContentsModule.fromId(id);
        if (!wc || wc.isDestroyed()) return;
        // Derive result/errorCode/severity from the same classifier the audit
        // writer uses, so the strip's glyph and red-tint match the audit log.
        const { result, errorCode } = classifyMcpDispatchResult(payload.outcome);
        // Same snapshot the started event carried (#10067) — guarantees the
        // strip's in-flight row and its settled row resolve to one turn group.
        const turnId = payload.capturedTurnId;
        try {
          wc.send(CHANNELS.MCP_TOOL_CALL_SETTLED, {
            sessionId: payload.sessionId,
            toolId: payload.toolId,
            durationMs: Math.max(0, Math.round(payload.durationMs)),
            result,
            ...(errorCode !== undefined ? { errorCode } : {}),
            severity: computeMcpAuditSeverity(result, errorCode),
            ...(turnId !== null ? { turnId } : {}),
          });
        } catch (err) {
          console.error("[MCP] tool-call-settled send failed:", err);
        }
      };

    const notifyDisplayImage: import("./sessionServer.js").SessionServerDeps["notifyDisplayImage"] =
      (payload) => {
        // Daintree's own assistant surfaces only — targeted at the pinned
        // WebContents so the figure renders in the assistant panel that
        // triggered the call, even if a different project view is focused. The
        // tool is outside the external allowlist as well, so this is belt and
        // braces.
        if (!isRendererOwned(payload.sessionId)) return;
        const id = this.deps.sessionStore.sessionWebContentsMap.get(payload.sessionId);
        if (id === undefined) return;
        const wc = webContentsModule.fromId(id);
        if (!wc || wc.isDestroyed()) return;
        try {
          wc.send(CHANNELS.MCP_HELP_DISPLAY_IMAGE, {
            sessionId: payload.sessionId,
            imageId: payload.imageId,
            figureNumber: payload.figureNumber,
            figureLabel: payload.figureLabel,
            url: payload.url,
            ...(payload.caption !== undefined ? { caption: payload.caption } : {}),
            ...(payload.altText !== undefined ? { altText: payload.altText } : {}),
          });
        } catch (err) {
          console.error("[MCP] help-display-image send failed:", err);
        }
      };

    return {
      sessionStore: this.deps.sessionStore,
      // Forwarded so the session server can echo it in the `initialize` result
      // (#11789) — a client must be able to verify where its calls will land
      // before it issues the first mutation.
      ...(workspaceBinding ? { workspaceBinding } : {}),
      requestManifest,
      dispatchAction,
      handleWaitUntilIdle: this.deps.handleWaitUntilIdle,
      handleWaitUntilIdleBatch: this.deps.handleWaitUntilIdleBatch,
      handleSkillsSearch: this.deps.handleSkillsSearch,
      handleSkillsLoad: this.deps.handleSkillsLoad,
      handleProjectRunCheck: this.deps.handleProjectRunCheck,
      appendAuditRecord: (input) => {
        // Scrub structural secrets BEFORE the truncation step inside
        // `summarizeMcpArgs` — running the scrubber after truncation would
        // miss bearer tokens whose body got cut below the scrubber's
        // 8-char minimum match length.
        // Stamp the turn id from the dispatch-start snapshot (#10067), never a
        // fresh read at write time — by the time the audit lands the FSM may
        // have cleared the turn, which would split this call away from the
        // started/settled strip events that already carry it.
        // `capturedTurnId` is the transport-only carrier — peel it off so it
        // never lands in the persisted record (the stamped `turnId` is the
        // public field).
        const { capturedTurnId, ...recordInput } = input;
        const turnId = capturedTurnId ?? null;
        const resultSummary = summarizeAuditOutcome(input.outcome, (s) =>
          scrubSecrets(sanitizePath(s))
        );
        // `summarizeAuditOutcome` returns null for all gate outcomes by
        // contract — the wait-time hint for `rate_limited` reaches the audit
        // record through `resultMeta` instead, so the recent-calls popover
        // can surface the integer-seconds value the agent already received
        // in the JSON-RPC error (`details: { retryAfter }`) without
        // re-scrubbing display text or polluting the tool-output summary
        // (#10014).
        const resultMeta =
          input.outcome.kind === "rate_limited"
            ? { retryAfter: input.outcome.retryAfter }
            : undefined;
        this.deps.auditService.appendRecord({
          ...recordInput,
          argsSummary: summarizeMcpArgs(input.args, (s) => scrubSecrets(sanitizePath(s))),
          ...(turnId !== null ? { turnId } : {}),
          ...(helpSessionId !== null ? { helpSessionId } : {}),
          ...(resultSummary !== null ? { resultSummary } : {}),
          ...(resultMeta !== undefined ? { resultMeta } : {}),
        });
      },
      getCachedManifest,
      notifyTierMismatch,
      recordDenial,
      notifySessionRevoked,
      clearDenialState: (sessionId) => {
        this.deps.abusePolicy.dropSession(sessionId);
      },
      // Single live read of the turn register, called once per dispatch from
      // sessionServer (#10067). Closes over the build-time `helpSessionId` so
      // the snapshot it returns is the turn this session's call is part of.
      getCurrentTurnId: () =>
        helpSessionId !== null
          ? this.deps.turnOutcomeService.getCurrentTurnIdForSession(helpSessionId)
          : null,
      notifyToolCallStarted,
      notifyToolCallSettled,
      notifyDisplayImage,
    };
  }

  /**
   * Promote a help-session's tier in-memory — the tier-mismatch banner's "Set
   * project default", never its per-tool "Allow this tool" grant. Refuses
   * downgrades
   * — a malicious renderer cannot drop its own privileges. When `callerWcId`
   * is supplied, also requires the caller to be the WebContents the session
   * was pinned to at handshake (cross-window forgery defence). Returns the
   * new tier or throws if the session is unknown / the request is invalid.
   */
  setSessionTier(
    sessionId: string,
    tier: McpTier,
    callerWcId?: number
  ): { sessionId: string; tier: McpTier } {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    if (tier !== "workbench" && tier !== "action" && tier !== "system") {
      throw new Error("Invalid tier");
    }
    const current = this.deps.sessionStore.sessionTierMap.get(sessionId);
    if (current === undefined) {
      throw new Error("Unknown session");
    }
    // Reject elevations for sessions whose transport already closed (idle
    // timeout, server shutdown). The tier-map entry can outlive the transport
    // briefly during cleanup; mutating a dead entry would silently fail when
    // the next call lands.
    if (
      !this.deps.sessionStore.sessions.has(sessionId) &&
      !this.deps.sessionStore.httpSessions.has(sessionId)
    ) {
      throw new Error("Session is no longer active");
    }
    // Only Daintree's own assistant surfaces may be elevated here — a
    // third-party client has no UI invariant to satisfy. Gated on the recorded
    // origin, not on merely having a renderer route (#11789): a
    // workspace-bound external session has a route, and inferring eligibility
    // from it would hand this surface to exactly the caller class it excludes.
    const pinnedWcId = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (pinnedWcId === undefined || !this.deps.sessionStore.isRendererOwnedOrigin(sessionId)) {
      throw new Error("Session is not eligible for renderer tier elevation");
    }
    if (callerWcId !== undefined && callerWcId !== pinnedWcId) {
      // Cross-WebContents forgery: another renderer is trying to elevate a
      // session that wasn't minted by it. Reject loudly.
      throw new Error("Caller is not the pinned renderer for this session");
    }
    const order: McpTier[] = ["workbench", "action", "system", "external"];
    const currentRank = order.indexOf(current);
    const newRank = order.indexOf(tier);
    if (newRank < currentRank) {
      // Refuse downgrades — keep current tier.
      return { sessionId, tier: current };
    }
    this.deps.sessionStore.sessionTierMap.set(sessionId, tier);
    // Bound the renderer-approved elevation: after MCP_TIER_ELEVATION_TTL_MS
    // of awake time the session silently decays back to its pre-elevation
    // baseline. `current` is only the candidate — on a chained elevation
    // `armTierElevationTimer` keeps the baseline the first one captured, so
    // workbench→action→system still decays all the way to workbench. A stale
    // elevation therefore can't outlive the user's intent (#8462), which is
    // why the banner no longer labels this "always" (#12119). Each approval
    // refreshes the window from now; a chained re-elevation preserves the
    // original baseline.
    this.deps.sessionStore.armTierElevationTimer(sessionId, tier, current);
    // Positive audit trail for the elevation (#9151): records who elevated
    // (via the pinned session), the target tier, the pre-elevation tier, and
    // the bounded window. Only genuine elevations are logged — a same-tier
    // call (`newRank === currentRank`) arms no timer and changes nothing, so
    // recording an `action → action` row would be misleading noise.
    // Best-effort: an audit-write failure must never block the elevation.
    if (newRank > currentRank) {
      try {
        this.deps.auditService.appendGrantRecord({
          type: "tier.elevated",
          sessionId,
          toolId: "*",
          ttlMs: MCP_TIER_ELEVATION_TTL_MS,
          expiresAt: Date.now() + MCP_TIER_ELEVATION_TTL_MS,
          tier,
          previousTier: current,
        });
      } catch (err) {
        console.error("[MCP] Failed to append tier.elevated audit record:", err);
      }
    }
    return { sessionId, tier };
  }

  /**
   * Mint a time-bounded per-`(sessionId, toolId)` grant — the "Approve
   * once" pathway that replaces sticky session-tier elevation for single
   * tool calls (#8442). Validates the same caller-pin invariant as
   * {@link setSessionTier}: only the renderer that minted the session
   * can issue grants on its behalf.
   */
  issueGrant(sessionId: string, toolId: string, callerWcId?: number): McpIssueGrantResult {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    if (!toolId || typeof toolId !== "string") {
      throw new Error("Invalid toolId");
    }
    if (
      !this.deps.sessionStore.sessions.has(sessionId) &&
      !this.deps.sessionStore.httpSessions.has(sessionId)
    ) {
      throw new Error("Session is no longer active");
    }
    // Origin-gated for the same reason as {@link setSessionTier} (#11789), and
    // more urgently: `issueGrant` has no rank floor to fall back on. Its only
    // other check is `minimumPermittingTier(toolId) !== null`, and the call gate
    // honours a grant over failed tier membership — so an external session that
    // reached this surface could hold a grant for a tool outside
    // `MCP_EXTERNAL_TIER_TOOLS` entirely.
    const pinnedWcId = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (pinnedWcId === undefined || !this.deps.sessionStore.isRendererOwnedOrigin(sessionId)) {
      throw new Error("Session is not eligible for renderer tier elevation");
    }
    if (callerWcId !== undefined && callerWcId !== pinnedWcId) {
      throw new Error("Caller is not the pinned renderer for this session");
    }
    // Same floor `issueNativeGrant` enforces: a grant may only name a tool some
    // non-external help tier already permits. Without this the single-tool path
    // could mint a grant for an id in NO tier at all (`actions.persistedStores`),
    // and the call gate honours a grant over failed tier membership — so the
    // authorization contract would rest on the UI never offering the button
    // rather than on the main process refusing (#11585).
    if (minimumPermittingTier(toolId) === null) {
      throw new Error(`Unknown or non-grantable tool: ${toolId}`);
    }
    const entry = this.deps.sessionStore.grantCache.issueGrant(sessionId, toolId);
    return {
      sessionId,
      toolId,
      ttlMs: entry.ttlMs,
      expiresAt: entry.expiresAt,
    };
  }

  /**
   * Drop every grant currently held by the session. Caller-pin checked
   * identically to {@link issueGrant}. Returns the count of revoked
   * grants for the renderer's confirmation copy.
   */
  revokeSessionGrants(sessionId: string, callerWcId?: number): McpRevokeSessionGrantsResult {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    // Caller-pin is enforced when the session is still alive; if the
    // session has already drained (idle reaper / explicit close) the
    // pin map is empty and the revoke becomes an idempotent no-op so
    // the renderer's cleanup pass after a banner dismissal succeeds
    // even though there's nothing left to drop.
    const pinnedWcId = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (pinnedWcId !== undefined && callerWcId !== undefined && callerWcId !== pinnedWcId) {
      throw new Error("Caller is not the pinned renderer for this session");
    }
    const revokedCount = this.deps.sessionStore.grantCache.revokeSession(sessionId, "user");
    return { sessionId, revokedCount };
  }

  /**
   * Approve a native session-scoped automation grant (#10648), addressed by
   * the *public* help-session id the renderer holds. Resolves the live
   * transport session behind it (caller-pinned, so only the renderer that
   * minted the session can approve grants for it), validates the scope and
   * limits, then mints the grant. Unlike {@link issueGrant} a native grant
   * authorizes a *set* of tools for a bounded number of uses without a
   * per-call modal — so the allowlist, use ceiling, and TTL are all validated
   * here before the cache mints anything.
   */
  issueNativeGrant(
    helpSessionId: string,
    params: { allowedTools: string[]; maxUses?: number; ttlMs?: number },
    callerWcId?: number
  ): McpIssueNativeGrantResult {
    if (!helpSessionId || typeof helpSessionId !== "string") {
      throw new Error("Invalid helpSessionId");
    }
    if (callerWcId === undefined) {
      throw new Error("Caller WebContents id is required to issue a native grant");
    }
    const transportSessionId = this.deps.sessionStore.resolveLiveTransportForHelpSession(
      helpSessionId,
      callerWcId
    );
    if (transportSessionId === null) {
      throw new Error("No live pinned session for this help session");
    }

    const requested = Array.isArray(params?.allowedTools) ? params.allowedTools : [];
    const allowedTools = [
      ...new Set(requested.filter((t): t is string => typeof t === "string" && t.length > 0)),
    ];
    if (allowedTools.length === 0) {
      throw new Error("A native grant must authorize at least one tool");
    }
    if (allowedTools.length > MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS) {
      throw new Error(
        `A native grant may authorize at most ${MCP_NATIVE_GRANT_MAX_ALLOWED_TOOLS} tools`
      );
    }
    // Reject tools no non-external help tier permits — a grant must name a real,
    // scope-bounded tool. This is also what keeps grants additive: they can
    // only ever authorize tools that exist in the help-tier universe, never
    // elevate the session to the api-key-only `external` surface.
    const ungrantable = allowedTools.filter((t) => minimumPermittingTier(t) === null);
    if (ungrantable.length > 0) {
      throw new Error(`Unknown or non-grantable tool(s): ${ungrantable.join(", ")}`);
    }
    // A grant's `maxUses` is what the Settings card shows the user, so it has
    // to mean something. For a tool that fans out across every target it
    // resolves at dispatch time it cannot: the count isn't known when the use
    // is charged, so "10 uses" would authorize ten unbounded sweeps (#12121).
    // Reject the whole request rather than quietly dropping the offender —
    // the minted scope must be exactly the scope the user approved.
    const fanOut = allowedTools.filter((t) => !isGenericNativeGrantEligible(t));
    if (fanOut.length > 0) {
      throw new Error(
        `A native grant cannot cover ${fanOut.join(", ")}: each call acts on every target it ` +
          `finds, so a use ceiling bounds how many calls run, never how much they affect. ` +
          `Remove ${fanOut.length > 1 ? "them" : "it"} — those calls still run under the ` +
          `session's normal tier and confirmation rules.`
      );
    }

    const maxUses = params.maxUses ?? MCP_NATIVE_GRANT_DEFAULT_MAX_USES;
    if (
      !Number.isInteger(maxUses) ||
      maxUses < MCP_NATIVE_GRANT_MIN_MAX_USES ||
      maxUses > MCP_NATIVE_GRANT_MAX_MAX_USES
    ) {
      throw new Error(
        `maxUses must be an integer in [${MCP_NATIVE_GRANT_MIN_MAX_USES}, ${MCP_NATIVE_GRANT_MAX_MAX_USES}]`
      );
    }

    const ttlMs = params.ttlMs;
    if (
      ttlMs !== undefined &&
      (!Number.isFinite(ttlMs) ||
        ttlMs < MCP_NATIVE_GRANT_MIN_TTL_MS ||
        ttlMs > MCP_GRANT_MAX_LIFETIME_MS)
    ) {
      throw new Error(
        `ttlMs must be in [${MCP_NATIVE_GRANT_MIN_TTL_MS}, ${MCP_GRANT_MAX_LIFETIME_MS}]`
      );
    }

    const entry = this.deps.sessionStore.grantCache.issueNativeGrant({
      sessionId: transportSessionId,
      actorId: helpSessionId,
      actorType: "help-session",
      allowedTools,
      maxUses,
      ttlMs,
    });
    return {
      grantId: entry.id,
      sessionId: entry.sessionId,
      actorId: entry.actorId,
      actorType: entry.actorType,
      allowedTools: [...entry.allowedTools],
      maxUses: entry.maxUses,
      remainingUses: entry.remainingUses,
      ttlMs: entry.ttlMs,
      expiresAt: entry.expiresAt,
    };
  }

  /**
   * Revoke a single native grant by id. Caller-pinned against the session the
   * grant belongs to so a renderer can only revoke its own session's grants.
   * Idempotent: a grant already gone (exhausted, expired, or torn down with
   * its session) reports `revoked: false` so a dismissal cleanup never throws.
   */
  revokeNativeGrant(grantId: string, callerWcId?: number): McpRevokeNativeGrantResult {
    if (!grantId || typeof grantId !== "string") {
      throw new Error("Invalid grantId");
    }
    const entry = this.deps.sessionStore.grantCache.getNativeGrant(grantId);
    if (!entry) {
      // Already gone — idempotent no-op. No pin to check (the session may have
      // drained), so this is safe to report as a non-revoke.
      return { grantId, revoked: false };
    }
    const pinnedWcId = this.deps.sessionStore.sessionWebContentsMap.get(entry.sessionId);
    if (pinnedWcId !== undefined && callerWcId !== undefined && callerWcId !== pinnedWcId) {
      throw new Error("Caller is not the pinned renderer for this grant's session");
    }
    const revoked = this.deps.sessionStore.grantCache.revokeNativeGrant(grantId, "user");
    return { grantId, revoked };
  }

  /**
   * Drop the per-`(sessionId, toolId)` denial counters for a session without
   * touching its grants. Called when the user dismisses the tier-mismatch
   * banner (Cancel) so the next out-of-tier call re-shows the banner instead
   * of being silently suppressed by the abuse policy after the denial
   * threshold. Caller-pin checked identically to {@link revokeSessionGrants};
   * a drained session is an idempotent no-op so the renderer's dismissal
   * cleanup always succeeds.
   */
  resetDenialCounts(sessionId: string, callerWcId?: number): void {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    const pinnedWcId = this.deps.sessionStore.sessionWebContentsMap.get(sessionId);
    if (pinnedWcId !== undefined && callerWcId !== undefined && callerWcId !== pinnedWcId) {
      throw new Error("Caller is not the pinned renderer for this session");
    }
    this.deps.sessionStore.grantCache.clearDenialCounts(sessionId);
  }

  /**
   * Snapshot the externally-connected clients for the disable-confirmation
   * dialog (#8779). Empty when the server isn't listening.
   */
  listActiveClients(): McpActiveClientInfo[] {
    if (!this.isRunning) return [];
    return this.deps.sessionStore.listExternalActiveClients();
  }

  getStatus(): {
    enabled: boolean;
    port: number | null;
    configuredPort: number | null;
    apiKey: string;
  } {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      port: this.port,
      configuredPort: config.port,
      apiKey: this.apiKey ?? "",
    };
  }

  /**
   * The Claude Code shape, kept as the zero-argument IPC contract. Per-client
   * variants are built in the renderer from the same shared builder (#11535).
   */
  getConfigSnippet(): string {
    return buildMcpClientConfig("claude-code", {
      port: this.port,
      apiKey: this.apiKey ?? null,
    }).snippet;
  }
}
