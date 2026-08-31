import nodeModule from "node:module";

import {
  buildCatalogService,
  FULL_CONTEXT,
  loadActionModules,
  type ActionModules,
} from "./actionDispatchFixture";

import type { ActionManifestEntry } from "../../../shared/types/actions";
import type { SessionServerDeps } from "../../../electron/services/mcp-server/sessionServer";
import type { SessionStore } from "../../../electron/services/mcp-server/sessionStore";
import type {
  DispatchEnvelope,
  McpSseSession,
  McpTier,
  McpWorkspaceBinding,
} from "../../../electron/services/mcp-server/shared";

/**
 * The REAL MCP session server for PERF-280..285, in a plain Node process.
 *
 * `ActionService`'s manifest is the tool surface of the local MCP server, so
 * every external agent that drives Daintree crosses `createSessionServer` and
 * the SDK request handlers behind it. PERF-203 prices the projection functions
 * in isolation; nothing drove the server, the handlers, the tier gate, dedup,
 * or the transport. These fixtures do.
 *
 * WHAT IS REAL
 *   - `electron/services/mcp-server/sessionServer.ts` — `createSessionServer`
 *     and every request handler it registers on a real `@modelcontextprotocol/sdk`
 *     `Server`: `tools/list`, `tools/call` with its whole gate chain (session
 *     liveness, tier floor, per-tool and native grants, the workspace-bound
 *     confirmation ceiling, the ownership ledger, dedup singleflight and TTL
 *     replay, introspection narrowing, result and audit assembly), plus the
 *     resource and prompt handlers.
 *   - The real `SessionStore`, its real `GrantCache` and its real
 *     `ResourceOwnershipLedger`. Sessions are seeded into `sessions` /
 *     `sessionTierMap` directly, which is what the product's own tests do —
 *     the handshake that normally writes them lives in `httpLifecycle`.
 *   - The real `AbusePolicy`, driven to a trip so revocation is observed
 *     rather than asserted.
 *   - `tierAuth.ts` and `shared.ts` unmodified: `TIER_ALLOWLISTS`,
 *     `shouldExposeTool`, `isWithheldFromBoundSession`, `parseToolArguments`,
 *     `buildStructuredContent`, `buildToolError`, `MCP_SERVER_INSTRUCTIONS`.
 *   - The real MCP SDK on both ends. A real `Client` completes a real
 *     `initialize` handshake over `InMemoryTransport`, and the client's own
 *     AJV pass over `structuredContent` against each advertised `outputSchema`
 *     runs — so a server whose result stops matching its own contract is
 *     caught by the client, not by an assertion this fixture wrote.
 *   - The action manifest is the real one: `actionDispatchFixture` builds the
 *     shipped ~495-definition catalog in a real `ActionService` and this reads
 *     `service.list()` off it. The zod→JSON-Schema compile is therefore paid
 *     once at fixture load — PERF-203 owns that cold number, and these
 *     scenarios measure the server and transport on top of a warm manifest.
 *
 * WHAT IS NOT, AND CANNOT BE
 *   - **No Electron.** The bare `electron` specifier is remapped to an inert
 *     stub, so `app.getVersion()` answers a fixed string and nothing else on
 *     the measured paths reaches Chromium.
 *   - **No renderer, so `dispatchAction` is a stand-in.** In production every
 *     dispatch crosses `rendererBridge` into a `WebContents` and runs the
 *     action's `run()` body. Here it is a counting stand-in that records what
 *     the server forwarded and answers with a minimal instance of the action's
 *     own advertised `outputSchema`. Everything before and after it — argument
 *     parsing, authorization, dedup, ownership, result assembly, client-side
 *     schema validation — is real; the dispatch leg itself is not, and no
 *     `run()` body executes. Renderer-side failure modes (`McpRouteBindingError`,
 *     `RendererBridgeUnavailableError`, the 30s dispatch wall, the native
 *     confirmation dialog) are consequently out of frame.
 *   - **No HTTP.** `httpLifecycle.ts` — bearer auth, WebContents pinning,
 *     Streamable-HTTP and SSE transports, port binding, the readiness probe —
 *     is entirely outside this harness. Nothing here binds a socket. The
 *     transport is the SDK's `InMemoryTransport`, which passes JSON-RPC objects
 *     without serializing them, so the reported wire bytes are the messages
 *     `JSON.stringify`d by this fixture at the send seam: exactly what an HTTP
 *     or SSE transport would put on the wire, minus its framing headers.
 *   - **No audit log.** `appendAuditRecord` is a collector, so the audit
 *     records are read as evidence of what the server decided, not as a
 *     measurement of `auditLog.ts`'s own write cost.
 *   - **No plugins**, for the same reason `actionDispatchFixture` has none, so
 *     the tool surface is the built-in floor.
 */

const ELECTRON_STUB_SOURCE = `
const noop = () => undefined;
export const app = {
  getVersion: () => "0.0.0-perf",
  getName: () => "Daintree",
  getPath: () => "/tmp/daintree-perf",
  isPackaged: false,
  on: noop,
  whenReady: () => Promise.resolve(),
};
export const powerMonitor = { on: noop, addListener: noop, removeListener: noop };
export const ipcMain = { on: noop, handle: noop, removeHandler: noop };
export const BrowserWindow = class { static getAllWindows() { return []; } };
export const webContents = { getAllWebContents: () => [], fromId: () => null };
export const shell = { openExternal: noop };
export const dialog = {};
export const session = {};
export const net = {};
export const nativeTheme = { on: noop };
export const utilityProcess = { fork: noop };
export const safeStorage = { isEncryptionAvailable: () => false };
export default { app, ipcMain, BrowserWindow, webContents, shell, powerMonitor };
`;

const ELECTRON_STUB_URL = `data:text/javascript,${encodeURIComponent(ELECTRON_STUB_SOURCE)}`;

const ELECTRON_HOOKS_SOURCE = `
const STUB_URL = ${JSON.stringify(ELECTRON_STUB_URL)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") return { url: STUB_URL, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;

/** The same stand-in, as a module object, for `vi.mock("electron", ...)`. */
export const perfMcpElectronStub = {
  app: {
    getVersion: () => "0.0.0-perf",
    getName: () => "Daintree",
    getPath: () => "/tmp/daintree-perf",
    isPackaged: false,
    on: () => undefined,
    whenReady: () => Promise.resolve(),
  },
  powerMonitor: {
    on: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
  },
  ipcMain: { on: () => undefined, handle: () => undefined, removeHandler: () => undefined },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  webContents: { getAllWebContents: () => [], fromId: () => null },
  shell: { openExternal: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
};

let hooksInstalled = false;

/**
 * Remap the bare `electron` specifier so the main-process MCP graph loads
 * outside Electron. `module.registerHooks` is synchronous and in-thread but
 * landed in Node 22.15, and `.nvmrc` pins 22.13, so `module.register` is the
 * fallback. Under Vitest neither fires — Vite resolves imports itself — so the
 * test hands {@link perfMcpElectronStub} to `vi.mock` instead.
 */
function installElectronStub(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  if (process.env.VITEST) return;

  const registerHooks = (
    nodeModule as unknown as {
      registerHooks?: (hooks: {
        resolve: (
          specifier: string,
          context: unknown,
          next: (s: string, c: unknown) => unknown
        ) => unknown;
      }) => void;
    }
  ).registerHooks;

  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "electron") return { url: ELECTRON_STUB_URL, shortCircuit: true };
        return nextResolve(specifier, context);
      },
    });
    return;
  }

  nodeModule.register(`data:text/javascript,${encodeURIComponent(ELECTRON_HOOKS_SOURCE)}`);
}

// --- Product and SDK modules -------------------------------------------------

/** The MCP tiers, in the order every report renders them. */
export const MCP_TIERS: readonly McpTier[] = ["workbench", "action", "system", "external"];

type JsonRpcMessage = Record<string, unknown>;

interface TransportLike {
  send: (message: JsonRpcMessage, options?: unknown) => Promise<void>;
  close: () => Promise<void>;
}

interface ClientLike {
  connect: (transport: TransportLike) => Promise<void>;
  close: () => Promise<void>;
  getInstructions: () => string | undefined;
  getServerCapabilities: () =>
    | {
        tools?: { listChanged?: boolean };
        resources?: { subscribe?: boolean; listChanged?: boolean };
        prompts?: Record<string, unknown>;
        experimental?: Record<string, unknown>;
      }
    | undefined;
  listTools: () => Promise<{ tools: ListedTool[] }>;
  callTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<CallToolResponse>;
  listPrompts: () => Promise<{ prompts: Array<{ name: string }> }>;
  readResource: (params: { uri: string }) => Promise<unknown>;
}

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface CallToolResponse {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ServerLike {
  connect: (transport: TransportLike) => Promise<void>;
  close: () => Promise<void>;
  getClientCapabilities: () => unknown;
}

export interface McpModules {
  createSessionServer: (sessionId: string, deps: SessionServerDeps) => ServerLike;
  SessionStore: new (cleanupResourceSubscriptions: (sessionId: string) => void) => SessionStore;
  AbusePolicy: new (config: {
    readConfig: () => {
      auditEnabled: boolean;
      abusePolicyEnabled: boolean;
      abusePolicyMaxDenials: number;
      abusePolicyWindowMs: number;
    };
  }) => {
    recordDenial: (sessionId: string, kind: "auth401" | "tierMismatch") => { tripped: boolean };
  };
  MCP_SERVER_INSTRUCTIONS: string;
  MCP_DEDUP_ALLOWLIST: ReadonlySet<string>;
  MCP_DEDUP_KEY_COLLISION_CODE: string;
  TIER_NOT_PERMITTED_CODE: string;
  CONFIRMATION_REQUIRED_CODE: string;
  RESOURCE_NOT_OWNED_CODE: string;
  INVALID_URL_CODE: string;
  SESSION_GONE: string;
  WORKSPACE_BINDING_CAPABILITY_KEY: string;
  Client: new (
    info: { name: string; version: string },
    options: { capabilities: object }
  ) => ClientLike;
  createLinkedPair: () => [TransportLike, TransportLike];
}

let modulesPromise: Promise<McpModules> | null = null;

export function loadMcpModules(): Promise<McpModules> {
  modulesPromise ??= (async () => {
    installElectronStub();
    const [sessionServer, sessionStore, abusePolicy, shared, clientMod, inMemory] =
      await Promise.all([
        import("../../../electron/services/mcp-server/sessionServer"),
        import("../../../electron/services/mcp-server/sessionStore"),
        import("../../../electron/services/mcp-server/abusePolicy"),
        import("../../../electron/services/mcp-server/shared"),
        import("@modelcontextprotocol/sdk/client/index.js"),
        import("@modelcontextprotocol/sdk/inMemory.js"),
      ]);
    return {
      createSessionServer:
        sessionServer.createSessionServer as unknown as McpModules["createSessionServer"],
      SessionStore: sessionStore.SessionStore as unknown as McpModules["SessionStore"],
      AbusePolicy: abusePolicy.AbusePolicy as unknown as McpModules["AbusePolicy"],
      MCP_SERVER_INSTRUCTIONS: shared.MCP_SERVER_INSTRUCTIONS,
      MCP_DEDUP_ALLOWLIST: shared.MCP_DEDUP_ALLOWLIST,
      MCP_DEDUP_KEY_COLLISION_CODE: shared.MCP_DEDUP_KEY_COLLISION_CODE,
      TIER_NOT_PERMITTED_CODE: shared.TIER_NOT_PERMITTED_CODE,
      CONFIRMATION_REQUIRED_CODE: shared.CONFIRMATION_REQUIRED_CODE,
      RESOURCE_NOT_OWNED_CODE: shared.RESOURCE_NOT_OWNED_CODE,
      INVALID_URL_CODE: shared.INVALID_URL_CODE,
      SESSION_GONE: shared.SESSION_GONE,
      WORKSPACE_BINDING_CAPABILITY_KEY: shared.WORKSPACE_BINDING_CAPABILITY_KEY,
      Client: clientMod.Client as unknown as McpModules["Client"],
      createLinkedPair: () =>
        inMemory.InMemoryTransport.createLinkedPair() as unknown as [TransportLike, TransportLike],
    };
  })();
  return modulesPromise;
}

// --- The real action manifest ------------------------------------------------

export interface ManifestBundle {
  /** The shipped catalog as the MCP server receives it from the renderer. */
  entries: ActionManifestEntry[];
  byId: Map<string, ActionManifestEntry>;
  /** The tier projection helpers, so a scenario can re-derive an oracle. */
  actionModules: ActionModules;
}

let manifestPromise: Promise<ManifestBundle> | null = null;

/**
 * The real manifest, built once per process.
 *
 * Cached deliberately: the zod→JSON-Schema compile it pays is PERF-203's
 * headline, and re-paying it per iteration would fold that number into every
 * server measurement here.
 */
export function loadRealManifest(): Promise<ManifestBundle> {
  manifestPromise ??= (async () => {
    const actionModules = await loadActionModules();
    const catalog = buildCatalogService(actionModules);
    // `ActionService.list()` produces `ActionManifestEntry` values;
    // `actionDispatchFixture` types them structurally so its own bundle stays
    // the authority. One cast at the boundary rather than a parallel type.
    const entries = catalog.service.list(FULL_CONTEXT) as unknown as ActionManifestEntry[];
    return {
      entries,
      byId: new Map(entries.map((entry) => [entry.id, entry])),
      actionModules,
    };
  })();
  return manifestPromise;
}

// --- Minimal instances of an advertised output schema ------------------------

/**
 * Build the smallest value that satisfies a JSON Schema's `required` set.
 *
 * The stand-in dispatcher answers with this, which is what makes the MCP
 * client's AJV pass load-bearing: the schema the server advertised in
 * `tools/list` is the schema the client validates the reply against, so a
 * projection that stops describing what the server returns is caught on the
 * client side rather than by anything written here.
 *
 * Only the `required` properties are emitted. An omitted optional property is
 * valid under any schema, while an extra one is rejected by a schema that
 * closes itself — so the minimum is the only instance valid under both.
 */
export function instantiateSchema(schema: unknown, depth = 0): unknown {
  if (depth > 8 || !schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const node = schema as Record<string, unknown>;
  if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
  if (node.const !== undefined) return node.const;
  const union = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
  if (Array.isArray(union) && union.length > 0) return instantiateSchema(union[0], depth + 1);
  const declared = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (declared) {
    case "object": {
      const out: Record<string, unknown> = {};
      const properties = (node.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(node.required) ? (node.required as string[]) : [];
      for (const key of required) {
        out[key] = key in properties ? instantiateSchema(properties[key], depth + 1) : null;
      }
      return out;
    }
    case "array":
      return [];
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return {};
  }
}

// --- Harness -----------------------------------------------------------------

export interface DispatchRecord {
  actionId: string;
  args: unknown;
  confirmed: boolean | undefined;
}

export interface AuditRecord {
  toolId: string;
  tier: string;
  outcomeKind: string;
}

export interface SessionOptions {
  tier: McpTier;
  sessionId?: string;
  workspaceBinding?: McpWorkspaceBinding;
  /** Share one store across sessions, for the concurrent-fanout scenario. */
  store?: SessionStore;
  /** Wire the real AbusePolicy with this denial ceiling. Omitted = no policy. */
  abuseMaxDenials?: number;
  /**
   * Seed `sessionHelpIdMap`, making this one of Daintree's own assistant
   * surfaces. `help.displayImage` refuses any session without one.
   */
  helpSessionId?: string;
}

export interface McpSession {
  sessionId: string;
  store: SessionStore;
  server: ServerLike;
  client: ClientLike;
  /** JSON-RPC bytes the server emitted, serialized at the send seam. */
  serverOutBytes: number;
  /** JSON-RPC bytes the client emitted. */
  clientOutBytes: number;
  connectMs: number;
  dispatches: DispatchRecord[];
  audits: AuditRecord[];
  /** True once the abuse policy tripped and the store revoked the session. */
  revokedByPolicy: boolean;
  revoke: () => void;
  /** Bytes emitted by the server while `body` ran. */
  measureServerBytes: <T>(body: () => Promise<T>) => Promise<{ value: T; bytes: number }>;
  close: () => Promise<void>;
}

let sessionSeq = 0;

/**
 * A live session: real `SessionStore` row, real `createSessionServer`, real SDK
 * `Client`, connected over a linked in-memory transport pair.
 *
 * The store row is written directly into `sessions` / `sessionTierMap` because
 * `getTier` gates on transport membership and the handshake that normally
 * writes them lives in `httpLifecycle`, which cannot run here. This is the same
 * seeding the product's own `sessionServer` tests use.
 */
export async function openSession(
  mods: McpModules,
  manifest: ManifestBundle,
  options: SessionOptions
): Promise<McpSession> {
  const sessionId = options.sessionId ?? `perf-mcp-${++sessionSeq}`;
  const store = options.store ?? new mods.SessionStore(() => {});

  const idleTimer = setTimeout(() => {}, 1_000_000);
  idleTimer.unref?.();
  store.sessions.set(sessionId, {
    transport: { close: async () => {} },
    server: { sendToolListChanged: async () => {} },
    idleTimer,
  } as unknown as McpSseSession);
  store.sessionTierMap.set(sessionId, options.tier);
  if (options.helpSessionId !== undefined) {
    store.sessionHelpIdMap.set(sessionId, options.helpSessionId);
  }

  const dispatches: DispatchRecord[] = [];
  const audits: AuditRecord[] = [];
  const state = { revokedByPolicy: false };

  /**
   * Answer a dispatch with a minimal instance of the action's own advertised
   * output schema, plus the two fields the ownership ledger reads. Both extras
   * are only added where the action's real result carries them, so the client's
   * schema validation still governs the shape.
   */
  const respond = (actionId: string, args: unknown): DispatchEnvelope => {
    const entry = manifest.byId.get(actionId);
    const result = (instantiateSchema(entry?.outputSchema) ?? {}) as Record<string, unknown>;
    if (actionId === "terminal.new" || actionId === "agent.launch") {
      result.terminalId = `perf-terminal-${dispatches.length}`;
    }
    if (actionId === "terminal.close") {
      const requested = (args as { terminalId?: unknown } | undefined)?.terminalId;
      if (typeof requested === "string") result.closedIds = [requested];
    }
    return { result: { ok: true, result } };
  };

  const abusePolicy =
    options.abuseMaxDenials === undefined
      ? null
      : new mods.AbusePolicy({
          readConfig: () => ({
            auditEnabled: true,
            abusePolicyEnabled: true,
            abusePolicyMaxDenials: options.abuseMaxDenials!,
            abusePolicyWindowMs: 60_000,
          }),
        });

  const deps: SessionServerDeps = {
    sessionStore: store,
    ...(options.workspaceBinding ? { workspaceBinding: options.workspaceBinding } : {}),
    requestManifest: async () => manifest.entries,
    dispatchAction: async (actionId, args, confirmed) => {
      dispatches.push({ actionId, args, confirmed });
      return respond(actionId, args);
    },
    handleWaitUntilIdle: async () =>
      instantiateSchema(manifest.byId.get("terminal.waitUntilIdle")?.outputSchema) as never,
    handleWaitUntilIdleBatch: async () =>
      instantiateSchema(manifest.byId.get("terminal.waitUntilIdleBatch")?.outputSchema) as never,
    handleSkillsSearch: () =>
      instantiateSchema(manifest.byId.get("skills.search")?.outputSchema) as never,
    handleSkillsLoad: () =>
      instantiateSchema(manifest.byId.get("skills.load")?.outputSchema) as never,
    handleProjectRunCheck: async () =>
      instantiateSchema(manifest.byId.get("project.runCheck")?.outputSchema) as never,
    appendAuditRecord: (input) => {
      audits.push({ toolId: input.toolId, tier: input.tier, outcomeKind: input.outcome.kind });
    },
    getCachedManifest: () => manifest.entries,
    ...(abusePolicy
      ? {
          recordDenial: (id: string, kind: "auth401" | "tierMismatch") =>
            abusePolicy.recordDenial(id, kind),
          notifySessionRevoked: () => {
            state.revokedByPolicy = true;
          },
        }
      : {}),
  };

  const server = mods.createSessionServer(sessionId, deps);
  const [clientTransport, serverTransport] = mods.createLinkedPair();

  const counters = { serverOut: 0, clientOut: 0 };
  // InMemoryTransport hands objects across without serializing, so the bytes an
  // HTTP or SSE transport would actually put on the wire are measured here, at
  // the send seam, rather than inferred from the projection.
  const serverSend = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, sendOptions) => {
    counters.serverOut += Buffer.byteLength(JSON.stringify(message), "utf8");
    return serverSend(message, sendOptions);
  };
  const clientSend = clientTransport.send.bind(clientTransport);
  clientTransport.send = async (message, sendOptions) => {
    counters.clientOut += Buffer.byteLength(JSON.stringify(message), "utf8");
    return clientSend(message, sendOptions);
  };

  const client = new mods.Client({ name: "daintree-perf", version: "1.0.0" }, { capabilities: {} });
  const connectStart = performance.now();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const connectMs = performance.now() - connectStart;

  const session: McpSession = {
    sessionId,
    store,
    server,
    client,
    get serverOutBytes() {
      return counters.serverOut;
    },
    get clientOutBytes() {
      return counters.clientOut;
    },
    connectMs,
    dispatches,
    audits,
    get revokedByPolicy() {
      return state.revokedByPolicy;
    },
    revoke: () => {
      store.revokeSession(sessionId);
    },
    measureServerBytes: async (body) => {
      const before = counters.serverOut;
      const value = await body();
      return { value, bytes: counters.serverOut - before };
    },
    close: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      clearTimeout(idleTimer);
      if (options.store === undefined) {
        store.drain();
        store.grantCache.dispose();
      }
    },
  };
  return session;
}

/** Tear down a store the caller created for a multi-session scenario. */
export function disposeStore(store: SessionStore): void {
  store.drain();
  store.grantCache.dispose();
}

// --- Reading a tool result ---------------------------------------------------

/**
 * The `code` a refused tool call carries.
 *
 * `buildToolError` puts a JSON envelope in the first text block, so this is
 * what a client actually has to parse to tell a tier refusal from a
 * confirmation ceiling. Returns null for a successful call.
 */
export function readToolErrorCode(result: CallToolResponse): string | null {
  if (result.isError !== true) return null;
  const first = result.content?.[0];
  if (!first || typeof first.text !== "string") return "UNPARSEABLE";
  try {
    const payload = JSON.parse(first.text) as { code?: unknown };
    return typeof payload.code === "string" ? payload.code : "UNPARSEABLE";
  } catch {
    return "UNPARSEABLE";
  }
}

/**
 * The action's own result payload, from wherever the server put it.
 *
 * A tool that advertises an `outputSchema` gets a `structuredContent` block;
 * one that does not carries the same JSON as text. Both are the action's
 * result, and a caller reading a created resource's id has to handle each.
 */
export function readResultPayload(result: CallToolResponse): Record<string, unknown> {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const first = result.content?.[0];
  if (!first || typeof first.text !== "string") return {};
  try {
    const parsed = JSON.parse(first.text) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Outcome of one graded call: what happened, without deciding whether it should have. */
export interface CallOutcome {
  toolId: string;
  ok: boolean;
  /** Refusal code, or `THREW:<message>` when the SDK rejected the response. */
  code: string | null;
  hasStructuredContent: boolean;
}

export async function probeCall(
  session: McpSession,
  toolId: string,
  args: Record<string, unknown> = {}
): Promise<CallOutcome> {
  try {
    const result = await session.client.callTool({ name: toolId, arguments: args });
    return {
      toolId,
      ok: result.isError !== true,
      code: readToolErrorCode(result),
      hasStructuredContent: result.structuredContent !== undefined,
    };
  } catch (err) {
    // A throw is either an `McpError` the handler raised or the client's own
    // AJV rejection of `structuredContent`. Both are refusals from the caller's
    // point of view, and the message is what separates them.
    return {
      toolId,
      ok: false,
      code: `THREW:${err instanceof Error ? err.message : String(err)}`,
      hasStructuredContent: false,
    };
  }
}

// --- Expected surfaces -------------------------------------------------------

/**
 * The tool ids a tier must advertise, re-derived from the tier allowlist and
 * the manifest's own fields.
 *
 * Deliberately never routed through `shouldExposeTool` — that is the function
 * under test, and an oracle that calls it can only ever agree with it. The tier
 * allowlist itself is shared, because it is the specification rather than the
 * implementation: what is re-derived here is the exposure RULE.
 */
export function expectedExposedIds(
  manifest: ManifestBundle,
  tier: McpTier,
  workspaceBound: boolean
): Set<string> {
  const permitted = manifest.actionModules.getTierPermittedActionIds(tier);
  const ids = new Set<string>();
  for (const entry of manifest.entries) {
    if (!permitted.has(entry.id)) continue;
    if (entry.danger === "restricted") continue;
    if (entry.mcpVisibility === "hidden") continue;
    if (workspaceBound && tier === "external" && entry.danger === "confirm") continue;
    ids.add(entry.id);
  }
  return ids;
}

/**
 * A deterministic sample of tools a tier permits and a session may actually
 * call: no confirmation gate (which needs a human in a renderer) and none of
 * the {@link SELF_GATED_TOOLS}, each of which is graded on its own terms.
 */
export function permittedCallSample(
  manifest: ManifestBundle,
  tier: McpTier,
  size: number
): string[] {
  const permitted = manifest.actionModules.getTierPermittedActionIds(tier);
  return manifest.entries
    .filter(
      (entry) =>
        permitted.has(entry.id) &&
        entry.danger !== "confirm" &&
        entry.danger !== "restricted" &&
        entry.mcpVisibility !== "hidden" &&
        !SELF_GATED_TOOLS.has(entry.id)
    )
    .map((entry) => entry.id)
    .sort()
    .slice(0, size);
}

/** A deterministic sample of tools the tier allowlist withholds. */
export function forbiddenCallSample(
  manifest: ManifestBundle,
  tier: McpTier,
  size: number
): string[] {
  const permitted = manifest.actionModules.getTierPermittedActionIds(tier);
  return manifest.entries
    .filter((entry) => !permitted.has(entry.id))
    .map((entry) => entry.id)
    .sort()
    .slice(0, size);
}

/**
 * Tools that refuse a call for a reason of their own, before the tier gate has
 * anything to say: the two `*Owned` cleanups check the ownership ledger, and
 * `help.displayImage` requires a help-session binding. None belongs in a
 * battery whose oracle is "every permitted call is admitted" — PERF-283 grades
 * all three in both directions instead.
 */
export const SELF_GATED_TOOLS: ReadonlySet<string> = new Set([
  "terminal.closeOwned",
  "worktree.deleteOwned",
  "help.displayImage",
]);

/** The workspace a bound session is pinned to in these scenarios. */
export const PERF_WORKSPACE_BINDING: McpWorkspaceBinding = {
  kind: "project",
  workspaceId: "perf-workspace",
  workspacePath: "/tmp/daintree-perf/project",
};
