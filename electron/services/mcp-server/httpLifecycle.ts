// eager-import-allow: reads MCP server config via store.get synchronously during lifecycle setup
import http from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { app } from "electron";
import type { WindowRegistry } from "../../window/WindowRegistry.js";
import { store } from "../../store.js";
import { CHANNELS } from "../../ipc/channels.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import type {
  HelpTokenValidator,
  HelpSessionWebContentsResolver,
  HelpSessionViewlessProjectResolver,
  HelpSessionActionContextResolver,
  HelpSessionIdResolver,
  PaneWorkspaceBinding,
  PaneWorkspaceBindingResolver,
  PaneOwnershipPrincipalResolver,
  PaneTerminalResolver,
  HelpSessionTerminalResolver,
  AssistantControlBinding,
  McpRelayCaller,
  McpTier,
  McpSessionOrigin,
  McpWorkspaceBinding,
} from "./shared.js";
import { parseWorkspaceSelector, type WorkspaceSelectorRejection } from "./workspaceSelector.js";
import { helpOwnershipPrincipal, relayOwnershipPrincipal } from "./resourceOwnership.js";
import { WorkspaceBindingError } from "./rendererBridge.js";
import { NO_VIEW_HANDLE } from "../../ipc/endpoint.js";
import { PLUGIN_MCP_ROUTE_PREFIX, type PluginMcpRouteHandler } from "../pluginAgentMcp/types.js";
import {
  assertHeldRoutePath,
  closeHeldRoute,
  heldRouteServes,
  inHeldRouteNamespace,
  type ListenerHold,
  type ListenerRoute,
} from "./listenerHold.js";
import { isProjectWorkspaceId, isScratchWorkspaceId } from "../../../shared/utils/workspaceIds.js";
import type {
  ActiveBearerRecord,
  HelpSessionBearerRecord,
  McpActiveClientInfo,
  McpBearerIdentity,
  McpIssueGrantResult,
  McpIssueNativeGrantResult,
  McpRevokeNativeGrantResult,
  McpRevokeGrantResult,
  McpTurnOutcomeAlertPayload,
} from "../../../shared/types/ipc/mcpServer.js";
import {
  extractBearerToken,
  isAuthorized,
  precomputeApiKeyBearerHash,
  resolveTokenTier,
} from "./tierAuth.js";
import { createSessionServer } from "./sessionServer.js";
import {
  createSessionServerDeps,
  sendToPinnedView,
  type SessionServerDepsHost,
  type SessionServerDepsSource,
} from "./sessionServerDeps.js";
import { buildMcpClientConfig } from "../../../shared/config/mcpClientConfigs.js";
import { isGenericNativeGrantEligible } from "../../../shared/config/nativeGrantUsePolicies.js";
import { paneNotifyKey } from "./terminalNotify.js";
import {
  DEFAULT_PORT,
  MAX_PORT_RETRIES,
  MAX_RESTART_ATTEMPTS,
  RESTART_BASE_DELAY_MS,
  RESTART_MAX_DELAY_MS,
  RESTART_JITTER_MS,
  RESTART_STABLE_RESET_MS,
  MCP_STOP_DRAIN_TIMEOUT_MS,
  MCP_SSE_HEARTBEAT_INTERVAL_MS,
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
  RELAY_CALL_ID_META_KEY,
  minimumPermittingTier,
} from "./shared.js";

export { sendToPinnedView };

export interface HttpLifecycleDeps extends SessionServerDepsSource {
  /**
   * Validate a handshake workspace selector, or throw when it names no live
   * view or more than one (#11789).
   */
  resolveWorkspaceBinding?: (workspaceId: string) => McpWorkspaceBinding;
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
 * Keeps an idle `/sse` stream from looking dead to the client. Claude Code's
 * HTTP client (undici) aborts a response body that goes 300 s without a byte,
 * which silently churned the session — and everything keyed to it — after
 * five quiet minutes (#12994). An SSE comment line is ignored by every parser
 * and carries no MCP traffic, so it deliberately does not reset the session's
 * idle timer: only real requests do.
 */
function startSseHeartbeat(res: http.ServerResponse): ReturnType<typeof setInterval> | undefined {
  if (res.writableEnded || res.destroyed) return undefined;
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, MCP_SSE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  res.once("close", () => clearInterval(heartbeat));
  return heartbeat;
}

/**
 * The identity a session is bound to at handshake and checked against on every
 * follow-up.
 *
 * Digests the extracted token rather than the raw header because pane and help
 * tokens are parsed with a case-insensitive scheme and trimmed whitespace
 * (`extractBearerToken`): a client that sends `bearer  tok` on one leg and
 * `Bearer tok` on the next is the same bearer, and `isAuthorized` accepts both.
 * The raw header is the fallback only when no token can be extracted — the
 * unauthenticated loopback path, where every caller presents the same empty
 * header and is equally privileged. The two inputs are prefixed so a header
 * can never collide with a token.
 */
/** One relayed session as its opener holds it: call its tools, close it. */
export interface McpRelaySessionHandle {
  readonly sessionId: string;
  isOpen(): boolean;
  callTool(
    tool: string,
    args: Record<string, unknown>,
    options: { timeoutMs: number; callId: string }
  ): Promise<CallToolResult>;
  close(): void;
}

export function sessionCredentialDigest(authHeader: string): string {
  const token = extractBearerToken(authHeader);
  const material = token !== null ? `token:${token}` : `raw:${authHeader}`;
  return createHash("sha256").update(material).digest("hex");
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

interface HeldListener {
  id: string;
  route: ListenerRoute;
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
  private helpSessionViewlessProjectResolver: HelpSessionViewlessProjectResolver | null = null;
  private helpSessionActionContextResolver: HelpSessionActionContextResolver | null = null;
  private helpSessionIdResolver: HelpSessionIdResolver | null = null;
  private paneWorkspaceBindingResolver: PaneWorkspaceBindingResolver | null = null;
  private paneOwnershipPrincipalResolver: PaneOwnershipPrincipalResolver | null = null;
  private paneTerminalResolver: PaneTerminalResolver | null = null;
  private helpSessionTerminalResolver: HelpSessionTerminalResolver | null = null;
  private assistantControlBinding: AssistantControlBinding | null = null;
  /**
   * Main's side of one assistant addressing another (#13496) as each call
   * finds it, so a session opened before the binding was set is held to it
   * from then on. Unbound, nothing is an assistant: none can run before then.
   */
  private readonly assistantControl: AssistantControlBinding["control"] = {
    isAssistantTerminal: (terminalId) =>
      this.assistantControlBinding?.control.isAssistantTerminal(terminalId) ?? false,
    resolve: (caller, terminalId) =>
      this.assistantControlBinding?.control.resolve(caller, terminalId) ?? null,
    list: (...args) => this.boundAssistantControl().list(...args),
    start: (...args) => this.boundAssistantControl().start(...args),
    submit: (...args) => this.boundAssistantControl().submit(...args),
    sendKeys: (...args) => this.boundAssistantControl().sendKeys(...args),
    interrupt: (...args) => this.boundAssistantControl().interrupt(...args),
    close: (...args) => this.boundAssistantControl().close(...args),
    readReply: (...args) => this.boundAssistantControl().readReply(...args),
  };
  /** What a session's deps read live from here, so a later set is the one a call finds. */
  private readonly sessionDepsHost: SessionServerDepsHost = {
    registry: () => this.registry,
    assistantControlBinding: () => this.assistantControlBinding,
    helpSessionTerminalResolver: () => this.helpSessionTerminalResolver,
    getBearerInfoForSession: (sessionId) => this.getBearerInfoForSession(sessionId),
    assistantControl: this.assistantControl,
  };
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
  private pluginRouteHandler: PluginMcpRouteHandler | null = null;
  /** Feature routes holding the listener open, by hold id (#15999). */
  private readonly holds = new Map<string, HeldListener>();
  /**
   * The listener is open for holds alone: the control surface isn't served,
   * and a request for anything but a held route finds nothing there.
   */
  private holdsOnly = false;
  /** The start in flight opens the listener for holds alone. */
  private startForHolds = false;
  /** Bumped by every control-surface drain; a handshake that outlives one is retired. */
  private controlEpoch = 0;

  constructor(private readonly deps: HttpLifecycleDeps) {}

  setPluginRouteHandler(handler: PluginMcpRouteHandler | null): void {
    this.pluginRouteHandler = handler;
  }

  /** The control surface is served: the listener is open, and not for holds alone. */
  get isRunning(): boolean {
    return this.isListening && !this.holdsOnly;
  }

  /** The listener itself is open, for the control surface or for holds alone. */
  get isListening(): boolean {
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

  /** The control surface's port; a hold reads the listener's from its handle. */
  get currentPort(): number | null {
    return this.holdsOnly ? null : this.port;
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

  setHelpSessionViewlessProjectResolver(resolver: HelpSessionViewlessProjectResolver | null): void {
    this.helpSessionViewlessProjectResolver = resolver;
  }

  setHelpSessionActionContextResolver(resolver: HelpSessionActionContextResolver | null): void {
    this.helpSessionActionContextResolver = resolver;
  }

  setHelpSessionIdResolver(resolver: HelpSessionIdResolver | null): void {
    this.helpSessionIdResolver = resolver;
  }

  setPaneWorkspaceBindingResolver(resolver: PaneWorkspaceBindingResolver | null): void {
    this.paneWorkspaceBindingResolver = resolver;
  }

  setPaneOwnershipPrincipalResolver(resolver: PaneOwnershipPrincipalResolver | null): void {
    this.paneOwnershipPrincipalResolver = resolver;
  }

  setPaneTerminalResolver(resolver: PaneTerminalResolver | null): void {
    this.paneTerminalResolver = resolver;
  }

  setHelpSessionTerminalResolver(resolver: HelpSessionTerminalResolver | null): void {
    this.helpSessionTerminalResolver = resolver;
  }

  setAssistantControl(binding: AssistantControlBinding | null): void {
    this.assistantControlBinding = binding;
  }

  private boundAssistantControl(): AssistantControlBinding["control"] {
    const binding = this.assistantControlBinding;
    if (binding === null) throw new Error("Assistant control isn't available yet");
    return binding.control;
  }

  /**
   * Parses a Bearer header and asks the help-session resolver which renderer
   * minted it, keeping the origin that match confers (#11789).
   *
   * The origin is the part that cannot be re-derived later: the resolver
   * produces a bare WebContents id, and once it lands in `sessionWebContentsMap`
   * there is no way to tell a Daintree assistant surface from anything else that
   * happens to route to a renderer. Authorization, notification routing, and
   * external-client inventory all need that distinction, so it is recorded here
   * rather than inferred downstream.
   *
   * Returns null for bearers that own no renderer — api-key clients and agent
   * pane tokens — which are classified `external`. An api-key client follows
   * window focus unless it names a workspace; an agent pane is bound to its
   * launch workspace by {@link resolvePaneWorkspaceBinding} instead.
   *
   * A help bearer with no view (#13511) pins `NO_VIEW_HANDLE` and names its
   * project, which routes it to the host's own form of each action. One whose
   * project can't be read keeps the bare pin, which no view answers: it fails
   * closed rather than following focus.
   */
  private resolveSessionPin(
    authHeader: string
  ): { origin: McpSessionOrigin; webContentsId: number; viewlessProjectId?: string } | null {
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    const fromHelp = this.helpSessionWebContentsResolver?.(token) ?? null;
    if (fromHelp === NO_VIEW_HANDLE) {
      const viewlessProjectId = this.helpSessionViewlessProjectResolver?.(token) ?? null;
      return viewlessProjectId !== null
        ? { origin: "help", webContentsId: fromHelp, viewlessProjectId }
        : { origin: "help", webContentsId: fromHelp };
    }
    if (fromHelp !== null) return { origin: "help", webContentsId: fromHelp };
    return null;
  }

  /**
   * The launch workspace of an ordinary agent pane bearer (#12486), for a
   * bearer the help-session resolver didn't match.
   *
   * Server-derived, never client-supplied: the binding was recorded when the
   * pane was spawned, so the pane cannot choose or change its target, and a
   * selector from one is still refused by {@link resolveWorkspaceSelector} on
   * tier. It sets routing only. The session keeps the `external` origin every
   * unpinned bearer gets, so being bound to a view never makes a pane
   * renderer-owned (#12407).
   */
  private resolvePaneWorkspaceBinding(authHeader: string): PaneWorkspaceBinding | null {
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    return this.paneWorkspaceBindingResolver?.(token) ?? null;
  }

  /**
   * The principal a pane bearer's (#12487) or help-session bearer's (#12993)
   * resource ownership is held under, or null for every other bearer — an api
   * key is shared by every external client, so it keeps session-scoped records.
   *
   * Resolved before any session state is written, like the pane's workspace
   * binding, and bound with no await in between, so no revocation can land
   * between the two — a revoked token resolves to nothing, and the session
   * keeps session-scoped ownership. Looked up whatever the session's origin.
   */
  private resolveOwnershipPrincipal(authHeader: string): string | null {
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    const panePrincipal = this.paneOwnershipPrincipalResolver?.(token) ?? null;
    if (panePrincipal !== null) return panePrincipal;
    const helpSessionId = this.helpSessionIdResolver?.(token) ?? null;
    return helpSessionId === null ? null : helpOwnershipPrincipal(helpSessionId);
  }

  /** The principal of a live pane bearer (#12487), or null for every other bearer. */
  private resolvePanePrincipal(authHeader: string): string | null {
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    return this.paneOwnershipPrincipalResolver?.(token) ?? null;
  }

  /**
   * The pane a pane bearer's notices are typed into: its own terminal, keyed
   * by the ownership principal so a reconnect finds the same notices. Null for
   * every other bearer, and for a pane bearer without a principal.
   */
  private resolveOwnPane(
    authHeader: string,
    ownershipPrincipal: string | null
  ): import("./terminalNotify.js").OwnPane | null {
    if (ownershipPrincipal === null) return null;
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    const terminalId = this.paneTerminalResolver?.(token) ?? null;
    return terminalId === null ? null : { key: paneNotifyKey(ownershipPrincipal), terminalId };
  }

  /**
   * Describe a pane's launch workspace for the session's binding record. Same
   * best-effort shape as a selector binding: the descriptive fields come from
   * the live view when exactly one answers, and an unreachable workspace binds
   * identity-only — the pane was launched there, so the route comes back when
   * the workspace does, and each call reports the gap meanwhile.
   */
  private describePaneWorkspaceBinding(workspaceId: string): McpWorkspaceBinding {
    const resolve = this.deps.resolveWorkspaceBinding;
    if (!resolve) return { workspaceId };
    try {
      return resolve(workspaceId);
    } catch (err) {
      if (err instanceof WorkspaceBindingError) return { workspaceId };
      throw err;
    }
  }

  /**
   * Read and resolve a new session's workspace selector (#11789, #12082).
   *
   * Returns `null` when no selector was sent (the session keeps focused-window
   * routing, unchanged), a binding when the selector names a workspace this
   * session may bind to, or a rejection the caller turns into a 400 — creating
   * no session, no transport, and no `Mcp-Session-Id`.
   *
   * Only `external` sessions may bind. A help bearer already routes through
   * the renderer that minted it, so a selector from one is a
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
   * Parses a Bearer header and asks the help-session resolver for the
   * `ActionContext` snapshot bound to it at launch time (#8317). Returns null
   * for non-pinned bearers so external/api-key/generic-pane sessions keep their
   * live focused-window context in `buildSessionServerDeps`.
   */
  private resolveActionContext(
    authHeader: string
  ): import("../../../shared/types/actions.js").ActionContext | null {
    const token = extractBearerToken(authHeader);
    if (!token) return null;
    return this.helpSessionActionContextResolver?.(token) ?? null;
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
   * requests carry the `Authorization` header through this path. Every tier
   * is tracked; non-`external` bearers (help-session and in-pane agent tokens)
   * are flagged `isHelpSession` so they stay out of the "External clients" row
   * — surfacing those would let the user disconnect their own assistant — while
   * still being resolvable for eager teardown (#9151) and listed in the
   * "Daintree Assistant connections" row (#10036).
   *
   * This register is an inventory, not an authorization record: a disconnect
   * clears it. Which bearer may use a session is recorded separately, in
   * `SessionStore.sessionCredentialMap`.
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
   * updates. Reached from every teardown route through
   * `SessionStore.retireSession`'s `dropBearerState` callback.
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
      // A transport session whose view was LRU-evicted/destroyed is skipped,
      // not treated as the answer — a reconnect or concurrent transport for
      // the same help session may still hold a live pin.
      const sent = sendToPinnedView(
        pinnedId,
        CHANNELS.MCP_TURN_OUTCOME_ALERT,
        () => ({
          helpSessionId: payload.helpSessionId,
          outcome: payload.outcome,
          ...(payload.turnId !== undefined ? { turnId: payload.turnId } : {}),
        }),
        "turn-outcome-alert"
      );
      if (!sent) continue;
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
      if (!this.startForHolds) return this.startPromise;
      // A listener opening for holds alone: the control surface joins it once open.
      await this.startPromise.catch(() => {});
      return this.start(registry);
    }

    if (!this.isEnabled()) {
      console.log("[MCP] Server disabled — skipping start");
      return;
    }

    const hadPriorFailure = this.lastError !== null;
    this.lastError = null;
    if (hadPriorFailure) this.deps.emitRuntimeStateChange();

    return this.trackStart(false, async () => {
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

        // A listener a hold opened already serves its routes: the control
        // surface joins it on that port rather than binding a second one.
        if (!this.isListening) {
          const server = this.createServer();
          const configuredPort = this.getConfig().port ?? DEFAULT_PORT;
          const boundPort = await this.listenWithRetry(server, configuredPort);

          if (boundPort === null) {
            throw new Error(
              `Failed to bind MCP server: ports ${configuredPort}–${configuredPort + MAX_PORT_RETRIES} all in use`
            );
          }

          this.port = boundPort;
          this.httpServer = server;
          this.attachServerSupervision(server);
        }
        this.holdsOnly = false;
        this.deps.setupIpcListeners();
        this.armStableTimer();
        console.log(
          `[MCP] Server started on http://127.0.0.1:${this.port}/mcp (Streamable HTTP) and /sse (legacy SSE)`
        );
        this.deps.emitStatusChange();
      } catch (err) {
        this.lastError = formatErrorMessage(err, "MCP server failed to start");
        this.deps.emitRuntimeStateChange();
        throw err;
      }
    });
  }

  /**
   * Record `run` as the start in flight until it settles. Cleared after the
   * field is set, never from inside `run`: a run with nothing to await settles
   * before the assignment, and would leave a settled promise in flight forever.
   */
  private trackStart(forHolds: boolean, run: () => Promise<void>): Promise<void> {
    const promise: Promise<void> = run().finally(() => {
      if (this.startPromise !== promise) return;
      this.startPromise = null;
      this.startForHolds = false;
    });
    this.startPromise = promise;
    this.startForHolds = forHolds;
    return promise;
  }

  /**
   * Keep the listener open for a feature's route whether or not the MCP server
   * is on (#15999). Resolves once the listener is open; a bind that fails
   * takes the hold back with it. With the server off the listener serves the
   * held routes and nothing else; on, they sit beside the control surface.
   */
  async holdListener(id: string, route: ListenerRoute): Promise<ListenerHold> {
    assertHeldRoutePath(route.path);
    if (this.holds.has(id)) throw new Error(`The listener hold "${id}" is already held`);
    for (const other of this.holds.values()) {
      if (other.route.path === route.path) {
        throw new Error(`The listener hold "${other.id}" already serves ${route.path}`);
      }
    }
    const held: HeldListener = { id, route };
    this.holds.set(id, held);
    try {
      await this.ensureListening();
    } catch (err) {
      await this.dropHold(held);
      throw err;
    }
    // Shutdown ends every hold, this one too while it was opening.
    if (this.holds.get(id) !== held) {
      throw new Error(`The listener hold "${id}" ended while it was being opened`);
    }
    const port = () => (this.holds.get(id) === held && this.isListening ? this.port : null);
    return {
      get port() {
        return port();
      },
      release: () => this.dropHold(held),
    };
  }

  /** Whether anything needs the listener open: the server on, or a hold. */
  private listenerWanted(): boolean {
    return (this.isEnabled() && this.registry !== null) || this.holds.size > 0;
  }

  /** Open the listener if something wants it: with the control surface when the server is on. */
  private async ensureListening(): Promise<void> {
    while (this.stopPromise !== null || this.startPromise !== null) {
      await (this.stopPromise ?? this.startPromise)?.catch(() => {});
    }
    if (this.isListening || !this.listenerWanted()) return;
    if (this.isEnabled() && this.registry !== null) {
      await this.start(this.registry);
    } else {
      await this.openForHolds();
    }
  }

  /** Bind the listener as {@link start} does, for the held routes alone. */
  private openForHolds(): Promise<void> {
    return this.trackStart(true, async () => {
      const server = this.createServer();
      const configuredPort = this.getConfig().port ?? DEFAULT_PORT;
      const boundPort = await this.listenWithRetry(server, configuredPort);
      if (boundPort === null) {
        throw new Error(
          `Failed to bind the MCP listener: ports ${configuredPort}–${configuredPort + MAX_PORT_RETRIES} all in use`
        );
      }
      this.port = boundPort;
      this.httpServer = server;
      this.holdsOnly = true;
      this.attachServerSupervision(server);
      this.armStableTimer();
      console.log(
        `[MCP] Listener open on 127.0.0.1:${boundPort} for held routes; the MCP server is off`
      );
    });
  }

  /** End a hold; the last one to go closes a listener it alone kept open. */
  private async dropHold(held: HeldListener): Promise<void> {
    if (this.holds.get(held.id) !== held) return;
    this.holds.delete(held.id);
    closeHeldRoute(held.route);
    if (this.holds.size > 0) return;
    if (!this.listenerWanted() && this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // A stop already under way may have counted this hold before it went.
    while (this.startPromise !== null || this.stopPromise !== null) {
      await (this.stopPromise ?? this.startPromise)?.catch(() => {});
    }
    if (this.holds.size === 0 && this.holdsOnly) await this.stop();
  }

  private heldRouteFor(pathname: string): HeldListener | null {
    for (const held of this.holds.values()) {
      if (heldRouteServes(held.route.path, pathname)) return held;
    }
    return null;
  }

  private closeHeldRoutes(): void {
    for (const held of this.holds.values()) closeHeldRoute(held.route);
  }

  private createServer(): http.Server {
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
    return server;
  }

  private armStableTimer(): void {
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.restartAttempts = 0;
    }, RESTART_STABLE_RESET_MS);
    this.stableTimer.unref?.();
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

  /**
   * End everything the control surface holds: sessions, bearers, the bridge's
   * listeners and requests in flight. The listener itself is left as it is.
   */
  private drainControl(reason: string): void {
    this.controlEpoch++;
    this.deps.auditService.flushNow();
    this.deps.turnOutcomeService.flushNow();
    this.deps.sessionStore.drain();
    this.pluginRouteHandler?.closeAllSessions();
    // Wipe the bearer register so a restart starts from zero live clients —
    // every external client must reconnect, re-registering on handshake.
    this.clearAllBearers();
    // The drain wipes session-scoped state (grants, dedup, pins); the
    // abuse-policy denial Map lives on `deps`, so it is cleared here in
    // lockstep, or its counters would outlive the sessions they count.
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
      pending.reject(new Error(reason));
      this.deps.pendingManifests.delete(id);
    }
    for (const [id, pending] of this.deps.pendingDispatches) {
      clearTimeout(pending.timer);
      pending.destroyedCleanup?.();
      pending.reject(new Error(reason));
      this.deps.pendingDispatches.delete(id);
    }
    this.deps.clearCachedManifest();
  }

  private handleUnexpectedClose(): void {
    const wasRunning = !this.holdsOnly;
    this.drainControl("MCP server closed unexpectedly");
    this.closeHeldRoutes();

    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }

    this.httpServer = null;
    this.port = null;
    this.holdsOnly = false;
    this.lastError = null;
    if (wasRunning) this.deps.emitStatusChange();

    if (!this.listenerWanted()) return;
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
      if (!this.listenerWanted()) return;
      void this.ensureListening().catch((err) => {
        console.error("[MCP] Auto-restart attempt failed:", err);
        if (!this.isListening && this.listenerWanted()) {
          this.scheduleRestart();
        }
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Stop serving the control surface. The listener closes too, unless a hold still needs it. */
  async stop(): Promise<void> {
    return this.halt(false);
  }

  /** The app is quitting: every hold ends and the listener closes, whatever held it. */
  async shutdown(): Promise<void> {
    const held = [...this.holds.values()];
    this.holds.clear();
    for (const { route } of held) closeHeldRoute(route);
    await this.halt(true);
  }

  /** Close the listener and open it again on the configured port, for what wants it now. */
  async rebind(): Promise<void> {
    await this.halt(true);
    await this.ensureListening();
  }

  private async halt(closeListener: boolean): Promise<void> {
    // A restart the holds are waiting on survives the control surface stopping;
    // one a close owes goes now, even if that close only joins a stop under way.
    if (this.restartTimer && (closeListener || this.holds.size === 0)) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stopPromise) {
      await this.stopPromise;
      // The stop joined may have kept the listener, for a hold since gone or
      // against the close this call asks for: that close is still owed.
      if (this.isListening && (closeListener || (this.holdsOnly && this.holds.size === 0))) {
        await this.halt(closeListener);
      }
      return;
    }

    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
    this.restartAttempts = 0;
    this.intentionalStop = true;

    const promise: Promise<void> = (async () => {
      try {
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // start failed; no server to close
          }
        }

        const wasRunning = this.isRunning;
        // A hold keeps the listener open: from here it answers only held routes.
        const keepListener = !closeListener && this.holds.size > 0 && this.isListening;
        if (keepListener) this.holdsOnly = true;
        this.drainControl("MCP server stopped");

        if (!keepListener && this.httpServer) {
          const server = this.httpServer;
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
          this.holdsOnly = false;
          this.closeHeldRoutes();
        }

        this.lastError = null;

        console.log(
          keepListener
            ? "[MCP] Server stopped; the listener stays open for its holds"
            : "[MCP] Server stopped"
        );
        if (wasRunning) {
          this.deps.emitStatusChange();
        } else {
          this.deps.emitRuntimeStateChange();
        }
      } finally {
        this.intentionalStop = false;
      }
    })().finally(() => {
      // After the assignment below, for the reason {@link trackStart} gives.
      if (this.stopPromise === promise) this.stopPromise = null;
    });
    this.stopPromise = promise;
    return promise;
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

    // A feature's route answers whether or not the server is on (#15999), and
    // authenticates its own callers; it shares only the checks above.
    const held = this.heldRouteFor(url.pathname);
    if (held !== null && this.port !== null) {
      await held.route.handle(req, res, url, this.port);
      return;
    }
    // Held open for features alone, the listener serves nothing else. The
    // control surface and plugin routes answer as nothing there would, before
    // any credential is read, counted or matched to a session. A feature's
    // path with no hold on it (Decisions off) is not there either, whatever
    // the credential, so it never reaches the control surface's gate.
    if (this.holdsOnly || inHeldRouteNamespace(url.pathname)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Plugin endpoints authenticate their own credentials and nothing else, so
    // they branch off before the orchestration gate: a plugin grant must never
    // reach `isAuthorized`, whose fallback would score it as a core bearer.
    if (url.pathname.startsWith(PLUGIN_MCP_ROUTE_PREFIX)) {
      if (this.pluginRouteHandler && this.port !== null) {
        await this.pluginRouteHandler.handle(req, res, url, this.port);
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
      return;
    }

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
      // An agent pane's launch workspace (#12486) is resolved before any session
      // state is written, as the /mcp selector is, so an unexpected resolver
      // failure leaves nothing behind. This is the transport Claude panes use.
      const pin = this.resolveSessionPin(authHeader);
      const paneBinding = pin === null ? this.resolvePaneWorkspaceBinding(authHeader) : null;
      const workspaceBinding =
        paneBinding !== null ? this.describePaneWorkspaceBinding(paneBinding.workspaceId) : null;
      const ownershipPrincipal = this.resolveOwnershipPrincipal(authHeader);
      this.deps.sessionStore.sessionTierMap.set(sessionId, tier);
      this.deps.sessionStore.registerClientMetadata(
        sessionId,
        this.headerString(req.headers["user-agent"]),
        "sse"
      );
      this.deps.sessionStore.bindSessionCredential(sessionId, sessionCredentialDigest(authHeader));
      this.touchBearer(authHeader, resolveUserAgent(req), sessionId, tier);

      this.deps.sessionStore.sessionOriginMap.set(sessionId, pin?.origin ?? "external");
      if (ownershipPrincipal !== null) {
        this.deps.sessionStore.resourceOwnership.bindPrincipal(sessionId, ownershipPrincipal);
      }
      if (pin?.viewlessProjectId !== undefined) {
        this.deps.sessionStore.sessionViewlessHelpMap.set(sessionId, pin.viewlessProjectId);
      } else if (pin !== null) {
        this.deps.sessionStore.sessionWebContentsMap.set(sessionId, pin.webContentsId);
      }

      if (workspaceBinding !== null) {
        this.deps.sessionStore.sessionWorkspaceMap.set(sessionId, workspaceBinding.workspaceId);
      }

      const boundActionContext =
        this.resolveActionContext(authHeader) ?? paneBinding?.actionContext ?? null;
      if (boundActionContext !== null) {
        this.deps.sessionStore.sessionContextMap.set(sessionId, boundActionContext);
      }

      const helpSessionId = this.resolveHelpSessionId(authHeader);
      if (helpSessionId !== null) {
        this.deps.sessionStore.sessionHelpIdMap.set(sessionId, helpSessionId);
      }

      const deps = this.buildSessionServerDeps(
        sessionId,
        workspaceBinding ?? undefined,
        paneBinding ?? undefined,
        this.resolveOwnPane(authHeader, ownershipPrincipal)
      );
      const server = createSessionServer(sessionId, deps);

      const idleTimer = this.deps.sessionStore.armIdleTimer(
        sessionId,
        "sse",
        this.resolvePanePrincipal(authHeader)
      );
      this.deps.sessionStore.sessions.set(sessionId, { transport, server, idleTimer });
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      transport.onclose = () => {
        clearInterval(heartbeat);
        this.deps.sessionStore.retireSession(sessionId, "session-ended");
      };

      try {
        await server.connect(transport);
      } catch (err) {
        // Detached first so the close below doesn't retire the session twice.
        transport.onclose = undefined;
        this.deps.sessionStore.retireSession(sessionId, "session-ended");
        await transport.close().catch(() => {});
        throw err;
      }
      // A client that hung up while `connect` was in flight has already run
      // teardown; arming now would leak an interval against a dead stream.
      if (this.deps.sessionStore.sessions.get(sessionId)?.transport === transport) {
        heartbeat = startSseHeartbeat(res);
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

      // Only the bearer that opened the stream may post into it. Any other
      // valid bearer gets the same 404 an unknown id does, so the response
      // never confirms that a guessed or leaked id is live. The ownership
      // check runs whether or not the id resolved, so both answers do the
      // same work.
      const session = this.deps.sessionStore.sessions.get(sid);
      const owned = this.deps.sessionStore.isSessionCredential(
        sid,
        sessionCredentialDigest(authHeader)
      );
      if (session && owned) {
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
      // Ownership before anything that could tell the caller the session
      // exists — the selector checks below answer differently for a live
      // session, so they must never run for a bearer that did not create it.
      // DELETE is covered too: terminating someone else's session is the
      // cheapest thing a leaked id would otherwise buy. Evaluated for unknown
      // ids too, so both answers do the same work.
      const session = this.deps.sessionStore.httpSessions.get(sessionId);
      const owned = this.deps.sessionStore.isSessionCredential(
        sessionId,
        sessionCredentialDigest(req.headers.authorization ?? "")
      );
      if (!session || !owned) {
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
    // Looked up only without a selector. A pane bearer never gets here with
    // one — its tier refuses it above — so this only makes explicit that the
    // two sources of a binding can never both apply.
    const paneBinding =
      pin === null && selector === null ? this.resolvePaneWorkspaceBinding(authHeader) : null;
    const workspaceBinding =
      selector?.binding ??
      (paneBinding !== null ? this.describePaneWorkspaceBinding(paneBinding.workspaceId) : null);
    const ownershipPrincipal = this.resolveOwnershipPrincipal(authHeader);

    const newSessionId = randomUUID();
    this.deps.sessionStore.sessionTierMap.set(newSessionId, tier);
    this.deps.sessionStore.sessionOriginMap.set(newSessionId, origin);
    if (ownershipPrincipal !== null) {
      this.deps.sessionStore.resourceOwnership.bindPrincipal(newSessionId, ownershipPrincipal);
    }
    this.deps.sessionStore.registerClientMetadata(
      newSessionId,
      this.headerString(req.headers["user-agent"]),
      "streamable-http"
    );

    if (pin?.viewlessProjectId !== undefined) {
      this.deps.sessionStore.sessionViewlessHelpMap.set(newSessionId, pin.viewlessProjectId);
    } else if (pin !== null) {
      this.deps.sessionStore.sessionWebContentsMap.set(newSessionId, pin.webContentsId);
    }

    if (workspaceBinding !== null) {
      this.deps.sessionStore.sessionWorkspaceMap.set(newSessionId, workspaceBinding.workspaceId);
    }

    const boundActionContext =
      this.resolveActionContext(authHeader) ?? paneBinding?.actionContext ?? null;
    if (boundActionContext !== null) {
      this.deps.sessionStore.sessionContextMap.set(newSessionId, boundActionContext);
    }

    const helpSessionId = this.resolveHelpSessionId(authHeader);
    if (helpSessionId !== null) {
      this.deps.sessionStore.sessionHelpIdMap.set(newSessionId, helpSessionId);
    }

    const deps = this.buildSessionServerDeps(
      newSessionId,
      workspaceBinding ?? undefined,
      paneBinding ?? undefined,
      this.resolveOwnPane(authHeader, ownershipPrincipal)
    );
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
        // Bound before the session is filed in `httpSessions`, so there is no
        // instant at which the id is addressable without an owner on record.
        this.deps.sessionStore.bindSessionCredential(
          initializedSessionId,
          sessionCredentialDigest(authHeader)
        );
        // Resolved now, not with the rest of the handshake: a pane revoked
        // while this request was out closes only the sessions already filed,
        // so one filed after it falls back to the idle reaper.
        const idleTimer = this.deps.sessionStore.armIdleTimer(
          initializedSessionId,
          "streamable-http",
          this.resolvePanePrincipal(authHeader)
        );
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

    // Every route below retires `newSessionId`: the SDK mints exactly that id
    // through `sessionIdGenerator`, so it names the session whether or not
    // `onsessioninitialized` ever fired, and the rows written under it above
    // go with it either way.
    transport.onclose = () => {
      this.deps.sessionStore.retireSession(newSessionId, "session-ended");
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
      this.deps.sessionStore.retireSession(newSessionId, "session-ended");
    };

    const controlEpoch = this.controlEpoch;
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
      } else if (controlEpoch !== this.controlEpoch && transport.sessionId !== undefined) {
        // The server stopped while this handshake was out, filing it after the
        // drain. A hold kept the listener open, so it would otherwise live on.
        this.deps.sessionStore.revokeSession(transport.sessionId);
      } else if (
        pin !== null &&
        transport.sessionId !== undefined &&
        this.resolveSessionPin(authHeader)?.webContentsId !== pin.webContentsId
      ) {
        // The bearer's pin moved while this handshake was out — a view took
        // the assistant over (#13360), which retires the bearer's transports —
        // but this one only registered afterwards, still holding the pin it
        // resolved first. Retire it as well; the client reconnects onto the new pin.
        this.deps.sessionStore.revokeSession(transport.sessionId);
      }
    } catch (err) {
      console.error("[MCP] Streamable HTTP request failed:", err);
      this.deps.sessionStore.retireSession(newSessionId, "session-ended");
      await transport.close().catch(() => {});
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal server error");
      }
    }
  }

  /**
   * Admit a session for another machine's assistant reaching this host over
   * the link (#13493), through the same chain an HTTP handshake builds: its
   * tier, origin, owner and workspace binding, then the real session server,
   * on an in-memory transport. `external` origin, so it is never one of this
   * machine's assistant surfaces and never takes its assistant's confirmation
   * preference; bound to the one project, so nothing it does follows focus.
   * No bearer is involved: nothing an HTTP request presents can address it.
   * Null while the server isn't running.
   */
  async openRelaySession(spec: {
    tier: "core" | "full";
    workspaceId: string;
    caller: McpRelayCaller;
  }): Promise<McpRelaySessionHandle | null> {
    if (!this.isRunning) return null;
    const store = this.deps.sessionStore;
    const sessionId = randomUUID();
    const workspaceBinding = this.describePaneWorkspaceBinding(spec.workspaceId);
    store.sessionTierMap.set(sessionId, spec.tier);
    store.sessionOriginMap.set(sessionId, "external");
    store.resourceOwnership.bindPrincipal(
      sessionId,
      relayOwnershipPrincipal(spec.caller.senderId, spec.caller.helpSessionId)
    );
    store.sessionWorkspaceMap.set(sessionId, workspaceBinding.workspaceId);
    // When each call in flight here gives up (#15699), so what it waits on
    // ends first and nothing it approves runs after its caller was told no.
    const callDeadlines = new Map<string, { at: number }>();
    const caller: McpRelayCaller = {
      ...spec.caller,
      callDeadline: (callId) => callDeadlines.get(callId)?.at,
    };
    store.sessionRelayMap.set(sessionId, caller);
    // Held only here: no bearer this host ever saw digests to it.
    store.bindSessionCredential(
      sessionId,
      sessionCredentialDigest(`Relay ${randomBytes(32).toString("base64url")}`)
    );
    const server = createSessionServer(
      sessionId,
      this.buildSessionServerDeps(sessionId, workspaceBinding, undefined, null, caller)
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    store.relaySessions.set(sessionId, { transport: serverTransport, server });
    // Whichever side closes first, every map written above goes with it.
    serverTransport.onclose = () => {
      store.revokeSession(sessionId);
    };
    const client = new Client({ name: "daintree-host-call", version: app.getVersion() });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
    } catch (err) {
      store.revokeSession(sessionId);
      await client.close().catch(() => {});
      throw err;
    }
    return {
      sessionId,
      isOpen: () => store.relaySessions.has(sessionId),
      callTool: async (tool, args, { timeoutMs, callId }) => {
        const deadline = { at: Date.now() + timeoutMs };
        callDeadlines.set(callId, deadline);
        try {
          return (await client.callTool(
            { name: tool, arguments: args, _meta: { [RELAY_CALL_ID_META_KEY]: callId } },
            undefined,
            { timeout: timeoutMs }
          )) as CallToolResult;
        } finally {
          if (callDeadlines.get(callId) === deadline) callDeadlines.delete(callId);
        }
      },
      close: () => {
        store.revokeSession(sessionId);
        void client.close().catch(() => {});
      },
    };
  }

  /** One session's dispatch deps, from what its handshake settled: see {@link createSessionServerDeps}. */
  private buildSessionServerDeps(
    sessionId: string,
    workspaceBinding?: McpWorkspaceBinding,
    paneBinding?: PaneWorkspaceBinding,
    ownPane?: import("./terminalNotify.js").OwnPane | null,
    relay?: McpRelayCaller
  ): import("./sessionServer.js").SessionServerDeps {
    return createSessionServerDeps(this.deps, this.sessionDepsHost, {
      sessionId,
      workspaceBinding,
      paneBinding,
      ownPane,
      relay,
    });
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
    if (tier !== "core" && tier !== "full") {
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
    const order: McpTier[] = ["core", "full", "external"];
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
    // `armTierElevationTimer` keeps the baseline the first one captured, so a
    // chain of elevations still decays all the way to where it started. A stale
    // elevation therefore can't outlive the user's intent (#8462), which is
    // why the banner no longer labels this "always" (#12119). Each approval
    // refreshes the window from now; a chained re-elevation preserves the
    // original baseline.
    this.deps.sessionStore.armTierElevationTimer(sessionId, tier, current);
    // Positive audit trail for the elevation (#9151): records who elevated
    // (via the pinned session), the target tier, the pre-elevation tier, and
    // the bounded window. Only genuine elevations are logged — a same-tier
    // call (`newRank === currentRank`) arms no timer and changes nothing, so
    // recording a `core → core` row would be misleading noise.
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
   * The help lane a session serves, for a line on its notice line (#14995):
   * the help session it is bound to, the terminal running it now, and its
   * project. Null for any session that isn't a help lane's, or whose lane
   * has no terminal or project to type into.
   */
  helpLaneFor(
    sessionId: string
  ): { helpSessionId: string; terminalId: string; projectId: string } | null {
    const helpSessionId = this.deps.sessionStore.sessionHelpIdMap.get(sessionId);
    if (helpSessionId === undefined) return null;
    const terminalId = this.helpSessionTerminalResolver?.(helpSessionId) ?? null;
    const projectId = this.assistantControlBinding?.sessionProject(helpSessionId) ?? null;
    if (terminalId === null || projectId === null) return null;
    return { helpSessionId, terminalId, projectId };
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
   * Drop the one per-tool grant for the pair, leaving the session's other
   * grants alone. Caller-pin checked identically to {@link issueGrant}, but
   * with no grantability check: a grant that exists can always be ended, even
   * if the tool's policy changed since it was issued. `revoked` is false when
   * the grant was already gone.
   */
  revokeGrant(sessionId: string, toolId: string, callerWcId?: number): McpRevokeGrantResult {
    if (!sessionId || typeof sessionId !== "string") {
      throw new Error("Invalid sessionId");
    }
    if (!toolId || typeof toolId !== "string") {
      throw new Error("Invalid toolId");
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
    const revoked = this.deps.sessionStore.grantCache.revokeGrant(sessionId, toolId, "user");
    return { sessionId, toolId, revoked };
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
   * threshold. Caller-pin checked identically to {@link revokeGrant};
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
      port: this.currentPort,
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
      port: this.currentPort,
      apiKey: this.apiKey ?? null,
    }).snippet;
  }
}
