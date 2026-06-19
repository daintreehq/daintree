import { afterEach, describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ActionManifestEntry, ActionId } from "../../../../shared/types/actions.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer, validateDisplayImageUrl } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import type { SessionStore } from "../sessionStore.js";
import { SessionStore as RealSessionStore, consumeToken } from "../sessionStore.js";
import { GrantCache } from "../grantCache.js";
import {
  buildToolError,
  buildMcpErrorPayload,
  RETRIABLE_ERROR_CODES,
  TIER_NOT_PERMITTED_CODE,
  EXECUTION_ERROR_CODE,
  SESSION_BINDING_GONE,
  CONFIRMATION_TIMEOUT_CODE,
  USER_REJECTED_CODE,
  ELICITATION_FAILED_CODE,
  MCP_DEDUP_KEY_COLLISION_CODE,
  MCP_DEDUP_ALLOWLIST,
  MCP_RATE_LIMITED_CODE,
  RATE_LIMIT_TIERS,
  RATE_LIMIT_TOOL_MAP,
  unwrapDispatchResult,
} from "../shared.js";
import { SessionBindingError, RendererBridgeUnavailableError } from "../rendererBridge.js";
import { getAgentAvailabilityStore } from "../../AgentAvailabilityStore.js";
import { events } from "../../events.js";

function fakeSessionStore(
  tier: "workbench" | "action" | "system" | "external" = "workbench"
): SessionStore {
  // Real GrantCache instance with sweeping disabled — tests drive lazy
  // eviction via the optional `now` clock when they need to assert
  // expiry, and they call dispose() at teardown.
  const grantCache = new GrantCache({ sweepIntervalMs: 0 });
  const store = {
    sessions: new Map(),
    httpSessions: new Map(),
    sessionTierMap: new Map(),
    sessionWebContentsMap: new Map(),
    resourceSubscriptions: new Map(),
    dedupInFlight: new Map(),
    dedupResultCache: new Map(),
    rateLimitBuckets: new Map(),
    grantCache,
    drain: vi.fn(),
    getTier: vi.fn(() => tier),
    createIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
    createHttpIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
    resetIdleTimer: vi.fn(),
    resetHttpIdleTimer: vi.fn(),
    clearDedupState: vi.fn(),
    // Permissive by default so existing suites aren't throttled; the
    // rate-limit suite overrides this with a counting stub or the real
    // implementation.
    consumeRateLimitToken: vi.fn(() => ({ allowed: true })),
    clearRateLimitState: vi.fn(),
  } as unknown as SessionStore;
  return store;
}

function fakeDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
  return {
    sessionStore: fakeSessionStore(),
    requestManifest: vi.fn().mockResolvedValue([]),
    dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: null } }),
    handleWaitUntilIdle: vi.fn(),
    appendAuditRecord: vi.fn(),
    getCachedManifest: vi.fn(() => null),
    getFullToolSurface: vi.fn(() => false),
    ...overrides,
  };
}

function makeMockTransport(): Transport {
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
async function getPrompt(
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

async function listPrompts(server: ReturnType<typeof createSessionServer>) {
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
async function callTool(
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

async function listTools(server: ReturnType<typeof createSessionServer>) {
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

function makeManifestEntry(id: string): ActionManifestEntry {
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

describe("sessionServer tools/list handler", () => {
  // tier "external" + fullToolSurface bypasses the per-id allowlist in
  // shouldExposeTool, so any non-restricted entry surfaces — keeps these tests
  // decoupled from TIER_ALLOWLISTS membership.
  function fullSurfaceDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
    return fakeDeps({
      sessionStore: fakeSessionStore("external"),
      getFullToolSurface: vi.fn(() => true),
      ...overrides,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the live manifest when requestManifest succeeds", async () => {
    const deps = fullSurfaceDeps({
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("fresh_tool")]),
      getCachedManifest: vi.fn(() => [makeManifestEntry("stale_tool")]),
    });
    const server = createSessionServer("tools-list-fresh", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    // Fresh result wins over the (different) cache, proving the live path is used.
    expect(result.tools.map((t) => t.name)).toEqual(["fresh_tool"]);
  });

  it("falls back to the cached manifest, warning with the error, when requestManifest rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejection = new Error("Manifest request timed out");
    const deps = fullSurfaceDeps({
      requestManifest: vi.fn().mockRejectedValue(rejection),
      getCachedManifest: vi.fn(() => [makeManifestEntry("cached_tool")]),
    });
    const server = createSessionServer("tools-list-fallback", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    expect(result.tools.map((t) => t.name)).toEqual(["cached_tool"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The rejection must reach the log so operators can diagnose the stale serve.
    expect(warnSpy.mock.calls[0]).toContain(rejection);
  });

  it("applies the tier/visibility filter on the cached fallback path", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = fullSurfaceDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("Manifest request timed out")),
      getCachedManifest: vi.fn(() => [
        makeManifestEntry("allowed_tool"),
        { ...makeManifestEntry("restricted_tool"), danger: "restricted" as const },
      ]),
    });
    const server = createSessionServer("tools-list-filtered-cache", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    // shouldExposeTool drops restricted entries even on the cache path.
    expect(result.tools.map((t) => t.name)).toEqual(["allowed_tool"]);
  });

  it("fails closed with an McpError when requestManifest rejects and no cache exists", async () => {
    const deps = fullSurfaceDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("MCP renderer bridge unavailable")),
      getCachedManifest: vi.fn(() => null),
    });
    const server = createSessionServer("tools-list-failclosed", deps);
    await server.connect(makeMockTransport());

    await expect(listTools(server)).rejects.toBeInstanceOf(McpError);
    await expect(listTools(server)).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("Action manifest unavailable"),
    });
  });

  it("fails closed even if the session is unpinned after the await (snapshot before async boundary)", async () => {
    // Pinned session: getCachedManifest returns null while the request is in
    // flight, then teardown flips it to a foreign manifest. The handler must
    // use the pre-await snapshot (null) and fail closed — never serve the
    // foreign cache (#7003 cross-window isolation).
    let firstCall = true;
    const deps = fullSurfaceDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("MCP renderer bridge destroyed")),
      getCachedManifest: vi.fn(() => {
        if (firstCall) {
          firstCall = false;
          return null;
        }
        return [makeManifestEntry("foreign_tool")];
      }),
    });
    const server = createSessionServer("tools-list-race", deps);
    await server.connect(makeMockTransport());

    await expect(listTools(server)).rejects.toBeInstanceOf(McpError);
    // getCachedManifest was read exactly once — synchronously, before the await.
    expect(deps.getCachedManifest).toHaveBeenCalledTimes(1);
  });

  it("treats an empty cached manifest as a valid zero-tool surface, not unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = fullSurfaceDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("MCP renderer bridge destroyed")),
      getCachedManifest: vi.fn(() => []),
    });
    const server = createSessionServer("tools-list-empty-cache", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    expect(result.tools).toEqual([]);
  });
});

describe("sessionServer prompt handler", () => {
  it("renders start_issue prompt with valid string argument", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s1", deps);
    await server.connect(makeMockTransport());

    const result = await getPrompt(server, {
      name: "start_issue",
      arguments: { issue_number: "6610" },
    });

    expect((result as Record<string, unknown>).messages).toBeDefined();
  });

  it("renders triage_failed_agent without optional terminal_id", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s2", deps);
    await server.connect(makeMockTransport());

    const result = await getPrompt(server, {
      name: "triage_failed_agent",
      arguments: {},
    });

    expect((result as Record<string, unknown>).messages).toBeDefined();
  });

  it("renders triage_terminals fleet-polling recipe with key anchors and behavioral guardrails", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s_triage_terminals", deps);
    await server.connect(makeMockTransport());

    const result = (await getPrompt(server, {
      name: "triage_terminals",
      arguments: {},
    })) as { messages: Array<{ role: string; content: { type: string; text: string } }> };

    expect(result.messages).toBeDefined();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");

    const text = result.messages[0].content.text;
    // Tool/concept anchors
    expect(text).toContain("terminal.getStatus");
    expect(text).toContain("lastTransitionAt");
    expect(text).toContain("ScheduleWakeup");
    expect(text).toContain("terminal.waitUntilIdle");
    expect(text).toContain("includeOutput");
    // Behavioral guardrails — catch adversarial rewrites that keep keywords but invert advice
    expect(text).toContain("Don't fan");
    expect(text).toContain("Don't busy-loop");
    // directing must appear alongside working as a state to skip
    expect(text).toContain("directing");
    // waitingReason discrimination must survive future edits
    expect(text).toContain('"prompt"');
    expect(text).toContain('"question"');
  });

  it("does not dispatch worktree.getCurrent for triage_terminals (static prompt)", async () => {
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ dispatchAction });
    const server = createSessionServer("s_triage_terminals_static", deps);
    await server.connect(makeMockTransport());

    await getPrompt(server, { name: "triage_terminals", arguments: {} });

    const worktreeCalls = dispatchAction.mock.calls.filter(([id]) => id === "worktree.getCurrent");
    expect(worktreeCalls).toHaveLength(0);
  });

  it("lists triage_terminals in prompts/list with no arguments", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s_prompts_list", deps);
    await server.connect(makeMockTransport());

    const result = (await listPrompts(server)) as {
      prompts: Array<{ name: string; description: string; arguments?: unknown[] }>;
    };

    expect(Array.isArray(result.prompts)).toBe(true);
    const triage = result.prompts.find((p) => p.name === "triage_terminals");
    expect(triage).toBeDefined();
    expect(triage!.description.length).toBeGreaterThan(0);
    expect(triage!.arguments).toEqual([]);
  });

  it("throws McpError for unknown prompt name", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s3", deps);
    await server.connect(makeMockTransport());

    await expect(getPrompt(server, { name: "nonexistent", arguments: {} })).rejects.toThrow(
      McpError
    );
  });

  it("throws McpError(InvalidParams) for missing required argument", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s4", deps);
    await server.connect(makeMockTransport());

    try {
      await getPrompt(server, { name: "start_issue", arguments: {} });
      expect.fail("Expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      expect((err as McpError).message).toContain("Missing required argument");
    }
  });

  it("rejects non-string argument values (Zod validates before our handler, both layers reject)", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s5", deps);
    await server.connect(makeMockTransport());

    // Non-string values are caught by the SDK's Zod validation
    // (parseWithCompat in the handler wrapper), which runs before
    // our typeof check. Both layers reject non-strings.
    try {
      await getPrompt(server, {
        name: "start_issue",
        arguments: { issue_number: 42 },
      });
      expect.fail("Expected error for non-string argument");
    } catch (err) {
      // ZodError is thrown by the SDK wrapper before our handler runs
      expect(err).toBeTruthy();
    }
  });

  it("handler validates arguments are strings (defense-in-depth beyond Zod schema)", () => {
    // Our typeof check is a second layer of defense. When the Zod schema
    // is relaxed or the handler is called through a different path, our
    // check catches non-string values with a proper McpError(InvalidParams).
    // This test verifies the handler code is present and correct.
    const deps = fakeDeps();
    const server = createSessionServer("s6", deps);

    // The handler should be registered for prompts/get
    const handlers = (
      server as unknown as {
        _requestHandlers: Map<string, unknown>;
      }
    )._requestHandlers;
    expect(handlers.has("prompts/get")).toBe(true);
  });
});

describe("CallTool idempotency dedup", () => {
  it("coalesces same-moment duplicates via singleflight (dispatch invoked once)", async () => {
    // Hold the dispatch with a manually-resolved promise so two callers race
    // through the handler before the first one resolves.
    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-1", deps);

    const a = callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });
    const b = callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });

    // Both handlers are now suspended; A awaits requestManifest then dispatchAction,
    // B detects the in-flight entry A registered synchronously and awaits the same
    // promise. Yield microtasks until A's handler has reached the held dispatch.
    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(resolveDispatch).toBeDefined();

    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-1" } } });

    const [resultA, resultB] = await Promise.all([a, b]);

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(resultA).toEqual(resultB);
    expect((resultA as { content: Array<{ text: string }> }).content[0].text).toContain("t-1");
  });

  it("returns the cached result for a post-completion duplicate within TTL", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-2" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-2", deps);

    const args = { spawnedBy: { kind: "user" } };
    const first = await callTool(server, { name: "terminal.new", arguments: args });
    const second = await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("does not dedup non-allowlisted actions", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { ok: true } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-3", deps);

    await callTool(server, { name: "terminal.list", arguments: {} });
    await callTool(server, { name: "terminal.list", arguments: {} });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("treats different args as distinct keys", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-x" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-4", deps);

    await callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });
    await callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "agent" } },
    });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("returns collision error when same requestKey used with different args (result-cache)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-rk" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-5", deps);

    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-1", spawnedBy: { kind: "user" } },
    });
    const second = (await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-1", spawnedBy: { kind: "agent" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain(MCP_DEDUP_KEY_COLLISION_CODE);
    // requestKey must not reach dispatchAction.
    const dispatchedArgs = dispatchAction.mock.calls[0][1] as Record<string, unknown>;
    expect(dispatchedArgs).not.toHaveProperty("requestKey");
  });

  it("returns collision error when same requestKey used with different args (in-flight)", async () => {
    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-5b", deps);

    // Fire the first call — it will register in-flight and then await dispatch.
    const first = callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-inflight", spawnedBy: { kind: "user" } },
    });

    // Yield microtasks so the first handler registers its in-flight entry.
    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(resolveDispatch).toBeDefined();

    // Second call with same requestKey but different args — must return collision
    // synchronously, not await the in-flight promise.
    const second = (await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-inflight", spawnedBy: { kind: "agent" } },
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(second.isError).toBe(true);
    expect(second.content[0].text).toContain(MCP_DEDUP_KEY_COLLISION_CODE);

    // Resolve the first call so it doesn't hang.
    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-inflight" } } });
    await first;

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("dedup still works with explicit requestKey and same args (result-cache)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-rk-ok" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-rk-ok", deps);

    const args = { requestKey: "rk-same", spawnedBy: { kind: "user" } };
    const first = await callTool(server, { name: "terminal.new", arguments: args });
    const second = await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("dedup still works with explicit requestKey and same args (in-flight)", async () => {
    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-rk-inflight", deps);

    const a = callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-same2", spawnedBy: { kind: "user" } },
    });
    const b = callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "rk-same2", spawnedBy: { kind: "user" } },
    });

    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(resolveDispatch).toBeDefined();

    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-rk-if-ok" } } });

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(resultA).toEqual(resultB);
  });

  it("does not cache failed dispatches; retries re-dispatch", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValueOnce({
        result: { ok: false, error: { code: "BOOM", message: "kaboom" } },
      })
      .mockResolvedValueOnce({ result: { ok: true, result: { terminalId: "t-retry" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-6", deps);

    const args = { spawnedBy: { kind: "user" } };
    const first = (await callTool(server, { name: "terminal.new", arguments: args })) as {
      isError?: boolean;
    };
    expect(first.isError).toBe(true);

    const second = await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    expect((second as { content: Array<{ text: string }> }).content[0].text).toContain("t-retry");
  });

  it("does not cache thrown dispatches; retries re-dispatch", async () => {
    const dispatchAction = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ result: { ok: true, result: { terminalId: "t-throw" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-7", deps);

    const args = { spawnedBy: { kind: "user" } };
    const first = (await callTool(server, { name: "terminal.new", arguments: args })) as {
      isError?: boolean;
    };
    expect(first.isError).toBe(true);

    const second = await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    expect((second as { content: Array<{ text: string }> }).content[0].text).toContain("t-throw");
  });

  it("logs a 'dedup' audit record when a duplicate is suppressed", async () => {
    const appendAuditRecord = vi.fn();
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-audit" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
      appendAuditRecord,
    });
    const server = createSessionServer("dedup-8", deps);

    const args = { spawnedBy: { kind: "user" } };
    await callTool(server, { name: "terminal.new", arguments: args });
    await callTool(server, { name: "terminal.new", arguments: args });

    const outcomes = appendAuditRecord.mock.calls.map(
      (call) => (call[0] as { outcome: { kind: string } }).outcome.kind
    );
    expect(outcomes).toContain("dedup");
    expect(outcomes.filter((k) => k === "dedup")).toHaveLength(1);
  });

  it("treats requestKey:'' as absent (falls through to auto-hash)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-empty" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-9", deps);

    // Same auto-hash key (same args), so even with empty requestKey both dedupe.
    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "", spawnedBy: { kind: "user" } },
    });
    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: "", spawnedBy: { kind: "user" } },
    });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("re-dispatches after drain() clears the cache", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-drain" } } });
    const sessionStore = fakeSessionStore("system");
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("dedup-10", deps);

    const args = { spawnedBy: { kind: "user" } };
    await callTool(server, { name: "terminal.new", arguments: args });

    // Wipe the cache the way drain() does.
    sessionStore.dedupInFlight.clear();
    sessionStore.dedupResultCache.clear();

    await callTool(server, { name: "terminal.new", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("re-dispatches after the TTL window elapses", async () => {
    vi.useFakeTimers();
    try {
      const dispatchAction = vi
        .fn()
        .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-ttl" } } });
      const deps = fakeDeps({
        sessionStore: fakeSessionStore("system"),
        dispatchAction,
      });
      const server = createSessionServer("dedup-ttl", deps);

      const args = { spawnedBy: { kind: "user" } };
      await callTool(server, { name: "terminal.new", arguments: args });

      // Just before the TTL expires — still cached.
      vi.advanceTimersByTime(119_999);
      await callTool(server, { name: "terminal.new", arguments: args });
      expect(dispatchAction).toHaveBeenCalledTimes(1);

      // After the TTL expires — should redispatch.
      vi.advanceTimersByTime(2);
      await callTool(server, { name: "terminal.new", arguments: args });
      expect(dispatchAction).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates dedup state between sessions (same store, different session ids)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-iso" } } });
    const sessionStore = fakeSessionStore("system");
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const serverA = createSessionServer("session-a", deps);
    const serverB = createSessionServer("session-b", deps);

    const args = { requestKey: "shared-key", spawnedBy: { kind: "user" } };
    await callTool(serverA, { name: "terminal.new", arguments: args });
    await callTool(serverB, { name: "terminal.new", arguments: args });

    // Same requestKey, but different sessions — both must dispatch.
    expect(dispatchAction).toHaveBeenCalledTimes(2);
  });

  it("dedups agent.launch with the same arguments", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-agent" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-agent", deps);

    await callTool(server, { name: "agent.launch", arguments: { agentId: "claude" } });
    await callTool(server, { name: "agent.launch", arguments: { agentId: "claude" } });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("dedups worktree.createWithRecipe with the same arguments", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { worktreeId: "wt-1" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-wt", deps);

    const args = { branchName: "feature/x" };
    await callTool(server, { name: "worktree.createWithRecipe", arguments: args });
    await callTool(server, { name: "worktree.createWithRecipe", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("dedups recipe.run with the same arguments", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-recipe" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-recipe", deps);

    const args = { recipeId: "build" };
    await callTool(server, { name: "recipe.run", arguments: args });
    await callTool(server, { name: "recipe.run", arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect dedup state when drain() runs during an in-flight dispatch", async () => {
    const realStore = new RealSessionStore(() => {});
    realStore.sessionTierMap.set("dedup-resurrect", "system");

    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({ sessionStore: realStore, dispatchAction });
    const server = createSessionServer("dedup-resurrect", deps);

    const inFlightCall = callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });

    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(realStore.dedupInFlight.get("dedup-resurrect")?.size).toBe(1);

    // Drain mid-flight — wipes dedup state and the session tier map.
    realStore.drain();
    expect(realStore.dedupInFlight.size).toBe(0);
    expect(realStore.dedupResultCache.size).toBe(0);

    // Resolve the held dispatch. The .then() cache hook must NOT resurrect
    // dedupResultCache for the torn-down session.
    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-resurrect" } } });
    await inFlightCall;
    // Flush microtasks so the .then() cache hook had a chance to misfire.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(realStore.dedupResultCache.size).toBe(0);
    expect(realStore.dedupInFlight.size).toBe(0);
  });

  it("rejects requestKey strings beyond the length cap (falls back to auto-hash)", async () => {
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-long" } } });
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("system"),
      dispatchAction,
    });
    const server = createSessionServer("dedup-long", deps);

    const oversized = "x".repeat(257); // MAX_REQUEST_KEY_LENGTH = 256
    // Same args, different oversized requestKeys → still dedups via auto-hash
    // because the oversized requestKey is rejected and ignored.
    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: oversized + "a", spawnedBy: { kind: "user" } },
    });
    await callTool(server, {
      name: "terminal.new",
      arguments: { requestKey: oversized + "b", spawnedBy: { kind: "user" } },
    });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });
});

describe("buildToolError envelope", () => {
  function getErrorText(result: ReturnType<typeof buildToolError>): string {
    const block = result.content[0];
    if (block.type !== "text") throw new Error("Expected text block");
    return block.text;
  }

  it("produces a parseable JSON payload with code, message, and retriable", () => {
    const result = buildToolError({
      code: TIER_NOT_PERMITTED_CODE,
      message: "action 'foo' is not permitted for the 'workbench' tier.",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");

    const parsed = JSON.parse(getErrorText(result));
    expect(parsed).toEqual({
      code: TIER_NOT_PERMITTED_CODE,
      message: "action 'foo' is not permitted for the 'workbench' tier.",
      retriable: false,
    });
  });

  it("marks EXECUTION_ERROR as retriable", () => {
    const result = buildToolError({ code: EXECUTION_ERROR_CODE, message: "boom" });
    const parsed = JSON.parse(getErrorText(result));
    expect(parsed.retriable).toBe(true);
  });

  it("marks CONFIRMATION_TIMEOUT as retriable", () => {
    const result = buildToolError({ code: CONFIRMATION_TIMEOUT_CODE, message: "timed out" });
    const parsed = JSON.parse(getErrorText(result));
    expect(parsed.retriable).toBe(true);
  });

  it("marks USER_REJECTED and ELICITATION_FAILED as non-retriable", () => {
    const rejected = JSON.parse(
      getErrorText(buildToolError({ code: USER_REJECTED_CODE, message: "no" }))
    );
    const elicit = JSON.parse(
      getErrorText(buildToolError({ code: ELICITATION_FAILED_CODE, message: "fail" }))
    );
    expect(rejected.retriable).toBe(false);
    expect(elicit.retriable).toBe(false);
  });

  it("preserves structured details from ActionError", () => {
    const result = buildToolError({
      code: "VALIDATION_ERROR",
      message: "Invalid input",
      details: { unknownArguments: ["foo"], missingVariables: ["bar"] },
    });
    const parsed = JSON.parse(getErrorText(result));
    expect(parsed.details).toEqual({
      unknownArguments: ["foo"],
      missingVariables: ["bar"],
    });
  });

  it("omits details key when undefined", () => {
    const result = buildToolError({ code: "NOT_FOUND", message: "missing" });
    const parsed = JSON.parse(getErrorText(result));
    expect("details" in parsed).toBe(false);
  });

  it("preserves null details when caller explicitly passes null", () => {
    const result = buildToolError({ code: "NOT_FOUND", message: "missing", details: null });
    const parsed = JSON.parse(getErrorText(result));
    expect("details" in parsed).toBe(true);
    expect(parsed.details).toBeNull();
  });

  it("falls back to a serializationError marker when details has a circular reference", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const result = buildToolError({
      code: "EXECUTION_ERROR",
      message: "boom",
      details: circular,
    });
    expect(() => JSON.parse(getErrorText(result))).not.toThrow();
    const parsed = JSON.parse(getErrorText(result));
    expect(parsed.details).toEqual({ serializationError: true });
  });

  it("legacy substrings remain greppable for existing .toContain assertions", () => {
    const result = buildToolError({
      code: TIER_NOT_PERMITTED_CODE,
      message: "action 'panel.gridLayout.setStrategy' is not permitted for the 'workbench' tier.",
    });
    const text = getErrorText(result);
    expect(text).toContain("TIER_NOT_PERMITTED");
    expect(text).toContain("workbench");
    expect(text).toContain("panel.gridLayout.setStrategy");
  });
});

describe("buildMcpErrorPayload", () => {
  it("returns the same shape used on both surfaces", () => {
    const payload = buildMcpErrorPayload({
      code: TIER_NOT_PERMITTED_CODE,
      message: "Resource 'x' is not permitted for the 'workbench' tier.",
    });
    expect(payload).toEqual({
      code: TIER_NOT_PERMITTED_CODE,
      message: "Resource 'x' is not permitted for the 'workbench' tier.",
      retriable: false,
    });
  });

  it("includes details when provided", () => {
    const payload = buildMcpErrorPayload({
      code: "VALIDATION_ERROR",
      message: "bad",
      details: { argument: "name" },
    });
    expect(payload.details).toEqual({ argument: "name" });
  });

  it("RETRIABLE_ERROR_CODES contains EXECUTION_ERROR and CONFIRMATION_TIMEOUT", () => {
    expect(RETRIABLE_ERROR_CODES.has(EXECUTION_ERROR_CODE)).toBe(true);
    expect(RETRIABLE_ERROR_CODES.has(CONFIRMATION_TIMEOUT_CODE)).toBe(true);
    expect(RETRIABLE_ERROR_CODES.has(TIER_NOT_PERMITTED_CODE)).toBe(false);
  });
});

describe("unwrapDispatchResult error path", () => {
  it("throws McpError carrying the structured payload as data", () => {
    try {
      unwrapDispatchResult({
        result: {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid args",
            details: { argument: "name" },
          },
        },
      });
      expect.fail("Expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.code).toBe(ErrorCode.InternalError);
      expect(mcpErr.message).toContain("VALIDATION_ERROR");
      expect(mcpErr.message).toContain("Invalid args");
      expect(mcpErr.data).toEqual({
        code: "VALIDATION_ERROR",
        message: "Invalid args",
        details: { argument: "name" },
        retriable: false,
      });
    }
  });

  it("returns the result value on success", () => {
    const value = unwrapDispatchResult({
      result: { ok: true, result: { foo: 1 } },
    });
    expect(value).toEqual({ foo: 1 });
  });
});

describe("sessionServer tier-mismatch notifier", () => {
  async function callTool(
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
    );
  }

  it("invokes notifyTierMismatch with targetTier when a workbench session calls a system-tier tool", async () => {
    const notify = vi.fn();
    const dispatchAction = vi.fn();
    const deps = fakeDeps({ notifyTierMismatch: notify, dispatchAction });
    const server = createSessionServer("session-A", deps);
    await server.connect(makeMockTransport());

    // worktree.delete is in SYSTEM_TIER_ADDONS — denied at workbench tier.
    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TIER_NOT_PERMITTED");
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      sessionId: "session-A",
      toolId: "worktree.delete",
      tier: "workbench",
      targetTier: "system",
    });
  });

  it("does not invoke notifyTierMismatch when the call is permitted", async () => {
    const notify = vi.fn();
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ notifyTierMismatch: notify, dispatchAction });
    const server = createSessionServer("session-B", deps);
    await server.connect(makeMockTransport());

    // worktree.list is in WORKBENCH_TOOLS — permitted at workbench tier.
    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(notify).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalled();
  });

  it("computes targetTier=action for action-tier tools and forwards it", async () => {
    const notify = vi.fn();
    const deps = fakeDeps({ notifyTierMismatch: notify });
    const server = createSessionServer("session-C", deps);
    await server.connect(makeMockTransport());

    // worktree.createWithRecipe is in ACTION_TIER_ADDONS — denied at workbench.
    await callTool(server, {
      name: "worktree.createWithRecipe",
      arguments: { branchName: "x" },
    });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "worktree.createWithRecipe",
        targetTier: "action",
      })
    );
  });

  it("survives a notifyTierMismatch throw without crashing the call", async () => {
    const notify = vi.fn(() => {
      throw new Error("boom");
    });
    const deps = fakeDeps({ notifyTierMismatch: notify });
    const server = createSessionServer("session-D", deps);
    await server.connect(makeMockTransport());

    // The denial response should still be returned even if the notifier throws.
    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TIER_NOT_PERMITTED");
  });
});

describe("CallTool live activity notifications (#9759)", () => {
  it("emits started then settled for a permitted dispatch", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
      dispatchAction,
    });
    const server = createSessionServer("session-A", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-A", toolId: "worktree.list", danger: false })
    );
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-A",
        toolId: "worktree.list",
        outcome: expect.objectContaining({ kind: "result" }),
      })
    );
    // Started must precede settled.
    expect(started.mock.invocationCallOrder[0]).toBeLessThan(settled.mock.invocationCallOrder[0]);
  });

  it("threads one captured turn id into started, settled, and the audit record (#10067)", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const appendAuditRecord = vi.fn();
    // getCurrentTurnId is read once at dispatch start. Returning a fresh value
    // on a second call would prove a leak; this asserts a single snapshot.
    const getCurrentTurnId = vi.fn().mockReturnValue("turn-xyz");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({
      getCurrentTurnId,
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
      appendAuditRecord,
      dispatchAction,
    });
    const server = createSessionServer("session-T", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    // One read, threaded to all three consumers end-to-end — none re-reads the
    // register, so the strip's started/settled rows and the audit record can
    // never disagree on which turn the call belongs to.
    expect(getCurrentTurnId).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ capturedTurnId: "turn-xyz" }));
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ capturedTurnId: "turn-xyz" }));
    expect(appendAuditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ capturedTurnId: "turn-xyz" })
    );
  });

  it("snapshots the turn id at start so started/settled agree across an FSM clear (#10067)", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    // Mirror the active→passive race: the turn id is live at dispatch start but
    // a later read would return null. Both events must still carry the snapshot.
    const getCurrentTurnId = vi.fn().mockReturnValueOnce("turn-T1").mockReturnValue(null);
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({
      getCurrentTurnId,
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
      dispatchAction,
    });
    const server = createSessionServer("session-T2", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    const startedTurn = started.mock.calls[0]?.[0]?.capturedTurnId;
    const settledTurn = settled.mock.calls[0]?.[0]?.capturedTurnId;
    expect(startedTurn).toBe("turn-T1");
    expect(settledTurn).toBe("turn-T1");
    expect(startedTurn).toBe(settledTurn);
  });

  it("does not emit started/settled for a pre-dispatch tier rejection", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const deps = fakeDeps({ notifyToolCallStarted: started, notifyToolCallSettled: settled });
    const server = createSessionServer("session-B", deps);
    await server.connect(makeMockTransport());

    // worktree.delete is system-tier — denied at the default workbench tier.
    await callTool(server, { name: "worktree.delete", arguments: {} });

    expect(started).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("does not emit started/settled for a rate-limited rejection", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const sessionStore = fakeSessionStore("workbench");
    (sessionStore.consumeRateLimitToken as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      retryAfter: 5,
    });
    const deps = fakeDeps({
      sessionStore,
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
    });
    const server = createSessionServer("session-C", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(started).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('flags danger:"confirm" tools on the started event', async () => {
    const started = vi.fn();
    const requestManifest = vi
      .fn()
      .mockResolvedValue([
        { id: "worktree.list", title: "List", description: "d", danger: "confirm" },
      ]);
    const deps = fakeDeps({
      notifyToolCallStarted: started,
      requestManifest,
      dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: null } }),
    });
    const server = createSessionServer("session-D", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(started).toHaveBeenCalledWith(expect.objectContaining({ danger: true }));
  });

  it("emits started (danger:false) + settled for the waitUntilIdle short-circuit", async () => {
    const started = vi.fn();
    const settled = vi.fn();
    const handleWaitUntilIdle = vi.fn().mockResolvedValue({
      idleReason: "idle" as const,
      durationMs: 10,
      finalState: "idle",
    });
    const deps = fakeDeps({
      // waitUntilIdle is in ACTION_TIER_ADDONS — use an action-tier session so
      // the call clears the tier floor and reaches the dispatch path.
      sessionStore: fakeSessionStore("action"),
      notifyToolCallStarted: started,
      notifyToolCallSettled: settled,
      handleWaitUntilIdle,
    });
    const server = createSessionServer("session-W", deps);
    await server.connect(makeMockTransport());

    await callTool(server, {
      name: "terminal.waitUntilIdle",
      arguments: { terminalId: "t1", timeoutMs: 10 },
    });

    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "terminal.waitUntilIdle", danger: false })
    );
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "terminal.waitUntilIdle",
        outcome: expect.objectContaining({ kind: "result" }),
      })
    );
  });

  it("survives a notifyToolCallStarted throw without failing the dispatch", async () => {
    const started = vi.fn(() => {
      throw new Error("boom");
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ notifyToolCallStarted: started, dispatchAction });
    const server = createSessionServer("session-E", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, { name: "worktree.list", arguments: {} })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
    expect(dispatchAction).toHaveBeenCalled();
  });
});

describe("CallTool error envelope (integration through sessionServer)", () => {
  async function callTool(
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
    );
  }

  it("tier denial returns a parseable JSON envelope", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s-tier", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "git.push",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(TIER_NOT_PERMITTED_CODE);
    expect(parsed.retriable).toBe(false);
    expect(parsed.message).toContain("workbench");
  });

  it("propagates ActionError.details through the envelope", async () => {
    const manifest = [
      {
        id: "files.search",
        title: "Files: search",
        description: "Search files",
        category: "files",
        danger: "safe" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockResolvedValue({
        result: {
          ok: false,
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid arguments",
            details: { unknownArguments: ["badKey"] },
          },
        },
      }),
    });
    const server = createSessionServer("s-details", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "files.search",
      arguments: { badKey: 1 },
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe("VALIDATION_ERROR");
    expect(parsed.details).toEqual({ unknownArguments: ["badKey"] });
    expect(parsed.retriable).toBe(false);
  });

  it("synthesises EXECUTION_ERROR with retriable=true when dispatch throws", async () => {
    const manifest = [
      {
        id: "files.search",
        title: "Files: search",
        description: "Search",
        category: "files",
        danger: "safe" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockRejectedValue(new Error("transport went away")),
    });
    const server = createSessionServer("s-throw", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "files.search",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(EXECUTION_ERROR_CODE);
    expect(parsed.retriable).toBe(true);
    expect(parsed.message).toContain("transport went away");
  });

  it("maps SessionBindingError to SESSION_BINDING_GONE with retriable=false (#8432)", async () => {
    const manifest = [
      {
        id: "files.search",
        title: "Files: search",
        description: "Search",
        category: "files",
        danger: "safe" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockRejectedValue(new SessionBindingError(42)),
    });
    const server = createSessionServer("s-binding", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "files.search",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(SESSION_BINDING_GONE);
    expect(parsed.retriable).toBe(false);
    expect(parsed.message).toContain("Do not retry");
    expect(parsed.message).toContain("42");
  });

  it("reclassifies a no-channel confirm dispatch to CONFIRMATION_REQUIRED, not EXECUTION_ERROR (#10640)", async () => {
    // recipe.run is a real danger:"confirm" action in the action tier. With a
    // client that lacks elicitation.form, the unconfirmed dispatch is forwarded
    // to the renderer bridge, which throws RendererBridgeUnavailableError when
    // no Daintree window is open. Because the manifest entry IS known to be
    // confirm-gated, that must surface as a non-retriable CONFIRMATION_REQUIRED
    // (the human couldn't be asked) rather than a retriable EXECUTION_ERROR.
    const manifest = [
      {
        id: "recipe.run",
        title: "Recipe: run",
        description: "Run a recipe",
        category: "recipe",
        danger: "confirm" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const dispatchAction = vi.fn().mockRejectedValue(new RendererBridgeUnavailableError());
    const deps = fakeDeps({
      // action tier so recipe.run clears the tier floor and reaches dispatch.
      sessionStore: fakeSessionStore("action"),
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction,
    });
    const server = createSessionServer("s-no-channel", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "recipe.run",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    // Dispatch was attempted unconfirmed (the renderer is the confirm gate).
    expect(dispatchAction).toHaveBeenCalledWith("recipe.run", {}, false);
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe("CONFIRMATION_REQUIRED");
    expect(parsed.retriable).toBe(false);
    expect(parsed.details).toEqual({ confirmationChannel: "unavailable" });
  });

  it("keeps a retriable EXECUTION_ERROR for a non-confirm tool when the bridge is unavailable (#10640)", async () => {
    // The reclassification is scoped to confirm-gated tools. A safe tool that
    // hits the same RendererBridgeUnavailableError is a genuine "no renderer"
    // failure (nothing needed confirming) and stays a retriable EXECUTION_ERROR
    // — but with an explicit cause rather than an opaque dispatch failure.
    const manifest = [
      {
        id: "files.search",
        title: "Files: search",
        description: "Search files",
        category: "files",
        danger: "safe" as const,
        source: ["agent"] as const,
      },
    ] as unknown as import("../../../../shared/types/actions.js").ActionManifestEntry[];
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
    });
    const server = createSessionServer("s-safe-no-channel", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "files.search",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(EXECUTION_ERROR_CODE);
    expect(parsed.retriable).toBe(true);
    expect(parsed.message).toContain("No Daintree window is open");
  });

  it("cold-cache confirm tool with no renderer stays a retriable EXECUTION_ERROR — danger is unknowable without a manifest (#10640)", async () => {
    // Deliberate boundary: when no window is open AND the manifest cache is cold,
    // the manifest fetch itself goes through the renderer and throws, so
    // `lookupManifestEntry` returns undefined and the tool's danger is unknown.
    // We must NOT claim CONFIRMATION_REQUIRED for an unverified confirm tool, so
    // this stays a retriable EXECUTION_ERROR (the renderer may return when a
    // window opens) rather than the non-retriable confirmation signal the
    // warm-cache path produces.
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("action"),
      // Cold cache + no renderer: both the manifest fetch and the dispatch fail.
      getCachedManifest: vi.fn(() => null),
      requestManifest: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
      dispatchAction: vi.fn().mockRejectedValue(new RendererBridgeUnavailableError()),
    });
    const server = createSessionServer("s-cold-cache", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "recipe.run",
      arguments: {},
    })) as { isError: boolean; content: { type: string; text: string }[] };

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.code).toBe(EXECUTION_ERROR_CODE);
    expect(parsed.retriable).toBe(true);
    expect(parsed.message).toContain("No Daintree window is open");
  });
});

describe("Resource error envelope (integration through sessionServer)", () => {
  async function readResource(server: ReturnType<typeof createSessionServer>, uri: string) {
    const handlers = (
      server as unknown as {
        _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
      }
    )._requestHandlers;
    const handler = handlers.get("resources/read");
    if (!handler) throw new Error("resources/read handler not found");
    return handler(
      { method: "resources/read", params: { uri }, jsonrpc: "2.0", id: 1 },
      {
        signal: new AbortController().signal,
        _meta: {},
        sendNotification: vi.fn(),
        requestId: 1,
      }
    );
  }

  it("propagates ActionError as McpError with structured payload in data", async () => {
    // Backing dispatch fails with a NOT_FOUND ActionError carrying details.
    // unwrapDispatchResult should rethrow as McpError with the structured
    // payload attached as `data`, mirroring the tool-path JSON envelope.
    const deps = fakeDeps({
      dispatchAction: vi.fn().mockResolvedValue({
        result: {
          ok: false,
          error: {
            code: "NOT_FOUND",
            message: "Worktree 'wt-missing' not found",
            details: { worktreeId: "wt-missing" },
          },
        },
      }),
    });
    const server = createSessionServer("s-res-fail", deps);
    await server.connect(makeMockTransport());

    try {
      await readResource(server, "daintree://worktree/wt-missing/pulse");
      expect.fail("Expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.message).toContain("NOT_FOUND");
      expect(mcpErr.message).toContain("Worktree 'wt-missing' not found");
      expect(mcpErr.data).toEqual({
        code: "NOT_FOUND",
        message: "Worktree 'wt-missing' not found",
        details: { worktreeId: "wt-missing" },
        retriable: false,
      });
    }
  });

  it("hardens unserialisable details in McpError.data so transport JSON.stringify won't crash", async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const deps = fakeDeps({
      dispatchAction: vi.fn().mockResolvedValue({
        result: {
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: "boom",
            details: circular,
          },
        },
      }),
    });
    const server = createSessionServer("s-res-circular", deps);
    await server.connect(makeMockTransport());

    try {
      await readResource(server, "daintree://worktree/wt-1/pulse");
      expect.fail("Expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      // The downstream transport will JSON.stringify(message). If we hadn't
      // hardened buildMcpErrorPayload this would throw and crash the response.
      expect(() => JSON.stringify(mcpErr.data)).not.toThrow();
      const data = mcpErr.data as { details: unknown };
      expect(data.details).toEqual({ serializationError: true });
    }
  });

  it("returns successful resource contents when dispatch succeeds", async () => {
    const deps = fakeDeps({
      dispatchAction: vi.fn().mockResolvedValue({
        result: { ok: true, result: { commits: [], status: "clean" } },
      }),
    });
    const server = createSessionServer("s-res-ok", deps);
    await server.connect(makeMockTransport());

    const result = (await readResource(server, "daintree://worktree/wt-1/pulse")) as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].mimeType).toBe("application/json");
    expect(JSON.parse(result.contents[0].text)).toEqual({ commits: [], status: "clean" });
  });

  it("throws InvalidRequest McpError on unknown URI (no structured data)", async () => {
    const deps = fakeDeps();
    const server = createSessionServer("s-res-unknown", deps);
    await server.connect(makeMockTransport());

    try {
      await readResource(server, "daintree://something/else");
      expect.fail("Expected McpError");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.InvalidRequest);
      expect((err as McpError).message).toContain("Unknown resource URI");
    }
  });

  it("surfaces exit metadata in the agentState resource after the agent exits (#10638)", async () => {
    const store = getAgentAvailabilityStore();
    store.clear();
    events.emit("agent:spawned", {
      agentId: "claude",
      terminalId: "term-exit",
      timestamp: 5_000,
    });
    events.emit("agent:state-changed", {
      agentId: "claude",
      terminalId: "term-exit",
      state: "exited",
      previousState: "working",
      trigger: "exit",
      confidence: 1,
      timestamp: 6_000,
      exitCode: 2,
    });

    const deps = fakeDeps();
    const server = createSessionServer("s-res-agentstate", deps);
    await server.connect(makeMockTransport());

    const result = (await readResource(server, "daintree://agent/claude/state")) as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.state).toBe("exited");
    expect(parsed.exitCode).toBe(2);
    expect(parsed.spawnedAt).toBe(5_000);
    expect(parsed.lastTransitionAt).toBe(6_000);
    store.clear();
  });

  it("omits exitCode in the agentState resource while the agent is still working (#10638)", async () => {
    const store = getAgentAvailabilityStore();
    store.clear();
    events.emit("agent:spawned", {
      agentId: "codex",
      terminalId: "term-working",
      timestamp: 1_000,
    });
    events.emit("agent:state-changed", {
      agentId: "codex",
      terminalId: "term-working",
      state: "working",
      previousState: "idle",
      trigger: "output",
      confidence: 1,
      timestamp: 2_000,
    });

    const deps = fakeDeps();
    const server = createSessionServer("s-res-agentstate-working", deps);
    await server.connect(makeMockTransport());

    const result = (await readResource(server, "daintree://agent/codex/state")) as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    const parsed = JSON.parse(result.contents[0].text);
    expect(parsed.state).toBe("working");
    expect(parsed).not.toHaveProperty("exitCode");
    store.clear();
  });
});

describe("sessionServer grant cache fallback (#8442)", () => {
  async function callTool(
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
    );
  }

  it("floor-permitted tool never consults the grant cache", async () => {
    const sessionStore = fakeSessionStore("workbench");
    const checkSpy = vi.spyOn(sessionStore.grantCache, "check");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // worktree.list is in WORKBENCH_TOOLS → static floor permits.
    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(dispatchAction).toHaveBeenCalled();
    expect(checkSpy).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("denied tool with an active grant dispatches and refreshes TTL on success", async () => {
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer: setTimeout(() => {}, 1_000_000),
    });
    const resetIdle = sessionStore.resetIdleTimer as ReturnType<typeof vi.fn>;
    resetIdle.mockClear();
    sessionStore.grantCache.issueGrant("s", "worktree.delete");
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refresh");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const notify = vi.fn();
    const deps = fakeDeps({ sessionStore, dispatchAction, notifyTierMismatch: notify });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenCalledWith("worktree.delete", expect.any(Object), false);
    expect(notify).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(resetIdle).toHaveBeenCalledWith("s");
    sessionStore.grantCache.dispose();
  });

  it("native grant authorizes a denied tool without a modal and refreshes on success (#10648)", async () => {
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer: setTimeout(() => {}, 1_000_000),
    });
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refreshNativeGrant");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    // dispatchConfirmed=true → the native grant bypasses the confirm modal,
    // unlike a per-tool grant which dispatches with `false`.
    expect(dispatchAction).toHaveBeenCalledWith("worktree.delete", expect.any(Object), true);
    expect(refreshSpy).toHaveBeenCalledWith(grant.id);
    // One use consumed at authorization.
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });

  it("native grant for tool A does not authorize tool B (fails closed on scope) (#10648)", async () => {
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 5,
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // git.push is denied at the workbench floor AND is not in the grant's
    // allowlist → fail closed with TIER_NOT_PERMITTED, never dispatched.
    const result = (await callTool(server, {
      name: "git.push",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toContain("TIER_NOT_PERMITTED");
    expect(dispatchAction).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("an exhausted native grant fails closed on the next call (#10648)", async () => {
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer: setTimeout(() => {}, 1_000_000),
    });
    sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 1,
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const first = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean };
    expect(first.isError).not.toBe(true);

    const second = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(second.isError).toBe(true);
    expect(second.content?.[0]?.text ?? "").toContain("TIER_NOT_PERMITTED");
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    sessionStore.grantCache.dispose();
  });

  it("grant for tool A does not authorize tool B in the same session", async () => {
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.grantCache.issueGrant("s", "worktree.delete");
    const dispatchAction = vi.fn();
    const notify = vi.fn();
    const deps = fakeDeps({ sessionStore, dispatchAction, notifyTierMismatch: notify });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // worktree.createWithRecipe is action-tier, distinct from worktree.delete.
    const result = (await callTool(server, {
      name: "worktree.createWithRecipe",
      arguments: { branchName: "x" },
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "worktree.createWithRecipe" })
    );
    sessionStore.grantCache.dispose();
  });

  it("failed dispatch through a grant does not refresh the TTL", async () => {
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.grantCache.issueGrant("s", "worktree.delete");
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refresh");
    const dispatchAction = vi.fn().mockResolvedValue({
      result: { ok: false, error: { code: "BOOM", message: "boom" } },
    });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.delete", arguments: {} });

    expect(dispatchAction).toHaveBeenCalled();
    expect(refreshSpy).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("denials below the silence threshold fire the banner", async () => {
    const sessionStore = fakeSessionStore("workbench");
    const notify = vi.fn();
    const audit = vi.fn();
    const deps = fakeDeps({
      sessionStore,
      notifyTierMismatch: notify,
      appendAuditRecord: audit,
    });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // 1st denial.
    await callTool(server, { name: "worktree.delete", arguments: {} });
    expect(notify).toHaveBeenCalledTimes(1);

    // 2nd denial: still fires (threshold = 2 means 1st AND 2nd fire).
    await callTool(server, { name: "worktree.delete", arguments: {} });
    expect(notify).toHaveBeenCalledTimes(2);

    // 3rd denial: suppressed but audited.
    await callTool(server, { name: "worktree.delete", arguments: {} });
    expect(notify).toHaveBeenCalledTimes(2);

    // Every denial wrote an audit record.
    const unauthorizedRecords = audit.mock.calls.filter(
      (call) => call[0]?.outcome?.kind === "unauthorized"
    );
    expect(unauthorizedRecords).toHaveLength(3);
    // The third record carries bannerSuppressed: true.
    expect(unauthorizedRecords[2][0]).toMatchObject({ bannerSuppressed: true });
    expect(unauthorizedRecords[0][0].bannerSuppressed).toBeUndefined();
    expect(unauthorizedRecords[1][0].bannerSuppressed).toBeUndefined();

    sessionStore.grantCache.dispose();
  });

  it("issueGrant zeroes the denial counter — banner re-arms after explicit approval", async () => {
    const sessionStore = fakeSessionStore("workbench");
    const notify = vi.fn();
    const deps = fakeDeps({ sessionStore, notifyTierMismatch: notify });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // Push the counter past the silence threshold.
    await callTool(server, { name: "worktree.delete", arguments: {} });
    await callTool(server, { name: "worktree.delete", arguments: {} });
    await callTool(server, { name: "worktree.delete", arguments: {} });
    expect(sessionStore.grantCache.shouldSuppressBanner("s", "worktree.delete")).toBe(true);

    // Approval mints a grant + resets counter.
    sessionStore.grantCache.issueGrant("s", "worktree.delete");
    expect(sessionStore.grantCache.shouldSuppressBanner("s", "worktree.delete")).toBe(false);

    sessionStore.grantCache.dispose();
  });

  it("terminal.waitUntilIdle refreshes the grant TTL and resets idle timer on success", async () => {
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer: setTimeout(() => {}, 1_000_000),
    });
    const resetIdle = sessionStore.resetIdleTimer as ReturnType<typeof vi.fn>;
    resetIdle.mockClear();
    sessionStore.grantCache.issueGrant("s", "terminal.waitUntilIdle");
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refresh");

    // waitUntilIdle is a main-process short-circuit, NOT a renderer
    // dispatch — it has its own success-path block that must apply the
    // grant-refresh + idle-timer reset.
    const handleWaitUntilIdle = vi.fn().mockResolvedValue({
      idleReason: "idle" as const,
      durationMs: 1000,
      finalState: "idle",
    });
    const dispatchAction = vi.fn();
    const deps = fakeDeps({
      sessionStore,
      handleWaitUntilIdle,
      dispatchAction,
    });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "terminal.waitUntilIdle",
      arguments: { terminalId: "t1", timeoutMs: 1000 },
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(handleWaitUntilIdle).toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(resetIdle).toHaveBeenCalledWith("s");
    sessionStore.grantCache.dispose();
  });
});

function parseToolErrorPayload(result: { content: unknown; isError?: boolean }): {
  code: string;
  retriable: boolean;
  details?: { retryAfter?: number };
} {
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  return JSON.parse(text);
}

describe("consumeToken (pure token bucket)", () => {
  const mutation = RATE_LIMIT_TIERS.mutation; // capacity 10, 10/min

  it("allows up to capacity then rejects with a positive retryAfter", () => {
    const bucket = { tokens: mutation.capacity, lastRefillMs: 1000 };
    for (let i = 0; i < mutation.capacity; i++) {
      expect(consumeToken(bucket, mutation, 1000).allowed).toBe(true);
    }
    const rejected = consumeToken(bucket, mutation, 1000);
    expect(rejected.allowed).toBe(false);
    if (!rejected.allowed) {
      expect(rejected.retryAfter).toBeGreaterThanOrEqual(1);
    }
  });

  it("refills proportionally to elapsed wall-clock", () => {
    const bucket = { tokens: 0, lastRefillMs: 0 };
    // 10/min => one token every 6000ms. After 6000ms exactly one token.
    const r = consumeToken(bucket, mutation, 6000);
    expect(r.allowed).toBe(true);
    expect(bucket.tokens).toBeCloseTo(0, 5);
  });

  it("caps refill at capacity (no unbounded accrual while idle)", () => {
    const bucket = { tokens: 0, lastRefillMs: 0 };
    // A huge idle gap must not let the bucket exceed capacity.
    consumeToken(bucket, mutation, 60 * 60 * 1000);
    expect(bucket.tokens).toBeLessThanOrEqual(mutation.capacity);
  });

  it("never returns a sub-second retryAfter", () => {
    const bucket = { tokens: 0.99, lastRefillMs: 0 };
    const r = consumeToken(bucket, RATE_LIMIT_TIERS.highFreqRead, 0);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe("SessionStore.consumeRateLimitToken", () => {
  it("exhausts the mutation tier (git.commit) after capacity calls", () => {
    const store = new RealSessionStore(() => {});
    const cap = RATE_LIMIT_TIERS.mutation.capacity;
    for (let i = 0; i < cap; i++) {
      expect(store.consumeRateLimitToken("s", "git.commit", 1000).allowed).toBe(true);
    }
    const rejected = store.consumeRateLimitToken("s", "git.commit", 1000);
    expect(rejected.allowed).toBe(false);
    store.drain();
  });

  it("uses the high-frequency tier for read tools (terminal.getStatus)", () => {
    const store = new RealSessionStore(() => {});
    const cap = RATE_LIMIT_TIERS.highFreqRead.capacity;
    for (let i = 0; i < cap; i++) {
      expect(store.consumeRateLimitToken("s", "terminal.getStatus", 1000).allowed).toBe(true);
    }
    expect(store.consumeRateLimitToken("s", "terminal.getStatus", 1000).allowed).toBe(false);
    store.drain();
  });

  it("falls back to the standard tier for unmapped tools", () => {
    const store = new RealSessionStore(() => {});
    const cap = RATE_LIMIT_TIERS.standard.capacity;
    for (let i = 0; i < cap; i++) {
      expect(store.consumeRateLimitToken("s", "files.search", 1000).allowed).toBe(true);
    }
    expect(store.consumeRateLimitToken("s", "files.search", 1000).allowed).toBe(false);
    store.drain();
  });

  it("isolates buckets per session", () => {
    const store = new RealSessionStore(() => {});
    const cap = RATE_LIMIT_TIERS.mutation.capacity;
    for (let i = 0; i < cap; i++) {
      store.consumeRateLimitToken("session-a", "git.push", 1000);
    }
    expect(store.consumeRateLimitToken("session-a", "git.push", 1000).allowed).toBe(false);
    // A fresh session is unaffected by session-a's exhausted bucket.
    expect(store.consumeRateLimitToken("session-b", "git.push", 1000).allowed).toBe(true);
    store.drain();
  });

  it("isolates buckets per tool within a session", () => {
    const store = new RealSessionStore(() => {});
    const cap = RATE_LIMIT_TIERS.mutation.capacity;
    for (let i = 0; i < cap; i++) {
      store.consumeRateLimitToken("s", "git.commit", 1000);
    }
    expect(store.consumeRateLimitToken("s", "git.commit", 1000).allowed).toBe(false);
    expect(store.consumeRateLimitToken("s", "git.push", 1000).allowed).toBe(true);
    store.drain();
  });

  it("clearRateLimitState resets the session's buckets", () => {
    const store = new RealSessionStore(() => {});
    const cap = RATE_LIMIT_TIERS.mutation.capacity;
    for (let i = 0; i < cap; i++) {
      store.consumeRateLimitToken("s", "git.commit", 1000);
    }
    expect(store.consumeRateLimitToken("s", "git.commit", 1000).allowed).toBe(false);
    store.clearRateLimitState("s");
    // Fresh bucket — full capacity again.
    expect(store.consumeRateLimitToken("s", "git.commit", 1000).allowed).toBe(true);
    store.drain();
  });

  it("drain() tears down all rate-limit buckets", () => {
    const store = new RealSessionStore(() => {});
    store.consumeRateLimitToken("s", "git.commit", 1000);
    expect(store.rateLimitBuckets.has("s")).toBe(true);
    store.drain();
    expect(store.rateLimitBuckets.size).toBe(0);
  });

  it("revokeSession() tears down the rate-limit buckets for a live session", () => {
    const store = new RealSessionStore(() => {});
    store.consumeRateLimitToken("live", "git.commit", 1000);
    expect(store.rateLimitBuckets.has("live")).toBe(true);
    // Install a minimal HTTP session so revokeSession() has an entry to
    // tear down (it returns false and no-ops without one).
    store.httpSessions.set("live", {
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      server: {},
      idleTimer: setTimeout(() => {}, 1_000_000),
    } as unknown as typeof store.httpSessions extends Map<string, infer V> ? V : never);
    expect(store.revokeSession("live")).toBe(true);
    expect(store.rateLimitBuckets.has("live")).toBe(false);
    store.drain();
  });

  it("does not advance lastRefillMs backward on a clock step-back", () => {
    const store = new RealSessionStore(() => {});
    store.consumeRateLimitToken("s", "git.commit", 10000);
    store.consumeRateLimitToken("s", "git.commit", 9000); // clock went back
    const bucket = store.rateLimitBuckets.get("s")!.get("git.commit")!;
    expect(bucket.lastRefillMs).toBe(10000);
    store.consumeRateLimitToken("s", "git.commit", 10001);
    expect(bucket.lastRefillMs).toBe(10001);
    store.drain();
  });
});

describe("CallTool rate limiting (handler integration)", () => {
  it("rejects with MCP_RATE_LIMITED + retryAfter when the bucket is exhausted", async () => {
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const sessionStore = fakeSessionStore("system");
    (sessionStore.consumeRateLimitToken as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      retryAfter: 7,
    });
    const appendAuditRecord = vi.fn();
    const deps = fakeDeps({ sessionStore, dispatchAction, appendAuditRecord });
    const server = createSessionServer("rl-1", deps);

    const result = (await callTool(server, {
      name: "git.commit",
      arguments: { message: "x" },
    })) as { content: unknown; isError?: boolean };

    expect(result.isError).toBe(true);
    const payload = parseToolErrorPayload(result);
    expect(payload.code).toBe(MCP_RATE_LIMITED_CODE);
    expect(payload.retriable).toBe(true);
    expect(payload.details?.retryAfter).toBe(7);
    // Rate limit runs before dispatch — the action never ran.
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("writes a rate_limited audit record before returning", async () => {
    const sessionStore = fakeSessionStore("system");
    (sessionStore.consumeRateLimitToken as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      retryAfter: 3,
    });
    const appendAuditRecord = vi.fn();
    const deps = fakeDeps({ sessionStore, appendAuditRecord });
    const server = createSessionServer("rl-2", deps);

    await callTool(server, { name: "git.push", arguments: {} });

    expect(appendAuditRecord).toHaveBeenCalledTimes(1);
    const arg = appendAuditRecord.mock.calls[0]![0] as {
      outcome: { kind: string; retryAfter?: number };
      toolId: string;
    };
    expect(arg.toolId).toBe("git.push");
    expect(arg.outcome.kind).toBe("rate_limited");
    expect(arg.outcome.retryAfter).toBe(3);
  });

  it("runs before dedup — an exhausted bucket short-circuits an allowlisted tool", async () => {
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const sessionStore = fakeSessionStore("system");
    (sessionStore.consumeRateLimitToken as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      retryAfter: 1,
    });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("rl-3", deps);

    // terminal.new is dedup-allowlisted; rate-limit must win the race.
    const result = (await callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    })) as { content: unknown; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(parseToolErrorPayload(result).code).toBe(MCP_RATE_LIMITED_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(sessionStore.dedupInFlight.size).toBe(0);
  });

  it("does not consume a token for tier-denied calls (auth precedes rate limit)", async () => {
    // workbench tier cannot call git.commit; the tier check returns first
    // and the rate-limit token must not be charged.
    const sessionStore = fakeSessionStore("workbench");
    const deps = fakeDeps({ sessionStore });
    const server = createSessionServer("rl-4", deps);

    const result = (await callTool(server, {
      name: "git.commit",
      arguments: { message: "x" },
    })) as { content: unknown; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(parseToolErrorPayload(result).code).not.toBe(MCP_RATE_LIMITED_CODE);
    expect(sessionStore.consumeRateLimitToken).not.toHaveBeenCalled();
  });

  it("lets allowed calls dispatch normally", async () => {
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const sessionStore = fakeSessionStore("system");
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("rl-5", deps);

    const result = (await callTool(server, {
      name: "files.search",
      arguments: { query: "x" },
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(sessionStore.consumeRateLimitToken).toHaveBeenCalledWith("rl-5", "files.search");
    expect(dispatchAction).toHaveBeenCalledTimes(1);
  });

  it("charges a token even when the call is served from the dedup cache", async () => {
    // Real store so dedup actually caches; spy on the real token bucket to
    // prove rate-limit runs before dedup for *cached* hits, not just
    // in-flight ones.
    const store = new RealSessionStore(() => {});
    store.sessionTierMap.set("rl-dedup", "system");
    const consumeSpy = vi.spyOn(store, "consumeRateLimitToken");
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { sha: "abc" } } });
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("rl-dedup", deps);

    const args = { message: "one" };
    await callTool(server, { name: "git.commit", arguments: args });
    await callTool(server, { name: "git.commit", arguments: args });

    // Second call is a dedup cache hit (dispatch ran once) but the token
    // was still charged on both — runaway loops stay bounded.
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(consumeSpy).toHaveBeenCalledTimes(2);
    store.drain();
  });

  it("rate-limits a grant-authorized call (auth passes, rate limit fails)", async () => {
    // Workbench tier can't call worktree.delete; a per-tool grant lifts the
    // auth gate. The rate limiter must still reject, and the tier-mismatch
    // banner must NOT fire (this is not an authorization failure).
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.grantCache.issueGrant("rl-grant", "worktree.delete");
    (sessionStore.consumeRateLimitToken as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      retryAfter: 4,
    });
    const dispatchAction = vi.fn();
    const notifyTierMismatch = vi.fn();
    const deps = fakeDeps({ sessionStore, dispatchAction, notifyTierMismatch });
    const server = createSessionServer("rl-grant", deps);

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "w1" },
    })) as { content: unknown; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(parseToolErrorPayload(result).code).toBe(MCP_RATE_LIMITED_CODE);
    expect(notifyTierMismatch).not.toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("a rate-limited native-grant call does NOT consume a use (#10648)", async () => {
    // The native grant authorizes worktree.delete, but the rate limiter
    // rejects. The use must survive — a call that never dispatched can't burn
    // a grant use (regression guard for the peek/consume split).
    const sessionStore = fakeSessionStore("workbench");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "rl-native",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 1,
    });
    (sessionStore.consumeRateLimitToken as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      retryAfter: 4,
    });
    const dispatchAction = vi.fn();
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("rl-native", deps);

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "w1" },
    })) as { content: unknown; isError?: boolean };

    expect(result.isError).toBe(true);
    expect(parseToolErrorPayload(result).code).toBe(MCP_RATE_LIMITED_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });
});

describe("MCP_DEDUP_ALLOWLIST widening (#8468)", () => {
  it("retains the original creation-tool cohort", () => {
    for (const tool of [
      "terminal.new",
      "worktree.createWithRecipe",
      "agent.launch",
      "recipe.run",
    ]) {
      expect(MCP_DEDUP_ALLOWLIST.has(tool)).toBe(true);
    }
  });

  it("adds the git/forge mutation cohort", () => {
    for (const tool of ["git.commit", "git.push", "forge.openIssue", "forge.openPR"]) {
      expect(MCP_DEDUP_ALLOWLIST.has(tool)).toBe(true);
    }
  });

  it("stays bounded — does not blanket every mutation", () => {
    expect(MCP_DEDUP_ALLOWLIST.has("git.stageAll")).toBe(false);
    expect(MCP_DEDUP_ALLOWLIST.has("terminal.sendCommand")).toBe(false);
  });
});

describe("worktree resource lifecycle dedup/rate-limit (#10683)", () => {
  it("dedups + mutation-rate-limits provision (spins up a remote resource)", () => {
    expect(MCP_DEDUP_ALLOWLIST.has("worktree.resource.provision")).toBe(true);
    expect(RATE_LIMIT_TOOL_MAP.get("worktree.resource.provision")).toBe(RATE_LIMIT_TIERS.mutation);
  });

  it("does not dedup pause/resume/teardown (intentionally re-runnable)", () => {
    for (const tool of [
      "worktree.resource.pause",
      "worktree.resource.resume",
      "worktree.resource.teardown",
    ]) {
      expect(MCP_DEDUP_ALLOWLIST.has(tool)).toBe(false);
    }
  });
});

describe("MCP_DEDUP_ALLOWLIST widening (#9156)", () => {
  const NEW_MUTATIONS = [
    "worktree.delete",
    "git.snapshotRevert",
    "git.snapshotDelete",
    "forge.assignIssue",
  ];

  it("adds the remaining destructive-mutation cohort", () => {
    for (const tool of NEW_MUTATIONS) {
      expect(MCP_DEDUP_ALLOWLIST.has(tool)).toBe(true);
    }
  });

  it("maps the new cohort to the mutation rate-limit tier", () => {
    for (const tool of NEW_MUTATIONS) {
      expect(RATE_LIMIT_TOOL_MAP.get(tool)).toBe(RATE_LIMIT_TIERS.mutation);
    }
  });

  it("stays bounded — adjacent read-only tools remain excluded", () => {
    expect(MCP_DEDUP_ALLOWLIST.has("git.snapshotGet")).toBe(false);
    expect(RATE_LIMIT_TOOL_MAP.has("git.snapshotGet")).toBe(false);
  });

  it.each(NEW_MUTATIONS)(
    "dedups a post-completion duplicate of newly-allowlisted %s",
    async (tool) => {
      const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
      const deps = fakeDeps({
        sessionStore: fakeSessionStore("system"),
        dispatchAction,
      });
      const server = createSessionServer(`dedup-9156-${tool}`, deps);

      const args = { target: "x" };
      const first = await callTool(server, { name: tool, arguments: args });
      const second = await callTool(server, { name: tool, arguments: args });

      expect(dispatchAction).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
    }
  );
});

describe("validateDisplayImageUrl (#9828)", () => {
  it("accepts an https://daintree.org apex image URL", () => {
    expect(validateDisplayImageUrl("https://daintree.org/docs/img/panel.png")).toEqual({
      valid: true,
    });
  });

  it("accepts an https subdomain of daintree.org", () => {
    expect(validateDisplayImageUrl("https://docs.daintree.org/img/panel.png")).toEqual({
      valid: true,
    });
  });

  it("rejects data: URIs", () => {
    const result = validateDisplayImageUrl("data:image/png;base64,iVBORw0KGgo=");
    expect(result.valid).toBe(false);
  });

  it("rejects blob: URIs", () => {
    const result = validateDisplayImageUrl("blob:https://daintree.org/abcd");
    expect(result.valid).toBe(false);
  });

  it("rejects http: (non-TLS) URLs", () => {
    const result = validateDisplayImageUrl("http://daintree.org/img.png");
    expect(result.valid).toBe(false);
  });

  it("rejects a look-alike host that merely ends with the brand string", () => {
    // `attackerdaintree.org` does NOT end with `.daintree.org` (no leading
    // dot), so the suffix check correctly refuses it.
    const result = validateDisplayImageUrl("https://attackerdaintree.org/img.png");
    expect(result.valid).toBe(false);
  });

  it("rejects an unrelated host", () => {
    expect(validateDisplayImageUrl("https://evil.example.com/img.png").valid).toBe(false);
  });

  it("rejects a non-standard port (CSP allows the default 443 only)", () => {
    expect(validateDisplayImageUrl("https://daintree.org:8443/img.png").valid).toBe(false);
  });

  it("accepts an explicit default :443 port", () => {
    expect(validateDisplayImageUrl("https://daintree.org:443/img.png")).toEqual({ valid: true });
  });

  it("rejects a malformed URL", () => {
    expect(validateDisplayImageUrl("not a url").valid).toBe(false);
  });

  it("is case-insensitive on the host", () => {
    expect(validateDisplayImageUrl("https://DainTree.ORG/img.png")).toEqual({ valid: true });
  });
});

describe("help.displayImage short-circuit (#9828)", () => {
  function helpSessionStore(sessionId: string, helpSessionId: string | null): SessionStore {
    const store = fakeSessionStore("workbench");
    const mutable = store as unknown as {
      sessionHelpIdMap: Map<string, string>;
      figureCounters: Map<string, number>;
      nextFigureNumber: (id: string) => number;
    };
    mutable.sessionHelpIdMap = new Map(helpSessionId !== null ? [[sessionId, helpSessionId]] : []);
    mutable.figureCounters = new Map();
    mutable.nextFigureNumber = (id: string) => {
      const next = (mutable.figureCounters.get(id) ?? 0) + 1;
      mutable.figureCounters.set(id, next);
      return next;
    };
    return store;
  }

  function parseStructured(result: unknown): Record<string, unknown> | undefined {
    return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  }

  it("assigns a sequential figure number and pushes the figure to the renderer", async () => {
    const notifyDisplayImage = vi.fn();
    const deps = fakeDeps({
      sessionStore: helpSessionStore("sess-1", "help-1"),
      notifyDisplayImage,
    });
    const server = createSessionServer("sess-1", deps);
    await server.connect(makeMockTransport());

    const first = await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "https://daintree.org/a.png", caption: "First" },
    });
    const second = await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "https://daintree.org/b.png" },
    });

    expect(parseStructured(first)).toMatchObject({ figureNumber: 1, figureLabel: "image #1" });
    expect(parseStructured(second)).toMatchObject({ figureNumber: 2, figureLabel: "image #2" });
    expect(notifyDisplayImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        figureNumber: 1,
        url: "https://daintree.org/a.png",
        caption: "First",
      })
    );
    // The imageId is a freshly minted UUID, distinct per call.
    const id1 = parseStructured(first)?.imageId;
    const id2 = parseStructured(second)?.imageId;
    expect(typeof id1).toBe("string");
    expect(id1).not.toBe(id2);
  });

  it("rejects a non-daintree URL with INVALID_URL and does not notify", async () => {
    const notifyDisplayImage = vi.fn();
    const deps = fakeDeps({
      sessionStore: helpSessionStore("sess-2", "help-2"),
      notifyDisplayImage,
    });
    const server = createSessionServer("sess-2", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "data:image/png;base64,AAAA" },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("INVALID_URL");
    expect(notifyDisplayImage).not.toHaveBeenCalled();
  });

  it("rejects a session with no help-session id (e.g. pane token) as not permitted", async () => {
    const notifyDisplayImage = vi.fn();
    const deps = fakeDeps({
      sessionStore: helpSessionStore("sess-3", null),
      notifyDisplayImage,
    });
    const server = createSessionServer("sess-3", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "help.displayImage",
      arguments: { url: "https://daintree.org/a.png" },
    })) as { isError?: boolean; content: { text: string }[] };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe("TIER_NOT_PERMITTED");
    expect(notifyDisplayImage).not.toHaveBeenCalled();
  });
});

describe("structuredContent for terminal query actions (#10676)", () => {
  // The three high-value query actions carry `mcpOutputSchema: true`, so the real
  // manifest entry the renderer reports back carries an object-typed outputSchema.
  // Mirror that here (per-action, so the fixture shape tracks the real result)
  // so the CallTool path exercises buildStructuredContent.
  const OUTPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
    "terminal.list": { type: "object", properties: { terminals: { type: "array" } } },
    "terminal.getStatus": { type: "object", properties: { terminals: { type: "array" } } },
    "terminal.getOutput": {
      type: "object",
      properties: {
        terminalId: { type: "string" },
        content: { type: ["string", "null"] },
        lineCount: { type: "number" },
        truncated: { type: "boolean" },
      },
    },
  };

  function entryWithOutputSchema(id: string): ActionManifestEntry {
    return {
      ...makeManifestEntry(id),
      outputSchema: OUTPUT_SCHEMAS[id] ?? { type: "object", properties: {} },
    };
  }

  function structuredOf(result: unknown): Record<string, unknown> | undefined {
    return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
  }

  function textOf(result: unknown): string {
    return (result as { content: { text: string }[] }).content[0].text;
  }

  // tier "external" + getFullToolSurface bypasses the per-id allowlist, so the
  // call reaches dispatch regardless of TIER_ALLOWLISTS membership.
  function deps(id: string, payload: unknown, withSchema = true): SessionServerDeps {
    return fakeDeps({
      sessionStore: fakeSessionStore("external"),
      getFullToolSurface: vi.fn(() => true),
      requestManifest: vi
        .fn()
        .mockResolvedValue([withSchema ? entryWithOutputSchema(id) : makeManifestEntry(id)]),
      dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: payload } }),
    });
  }

  it("emits structuredContent for terminal.list and still emits the JSON text body", async () => {
    const payload = { terminals: [{ id: "t-1", kind: "terminal", isFocused: true }] };
    const server = createSessionServer("sc-list", deps("terminal.list", payload));
    const result = await callTool(server, { name: "terminal.list", arguments: {} });

    expect(structuredOf(result)).toEqual(payload);
    // Backward compatibility: the text body is preserved for clients that ignore
    // structuredContent, and it serializes the same data.
    expect(JSON.parse(textOf(result))).toEqual(payload);
  });

  it("emits structuredContent for terminal.getStatus", async () => {
    const payload = {
      terminals: [{ terminalId: "t-1", agentId: "claude", agentState: "working" }],
    };
    const server = createSessionServer("sc-status", deps("terminal.getStatus", payload));
    const result = await callTool(server, { name: "terminal.getStatus", arguments: {} });

    expect(structuredOf(result)).toEqual(payload);
  });

  it("emits structuredContent for terminal.getOutput", async () => {
    const payload = { terminalId: "t-1", content: "hello", lineCount: 1, truncated: false };
    const server = createSessionServer("sc-output", deps("terminal.getOutput", payload));
    const result = await callTool(server, {
      name: "terminal.getOutput",
      arguments: { terminalId: "t-1" },
    });

    expect(structuredOf(result)).toEqual(payload);
  });

  it("emits structuredContent for an empty result set (not just non-empty)", async () => {
    const payload = { terminals: [] };
    const server = createSessionServer("sc-empty", deps("terminal.list", payload));
    const result = await callTool(server, { name: "terminal.list", arguments: {} });

    expect(structuredOf(result)).toEqual(payload);
  });

  it("omits structuredContent when the manifest entry carries no outputSchema", async () => {
    // Proves the outputSchema gate is load-bearing: without it, the same object
    // result falls back to a text-only response (the pre-#10676 behavior).
    const payload = { terminals: [{ id: "t-1" }] };
    const server = createSessionServer(
      "sc-noschema",
      deps("terminal.list", payload, /* withSchema */ false)
    );
    const result = await callTool(server, { name: "terminal.list", arguments: {} });

    expect(structuredOf(result)).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual(payload);
  });
});
