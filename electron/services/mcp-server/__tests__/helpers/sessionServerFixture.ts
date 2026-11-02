import { vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ActionManifestEntry, ActionId } from "../../../../../shared/types/actions.js";
import type { createSessionServer, SessionServerDeps } from "../../sessionServer.js";
import type { SessionStore, SessionStore as RealSessionStore } from "../../sessionStore.js";
import { GrantCache } from "../../grantCache.js";
import { ResourceOwnershipLedger } from "../../resourceOwnership.js";
import { MCP_EXTERNAL_BASE_MANIFEST } from "../../generated/mcpExternalBaseManifest.js";

/**
 * Derived from the shipped artifact rather than listed, so the day a tool in
 * the external tier gains or loses `danger: "confirm"` the expectations below
 * move with it instead of asserting a stale pair of ids.
 */
export const CONFIRM_GATED_EXTERNAL_TOOLS = new Set(
  MCP_EXTERNAL_BASE_MANIFEST.filter((entry) => entry.danger === "confirm").map((entry) => entry.id)
);

/**
 * The parts of a listed tool the #12082 assertions read. The shared `listTools`
 * helper narrows to `{ name }`, which is all its older callers need.
 */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown> };
  outputSchema?: Record<string, unknown>;
}

export async function listBaseTools(
  server: ReturnType<typeof createSessionServer>
): Promise<ListedTool[]> {
  return ((await listTools(server)) as unknown as { tools: ListedTool[] }).tools;
}

/** Drive any registered request handler directly, the way `listTools` does. */
export function callHandler(
  server: ReturnType<typeof createSessionServer>,
  method: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const handlers = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const handler = handlers.get(method);
  if (!handler) throw new Error(`${method} handler not found`);
  return handler(
    { method, params, jsonrpc: "2.0", id: 1 },
    {
      signal: new AbortController().signal,
      _meta: {},
      sendNotification: vi.fn(),
      requestId: 1,
    }
  );
}

/** The structured error envelope a failed tool call carries in its text content. */
export function toolErrorPayload(result: { content: unknown }): {
  code: string;
  message: string;
  retriable: boolean;
} {
  const [first] = result.content as Array<{ text: string }>;
  return JSON.parse(first.text) as { code: string; message: string; retriable: boolean };
}

export function fakeSessionStore(tier: "core" | "full" | "external" = "core"): SessionStore {
  // Real GrantCache instance with sweeping disabled — tests drive lazy
  // eviction via the optional `now` clock when they need to assert
  // expiry, and they call dispose() at teardown.
  const grantCache = new GrantCache({ sweepIntervalMs: 0 });
  // Derived from `sessionOriginMap` exactly as the real store derives it, so a
  // test that seeds an origin gets the grant-eligibility answer the shipped
  // code would give rather than a hard-coded one (#11910).
  const sessionOriginMap = new Map<string, string>();
  const store = {
    sessions: new Map(),
    httpSessions: new Map(),
    sessionTierMap: new Map(),
    sessionWebContentsMap: new Map(),
    sessionOriginMap,
    getOrigin: vi.fn((sessionId: string) => sessionOriginMap.get(sessionId) ?? "external"),
    isRendererOwnedOrigin: vi.fn(
      (sessionId: string) => (sessionOriginMap.get(sessionId) ?? "external") === "help"
    ),
    sessionWorkspaceMap: new Map(),
    sessionViewlessHelpMap: new Map(),
    resourceSubscriptions: new Map(),
    dedupInFlight: new Map(),
    dedupResultCache: new Map(),
    grantCache,
    // A real ledger rather than a stub: it is plain in-memory Maps with no
    // timers, and the recording hook runs on every dispatch, so a mock here
    // would make the ownership assertions in this file vacuous (#11909).
    resourceOwnership: new ResourceOwnershipLedger(),
    drain: vi.fn(),
    getTier: vi.fn(() => tier),
    createIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
    createHttpIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
    resetIdleTimer: vi.fn(),
    resetHttpIdleTimer: vi.fn(),
    clearDedupState: vi.fn(),
    // The real predicate over this fixture's own maps.
    hasLiveTransport: (sessionId: string) =>
      store.sessions.has(sessionId) || store.httpSessions.has(sessionId),
  } as unknown as SessionStore;
  return store;
}

export function fakeDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
  return {
    sessionStore: fakeSessionStore(),
    requestManifest: vi.fn().mockResolvedValue([]),
    dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: null } }),
    handleWaitUntilIdle: vi.fn(),
    handleWaitUntilIdleBatch: vi.fn(),
    handleSkillsSearch: vi.fn(() => ({ skills: [] })),
    handleSkillsLoad: vi.fn(),
    handleProjectRunCheck: vi.fn(),
    handleProjectRunCommand: vi.fn(),
    handleTerminalGetStatusViewless: vi
      .fn()
      .mockResolvedValue({ terminals: [], source: "pty", unavailableFields: [] }),
    handleTerminalReadLastMessageOwned: vi
      .fn()
      .mockResolvedValue({ status: "unavailable", reason: "no-message" }),
    isTerminalIdInUse: vi.fn(() => false),
    // A host with nothing running, so an owned worktree delete reaches its
    // dispatch unless a test says otherwise (#15729).
    readTerminalProcesses: vi.fn().mockResolvedValue([]),
    appendAuditRecord: vi.fn(),
    getCachedManifest: vi.fn(() => null),
    ...overrides,
  };
}

export function makeMockTransport(): Transport {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,
  };
}

/**
 * Invoke the prompts/get handler through the SDK's handler wrapper (which
 * includes Zod validation via parseWithCompat). This matches real request flow.
 */
export async function getPrompt(
  server: ReturnType<typeof createSessionServer>,
  params: { name: string; arguments?: Record<string, unknown> }
) {
  const handlers = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const handler = handlers.get("prompts/get");
  if (!handler) throw new Error("prompts/get handler not found");
  return handler(
    {
      method: "prompts/get",
      params,
      jsonrpc: "2.0",
      id: 1,
    },
    {
      signal: new AbortController().signal,
      _meta: {},
      sendNotification: vi.fn(),
      requestId: 1,
    }
  );
}

export async function listPrompts(server: ReturnType<typeof createSessionServer>) {
  const handlers = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const handler = handlers.get("prompts/list");
  if (!handler) throw new Error("prompts/list handler not found");
  return handler(
    {
      method: "prompts/list",
      params: {},
      jsonrpc: "2.0",
      id: 1,
    },
    {
      signal: new AbortController().signal,
      _meta: {},
      sendNotification: vi.fn(),
      requestId: 1,
    }
  );
}

/**
 * Invoke the tools/call handler directly (skips SDK Zod validation since
 * the SDK's CallToolRequestSchema validates only the outer request shape,
 * and our tier/dedup logic operates after that).
 */
export async function callTool(
  server: ReturnType<typeof createSessionServer>,
  params: { name: string; arguments?: Record<string, unknown> }
) {
  const handlers = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const handler = handlers.get("tools/call");
  if (!handler) throw new Error("tools/call handler not found");
  return handler(
    {
      method: "tools/call",
      params,
      jsonrpc: "2.0",
      id: 1,
    },
    {
      signal: new AbortController().signal,
      _meta: {},
      sendNotification: vi.fn(),
      requestId: 1,
    }
  ) as Promise<{ content: unknown; isError?: boolean; structuredContent?: unknown }>;
}

export async function listTools(server: ReturnType<typeof createSessionServer>) {
  const handlers = (
    server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const handler = handlers.get("tools/list");
  if (!handler) throw new Error("tools/list handler not found");
  return handler(
    {
      method: "tools/list",
      params: {},
      jsonrpc: "2.0",
      id: 1,
    },
    {
      signal: new AbortController().signal,
      _meta: {},
      sendNotification: vi.fn(),
      requestId: 1,
    }
  ) as Promise<{ tools: Array<{ name: string }> }>;
}

/**
 * Complete a real MCP handshake against the session server and return what the
 * client received (#11541).
 *
 * Deliberately the public path rather than this file's `_requestHandlers` idiom:
 * `initialize` is the SDK's own handler, not one we register, so the question
 * is whether the constructor option survives all the way to a client. Invoking
 * the handler directly would stay green if the SDK stopped forwarding the field
 * on the way to the transport, which is the failure actually worth catching.
 */
export async function initializeClient(server: ReturnType<typeof createSessionServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return client.getInstructions();
  } finally {
    await client.close();
  }
}

/**
 * Register a live SSE transport plus its tier row on a real `SessionStore`.
 *
 * `getTier` gates on transport membership (#11799), so seeding `sessionTierMap`
 * alone no longer produces a session any request handler will serve — a real
 * store needs the transport too.
 */
export function seedLiveSession(
  store: RealSessionStore,
  sessionId: string,
  tier: "core" | "full" | "external",
  transport: "sse" | "http" = "sse"
): void {
  // Unref'd because the store's own `clearTimeout` is reachable only through
  // the map entry: a test that drops the entry directly — to orphan a tier row,
  // say — loses the only handle, and a referenced 1,000,000 ms timer then holds
  // the Vitest worker open past the suite.
  const idleTimer = setTimeout(() => {}, 1_000_000);
  idleTimer.unref?.();
  const entry = {
    transport: {
      close: vi.fn().mockResolvedValue(undefined),
    },
    server: {
      sendToolListChanged: vi.fn().mockResolvedValue(undefined),
    },
    idleTimer,
  } as unknown as NonNullable<ReturnType<RealSessionStore["sessions"]["get"]>>;
  if (transport === "sse") {
    store.sessions.set(sessionId, entry);
  } else {
    store.httpSessions.set(sessionId, entry as never);
  }
  store.sessionTierMap.set(sessionId, tier);
}

export function makeManifestEntry(id: string): ActionManifestEntry {
  return {
    id: id as ActionId,
    name: id,
    title: id,
    description: `description for ${id}`,
    category: "test",
    kind: "query",
    danger: "safe" as const,
    enabled: true,
    requiresArgs: false,
    inputSchema: { type: "object", properties: {} },
  };
}
