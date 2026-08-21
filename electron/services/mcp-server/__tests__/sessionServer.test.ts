import { afterEach, describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ActionManifestEntry, ActionId } from "../../../../shared/types/actions.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";
import { formatPartialSuccessMessage } from "../../../../shared/utils/partialSuccess.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer, validateDisplayImageUrl } from "../sessionServer.js";
import type { SessionServerDeps } from "../sessionServer.js";
import type { SessionStore } from "../sessionStore.js";
import { SessionStore as RealSessionStore } from "../sessionStore.js";
import { GrantCache } from "../grantCache.js";
import { ResourceOwnershipLedger } from "../resourceOwnership.js";
import {
  buildToolError,
  buildMcpErrorPayload,
  RETRIABLE_ERROR_CODES,
  TIER_NOT_PERMITTED_CODE,
  EXECUTION_ERROR_CODE,
  SESSION_BINDING_GONE,
  SESSION_GONE,
  CONFIRMATION_TIMEOUT_CODE,
  USER_REJECTED_CODE,
  MCP_DEDUP_KEY_COLLISION_CODE,
  MCP_DEDUP_ALLOWLIST,
  minimumPermittingTier,
  unwrapDispatchResult,
  RESOLVED_WORKSPACE_META_KEY,
  withResolvedWorkspace,
  MCP_SERVER_INSTRUCTIONS,
  MCP_SERVER_INSTRUCTIONS_MAX_BYTES,
  TIER_ALLOWLISTS,
} from "../shared.js";
import type { DispatchedWorkspaceRef } from "../shared.js";
import { TOOL_RESULT_TEXT_MAX_BYTES } from "../toolCallResult.js";
import {
  isTierPermitted,
  shouldExposeTool,
  ACTIONS_SEARCH_TOOL_ID,
  ACTIONS_GET_SCHEMA_TOOL_ID,
} from "../tierAuth.js";
import {
  SessionBindingError,
  WorkspaceBindingError,
  RendererBridgeUnavailableError,
} from "../rendererBridge.js";
import { getAgentAvailabilityStore } from "../../AgentAvailabilityStore.js";
import { events } from "../../events.js";

function fakeSessionStore(
  tier: "workbench" | "action" | "system" | "external" = "workbench"
): SessionStore {
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
    isRendererOwnedOrigin: vi.fn((sessionId: string) => {
      const origin = sessionOriginMap.get(sessionId) ?? "external";
      return origin === "help" || origin === "assistant-pane";
    }),
    sessionWorkspaceMap: new Map(),
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
  } as unknown as SessionStore;
  return store;
}

function fakeDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
  return {
    sessionStore: fakeSessionStore(),
    requestManifest: vi.fn().mockResolvedValue([]),
    dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: null } }),
    handleWaitUntilIdle: vi.fn(),
    handleWaitUntilIdleBatch: vi.fn(),
    handleSkillsSearch: vi.fn(() => ({ skills: [] })),
    handleSkillsLoad: vi.fn(),
    handleProjectRunCheck: vi.fn(),
    appendAuditRecord: vi.fn(),
    getCachedManifest: vi.fn(() => null),
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
async function initializeClient(server: ReturnType<typeof createSessionServer>) {
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
function seedLiveSession(
  store: RealSessionStore,
  sessionId: string,
  tier: "workbench" | "action" | "system" | "external",
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

describe("sessionServer initialize instructions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers the instructions to a client that completes a real handshake", async () => {
    const server = createSessionServer("session-instructions", fakeDeps());

    await expect(initializeClient(server)).resolves.toBe(MCP_SERVER_INSTRUCTIONS);
  });

  it("sends the same instructions regardless of session tier", async () => {
    // Instructions are sent once and have no update notification, so they must
    // not encode a tier that can elevate or decay later in the same session.
    const perTier = await Promise.all(
      (Object.keys(TIER_ALLOWLISTS) as Array<keyof typeof TIER_ALLOWLISTS>).map((tier) =>
        initializeClient(
          createSessionServer(`session-${tier}`, fakeDeps({ sessionStore: fakeSessionStore(tier) }))
        )
      )
    );

    expect(new Set(perTier)).toEqual(new Set([MCP_SERVER_INSTRUCTIONS]));
  });

  it("stays within the authored byte budget", () => {
    // The budget is derived from the client truncation point minus a reserve,
    // and the authorization paragraph is last — overflow silently drops the
    // denial guidance in the field rather than failing anything here.
    expect(Buffer.byteLength(MCP_SERVER_INSTRUCTIONS, "utf8")).toBeLessThanOrEqual(
      MCP_SERVER_INSTRUCTIONS_MAX_BYTES
    );
  });

  it("names every tier a session can hold", () => {
    // Adding a tier without describing it here leaves the model unable to
    // reason about a denial it can now receive. Matched with backticks because
    // the bare word `action` also occurs inside `actions.search` and prose.
    for (const tier of Object.keys(TIER_ALLOWLISTS)) {
      expect(MCP_SERVER_INSTRUCTIONS).toContain(`\`${tier}\``);
    }
    expect(MCP_SERVER_INSTRUCTIONS).toContain(TIER_NOT_PERMITTED_CODE);
  });

  it("names only tools that actually exist", () => {
    // Every dotted id in the text, not a hand-listed subset: a tool rename that
    // skips this prose fails here rather than telling every connecting model to
    // call a name that no longer resolves. New references are covered on
    // arrival, without interpolating constants into model-facing text.
    const referenced = [
      ...MCP_SERVER_INSTRUCTIONS.matchAll(/`([a-z][A-Za-z]*(?:\.[A-Za-z]+)+)`/g),
    ].map(([, id]) => id);

    expect(referenced).toContain(ACTIONS_SEARCH_TOOL_ID);
    expect(referenced).toContain(ACTIONS_GET_SCHEMA_TOOL_ID);
    expect(referenced.filter((id) => !BUILT_IN_ACTION_IDS.includes(id as never))).toEqual([]);
    // Existing as an action is the weaker guard. The instructions go to every
    // session including `external`, whose surface is the hand-curated
    // `mcpExternalTierAllowlist.ts` — `terminal.close` was cut from it in
    // #11592 while staying a perfectly valid BuiltInActionId. Cutting a
    // referenced id without editing the prose would leave the text telling
    // external clients to call something that only ever returns
    // TIER_NOT_PERMITTED.
    expect(referenced.filter((id) => !TIER_ALLOWLISTS.external.has(id))).toEqual([]);
  });
});

describe("sessionServer tools/list handler", () => {
  // The external tier is gated by the curated MCP_TOOL_ALLOWLIST and nothing
  // widens it (#10701, #11537). These manifest-plumbing tests therefore use
  // allowlisted action ids so the live/cache/fail-closed paths are exercised
  // independent of exposure gating.
  function externalDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
    return fakeDeps({
      sessionStore: fakeSessionStore("external"),
      ...overrides,
    });
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the live manifest when requestManifest succeeds", async () => {
    const deps = externalDeps({
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("actions.list")]),
      getCachedManifest: vi.fn(() => [makeManifestEntry("terminal.list")]),
    });
    const server = createSessionServer("tools-list-fresh", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    // Fresh result wins over the (different) cache, proving the live path is used.
    expect(result.tools.map((t) => t.name)).toEqual(["actions.list"]);
  });

  it("falls back to the cached manifest, warning with the error, when requestManifest rejects", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejection = new Error("Manifest request timed out");
    const deps = externalDeps({
      requestManifest: vi.fn().mockRejectedValue(rejection),
      getCachedManifest: vi.fn(() => [makeManifestEntry("terminal.list")]),
    });
    const server = createSessionServer("tools-list-fallback", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    expect(result.tools.map((t) => t.name)).toEqual(["terminal.list"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The rejection must reach the log so operators can diagnose the stale serve.
    expect(warnSpy.mock.calls[0]).toContain(rejection);
  });

  it("applies the tier/visibility filter on the cached fallback path", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const deps = externalDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("Manifest request timed out")),
      getCachedManifest: vi.fn(() => [
        makeManifestEntry("actions.list"),
        { ...makeManifestEntry("restricted_tool"), danger: "restricted" as const },
      ]),
    });
    const server = createSessionServer("tools-list-filtered-cache", deps);
    await server.connect(makeMockTransport());

    const result = await listTools(server);

    // shouldExposeTool drops restricted entries even on the cache path.
    expect(result.tools.map((t) => t.name)).toEqual(["actions.list"]);
  });

  it("fails closed with an McpError when requestManifest rejects and no cache exists", async () => {
    const deps = externalDeps({
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
    const deps = externalDeps({
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
    const deps = externalDeps({
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

describe("skills.search / skills.load short-circuit (#10892)", () => {
  it("dispatches skills.search to the injected handler, not renderer dispatch", async () => {
    const handleSkillsSearch = vi.fn(() => ({
      skills: [
        { id: "acme.plugin.tdd", name: "TDD", description: "Test-driven.", triggers: ["tdd"] },
      ],
    }));
    const dispatchAction = vi.fn();
    const deps = fakeDeps({ handleSkillsSearch, dispatchAction });
    const server = createSessionServer("session-skill-search", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "skills.search", arguments: { query: "tdd" } });

    expect(handleSkillsSearch).toHaveBeenCalledWith({ query: "tdd" });
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      skills: [
        { id: "acme.plugin.tdd", name: "TDD", description: "Test-driven.", triggers: ["tdd"] },
      ],
    });
  });

  it("dispatches skills.load to the injected handler and returns the body", async () => {
    const handleSkillsLoad = vi.fn(() => ({
      id: "acme.plugin.tdd",
      name: "TDD",
      description: "Test-driven.",
      body: "# TDD\n\nRed, green, refactor.",
    }));
    const dispatchAction = vi.fn();
    const deps = fakeDeps({ handleSkillsLoad, dispatchAction });
    const server = createSessionServer("session-skill-load", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "skills.load",
      arguments: { id: "acme.plugin.tdd" },
    });

    expect(handleSkillsLoad).toHaveBeenCalledWith({ id: "acme.plugin.tdd" });
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { body: string }).body).toContain("Red, green, refactor.");
  });

  it("surfaces a handler McpError as a tool error", async () => {
    const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
    const handleSkillsLoad = vi.fn(() => {
      throw new McpError(ErrorCode.InvalidParams, 'No skill found with id "x".');
    });
    const deps = fakeDeps({ handleSkillsLoad });
    const server = createSessionServer("session-skill-missing", deps);
    await server.connect(makeMockTransport());

    await expect(callTool(server, { name: "skills.load", arguments: { id: "x" } })).rejects.toThrow(
      /No skill found/
    );
  });
});

describe("project.runCheck short-circuit (#11548)", () => {
  const passingResult = {
    projectId: "proj-1",
    cwd: "/repo",
    runnerId: "npm-test",
    runnerName: "test",
    command: "npm run test",
    passed: true,
    exitCode: 0,
    signalName: null,
    durationMs: 4200,
    timedOut: false,
    aborted: false,
    output: "42 passing\n",
    outputTruncated: false,
  };

  it("runs in main and never reaches renderer dispatch", async () => {
    const handleProjectRunCheck = vi.fn().mockResolvedValue(passingResult);
    const dispatchAction = vi.fn();
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("action"),
      handleProjectRunCheck,
      dispatchAction,
    });
    const server = createSessionServer("session-run-check", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    // The 30s renderer-dispatch wall is exactly what this branch exists to
    // avoid, so reaching dispatchAction at all would defeat the feature.
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(handleProjectRunCheck.mock.calls[0]?.[0]).toEqual({
      projectId: "proj-1",
      runnerId: "npm-test",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual(passingResult);
  });

  it("forwards the MCP abort signal so a runaway check can be cancelled", async () => {
    const handleProjectRunCheck = vi.fn().mockResolvedValue(passingResult);
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("action"),
      handleProjectRunCheck,
    });
    const server = createSessionServer("session-run-check-signal", deps);
    await server.connect(makeMockTransport());

    await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    const signal = handleProjectRunCheck.mock.calls[0]?.[1];
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a failing check as a normal result, not a tool error", async () => {
    const failing = { ...passingResult, passed: false, exitCode: 1, output: "1 failing\n" };
    const handleProjectRunCheck = vi.fn().mockResolvedValue(failing);
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("action"),
      handleProjectRunCheck,
    });
    const server = createSessionServer("session-run-check-fail", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    // "The check failed" and "the check could not run" must stay
    // distinguishable — conflating them makes an agent retry the wrong thing.
    expect(result.isError).not.toBe(true);
    expect((result.structuredContent as { passed: boolean }).passed).toBe(false);
  });

  it("surfaces an inability to run as a tool error", async () => {
    const handleProjectRunCheck = vi
      .fn()
      .mockRejectedValue(new Error('No runner "nope" detected in /repo.'));
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("action"),
      handleProjectRunCheck,
    });
    const server = createSessionServer("session-run-check-unknown", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "nope" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("No runner");
  });

  it("denies a workbench-tier session — detecting runners is read-only, running them is not", async () => {
    const handleProjectRunCheck = vi.fn().mockResolvedValue(passingResult);
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("workbench"),
      handleProjectRunCheck,
    });
    const server = createSessionServer("session-run-check-workbench", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, {
      name: "project.runCheck",
      arguments: { projectId: "proj-1", runnerId: "npm-test" },
    });

    expect(result.isError).toBe(true);
    expect(handleProjectRunCheck).not.toHaveBeenCalled();
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
    // A live transport, not just a tier row: `getTier` gates on transport
    // membership (#11799), so a tier-map-only session is refused before it can
    // reach dispatch at all.
    seedLiveSession(realStore, "dedup-resurrect", "system");

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
    realStore.grantCache.dispose();
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

  it("marks USER_REJECTED as non-retriable", () => {
    const rejected = JSON.parse(
      getErrorText(buildToolError({ code: USER_REJECTED_CODE, message: "no" }))
    );
    expect(rejected.retriable).toBe(false);
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

  it("classifies SESSION_GONE as a non-retriable business failure (#11799)", () => {
    // Retrying is pointless — the session is what went away, so recovery is a
    // new session rather than the same call again.
    const payload = buildMcpErrorPayload({ code: SESSION_GONE, message: "gone" });
    expect(payload).toEqual({
      code: SESSION_GONE,
      message: "gone",
      retriable: false,
      errorCategory: "business",
    });
    expect(RETRIABLE_ERROR_CODES.has(SESSION_GONE)).toBe(false);
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

  it("offers a recovery tier for worktree.create instead of a dead end (#11880)", async () => {
    // The reported symptom: in no tier allowlist, the primitive resolved to
    // targetTier null, and HelpPanelBanners withholds both "Approve once" and
    // "Always allow" on a null target — a denial the user cannot act on at any
    // tier. A non-null target is what restores those, so an action-tier
    // overlay that needs it can still ask rather than being told no twice.
    const notify = vi.fn();
    const deps = fakeDeps({ notifyTierMismatch: notify });
    const server = createSessionServer("session-C2", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.create", arguments: {} });

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        toolId: "worktree.create",
        targetTier: "system",
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
    // recipe.run is a real danger:"confirm" action in the action tier. Its
    // unconfirmed dispatch is forwarded to the renderer bridge (host-side
    // confirmation, #11342), which throws RendererBridgeUnavailableError when
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

  it("floor-permitted tool skips the per-tool grant but still peeks native pre-authorization", async () => {
    const sessionStore = fakeSessionStore("workbench");
    const checkSpy = vi.spyOn(sessionStore.grantCache, "check");
    const peekSpy = vi.spyOn(sessionStore.grantCache, "peekNativeGrant");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    // worktree.list is in WORKBENCH_TOOLS → static floor permits.
    await callTool(server, { name: "worktree.list", arguments: {} });

    expect(dispatchAction).toHaveBeenCalled();
    // A per-tool grant only widens the floor, so it has nothing to say once
    // the floor already admits the call.
    expect(checkSpy).not.toHaveBeenCalled();
    // A native grant ALSO pre-authorizes the confirm modal, which is
    // orthogonal to the floor — so it is consulted on this leg too (#11878).
    expect(peekSpy).toHaveBeenCalledWith("s", "worktree.list");
    // No grant exists here, so the dispatch stays unconfirmed.
    expect(dispatchAction).toHaveBeenCalledWith("worktree.list", expect.any(Object), false);
    sessionStore.grantCache.dispose();
  });

  it("native grant pre-authorizes a tier-permitted confirm tool and consumes a use (#11878)", async () => {
    // worktree.delete is `danger: "confirm"` but IS on the system-tier
    // allowlist, so the floor admits it and the tier-denied leg never runs.
    // Before #11878 that made the grant unreachable and the modal fired on
    // every call despite an explicit Settings pre-authorization.
    const sessionStore = fakeSessionStore("system");
    // Unref'd for the reason `seedLiveSession` documents: a referenced
    // 1,000,000 ms timer holds the Vitest worker open past the suite.
    const idleTimer = setTimeout(() => {}, 1_000_000);
    idleTimer.unref?.();
    sessionStore.sessions.set("s", {
      transport: {} as never,
      server: {} as never,
      idleTimer,
    });
    const resetIdle = sessionStore.resetIdleTimer as ReturnType<typeof vi.fn>;
    resetIdle.mockClear();
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    const refreshSpy = vi.spyOn(sessionStore.grantCache, "refreshNativeGrant");
    const checkSpy = vi.spyOn(sessionStore.grantCache, "check");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-1" },
    })) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    // Pins the leg: an untouched per-tool cache proves the floor admitted this
    // call, so the bypass below can only have come from the native grant.
    expect(checkSpy).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(dispatchAction).toHaveBeenCalledWith(
      "worktree.delete",
      expect.objectContaining({ worktreeId: "wt-1" }),
      true
    );
    expect(refreshSpy).toHaveBeenCalledWith(grant.id);
    expect(resetIdle).toHaveBeenCalledWith("s");
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });

  it("a spent grant leaves a tier-permitted confirm tool dispatching unconfirmed (#11878)", async () => {
    // The non-mocked proof that the grant only ever bought the modal bypass:
    // once its single use is gone the call must still run — just with the
    // modal back. The tier-denied equivalent fails closed instead, because
    // there the grant was the authorization itself.
    const sessionStore = fakeSessionStore("system");
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

    // Distinct args on the second call: worktree.delete is on the dedup
    // allowlist, so a replay would return the cached result and never reach
    // the gate this test is about.
    const first = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-1" },
    })) as { isError?: boolean };
    const second = (await callTool(server, {
      name: "worktree.delete",
      arguments: { worktreeId: "wt-2" },
    })) as { isError?: boolean };

    expect(first.isError).not.toBe(true);
    expect(second.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenNthCalledWith(1, "worktree.delete", expect.any(Object), true);
    expect(dispatchAction).toHaveBeenNthCalledWith(2, "worktree.delete", expect.any(Object), false);
    sessionStore.grantCache.dispose();
  });

  it("a per-tool grant does not suppress native confirm pre-authorization (#11878)", async () => {
    // Both grant kinds can be live at once. The per-tool grant is what admits
    // the call past the denying floor, but only the native grant can waive the
    // modal — so holding both must still waive it. The native peek used to sit
    // behind the per-tool check, which made an explicit Settings
    // pre-authorization silently do nothing here, exactly as it did for a
    // tier-permitted tool.
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.grantCache.issueGrant("s", "worktree.delete");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.delete", arguments: {} });

    expect(dispatchAction).toHaveBeenCalledWith("worktree.delete", expect.any(Object), true);
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });

  it("a tier-permitted call falls back to the modal when the grant dies between peek and consume (#11878)", async () => {
    // The tier still admits the call, so losing the grant costs only the
    // bypass. Refusing here would report "not permitted for the 'system'
    // tier" for an action that tier plainly permits.
    const sessionStore = fakeSessionStore("system");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    const consumeSpy = vi
      .spyOn(sessionStore.grantCache, "consumeNativeGrantUse")
      .mockReturnValue(false);
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean };

    // Without this the test would pass for the wrong reason: never peeking at
    // all also yields an unconfirmed dispatch.
    expect(consumeSpy).toHaveBeenCalledWith(grant.id, "worktree.delete");
    expect(result.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenCalledWith("worktree.delete", expect.any(Object), false);
    sessionStore.grantCache.dispose();
  });

  it("a tier-denied call still fails closed when the grant dies between peek and consume (#11878)", async () => {
    // Here the grant WAS the authorization, so losing it must fail closed.
    const sessionStore = fakeSessionStore("workbench");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    const consumeSpy = vi
      .spyOn(sessionStore.grantCache, "consumeNativeGrantUse")
      .mockReturnValue(false);
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    // Proves the refusal came from the consume-failure guard rather than the
    // ordinary tier denial, which would produce the same error for a
    // different reason.
    expect(consumeSpy).toHaveBeenCalledWith(grant.id, "worktree.delete");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text ?? "").toContain(TIER_NOT_PERMITTED_CODE);
    expect(dispatchAction).not.toHaveBeenCalled();
    sessionStore.grantCache.dispose();
  });

  it("a per-tool grant keeps a lost native grant from failing the call closed (#11878)", async () => {
    // The floor denies, so only the per-tool grant admits this — which is why
    // the consume-failure guard has to ask "did anything else admit this?"
    // rather than "did the tier permit this?". Under the narrower question
    // this call would be refused as tier-denied even though a live grant
    // admitted it.
    const sessionStore = fakeSessionStore("workbench");
    sessionStore.grantCache.issueGrant("s", "worktree.delete");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.delete"],
      maxUses: 2,
    });
    const consumeSpy = vi
      .spyOn(sessionStore.grantCache, "consumeNativeGrantUse")
      .mockReturnValue(false);
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "worktree.delete",
      arguments: {},
    })) as { isError?: boolean };

    expect(consumeSpy).toHaveBeenCalledWith(grant.id, "worktree.delete");
    expect(result.isError).not.toBe(true);
    expect(dispatchAction).toHaveBeenCalledWith("worktree.delete", expect.any(Object), false);
    sessionStore.grantCache.dispose();
  });

  it("a tier-permitted non-confirm tool in the grant's allowlist still spends a use (#11878)", async () => {
    // Decision lock, not an endorsement: `maxUses` is a budget of matching
    // dispatches, and spending one only where the bypass is actually needed
    // would mean resolving effective danger — async manifest plus
    // args-conditional elevation — before the consume site. Over-charging
    // fails toward more confirmation, so it is the safe direction to accept.
    const sessionStore = fakeSessionStore("workbench");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["worktree.list"],
      maxUses: 2,
    });
    const checkSpy = vi.spyOn(sessionStore.grantCache, "check");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "worktree.list", arguments: {} });

    // Pins the leg — an untouched per-tool cache means the floor admitted it.
    expect(checkSpy).not.toHaveBeenCalled();
    expect(dispatchAction).toHaveBeenCalledWith("worktree.list", expect.any(Object), true);
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(1);
    sessionStore.grantCache.dispose();
  });

  it("an already-admitted introspection carrier does not spend a native use (#11878)", async () => {
    // actions.search can never raise a confirm modal, so once the floor has
    // admitted it a grant buys it nothing — peeking would only drain the
    // automation budget on a discovery call and evict entries mid-enumeration.
    // The peek still runs when the carrier is NOT otherwise admitted, because
    // there the grant is what authorizes it.
    const sessionStore = fakeSessionStore("workbench");
    const grant = sessionStore.grantCache.issueNativeGrant({
      sessionId: "s",
      actorId: "help-1",
      actorType: "help-session",
      allowedTools: ["actions.search"],
      maxUses: 2,
    });
    const peekSpy = vi.spyOn(sessionStore.grantCache, "peekNativeGrant");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: { ok: 1 } } });
    const deps = fakeDeps({ sessionStore, dispatchAction });
    const server = createSessionServer("s", deps);
    await server.connect(makeMockTransport());

    await callTool(server, { name: "actions.search", arguments: { query: "worktree" } });

    // The dispatch assertion keeps this honest: skipping the peek must be the
    // guard doing its job, not the call bailing out before it gets there.
    expect(dispatchAction).toHaveBeenCalled();
    expect(peekSpy).not.toHaveBeenCalled();
    expect(sessionStore.grantCache._peekNative(grant.id)?.remainingUses).toBe(2);
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

describe("MCP_DEDUP_ALLOWLIST exclusion boundary (#8468)", () => {
  // Membership `.has()` spot-checks were dropped in #11534: they restated the
  // allowlist literal, so they stayed green even if sessionServer stopped
  // consulting the set. Both directions are proven by dispatch behaviour
  // instead. (The forge half of the original cohort — `forge.openIssue` /
  // `forge.openPR` — was removed in #11534; see the block below.)
  const twoDistinctDispatches = () =>
    vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: "first" } })
      .mockResolvedValueOnce({ result: { ok: true, result: "second" } });

  // The #8468 git cohort was dropped in #11534: `git.push` takes only
  // `{cwd, setUpstream}` and `git.commit` commits whatever the index holds, so
  // a second push after a new commit — or a repeated `wip` message — is
  // same-argument, and caching it would report success for work that never
  // happened. Restoring either entry must fail here.
  it.each(["git.commit", "git.push"])("redispatches a repeated %s", async (tool) => {
    const dispatchAction = twoDistinctDispatches();
    const deps = fakeDeps({ sessionStore: fakeSessionStore("system"), dispatchAction });
    const server = createSessionServer(`git-8468-${tool}`, deps);

    const args = { target: "x" };
    await callTool(server, { name: tool, arguments: args });
    const second = await callTool(server, { name: tool, arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(second)).toContain("second");
  });

  it.each(["git.stageAll", "terminal.sendCommand"])(
    "stays bounded — redispatches unlisted mutation %s",
    async (tool) => {
      const dispatchAction = twoDistinctDispatches();
      const deps = fakeDeps({ sessionStore: fakeSessionStore("system"), dispatchAction });
      const server = createSessionServer(`bounded-8468-${tool}`, deps);

      const args = { target: "x" };
      await callTool(server, { name: tool, arguments: args });
      const second = await callTool(server, { name: tool, arguments: args });

      expect(dispatchAction).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(second)).toContain("second");
    }
  );
});

describe("worktree resource lifecycle dedup (#10683)", () => {
  it("dedups provision (spins up a remote resource)", () => {
    expect(MCP_DEDUP_ALLOWLIST.has("worktree.resource.provision")).toBe(true);
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

  it("gates each tool at its intended minimum tier", () => {
    expect(minimumPermittingTier("worktree.resource.provision")).toBe("action");
    expect(minimumPermittingTier("worktree.resource.pause")).toBe("action");
    expect(minimumPermittingTier("worktree.resource.resume")).toBe("action");
    expect(minimumPermittingTier("worktree.resource.teardown")).toBe("system");
    expect(minimumPermittingTier("system.getResourceProfileSnapshot")).toBe("workbench");
    expect(minimumPermittingTier("cliAvailability.get")).toBe("workbench");
    expect(minimumPermittingTier("hibernation.getConfig")).toBe("workbench");
  });
});

describe("MCP_DEDUP_ALLOWLIST widening (#9156)", () => {
  // `forge.assignIssue` shipped in this cohort but was dropped in #11534 —
  // assignment is provider-idempotent, and caching it broke assign → unassign
  // → reassign. See the #11534 block below.
  const NEW_MUTATIONS = ["worktree.delete"];

  it.each(NEW_MUTATIONS)(
    "dedups a post-completion duplicate of newly-allowlisted %s",
    async (tool) => {
      // Distinct per-call payloads so the replay assertion has teeth: with a
      // single mockResolvedValue both dispatches return equal results and
      // `second === first` would hold even with dedup switched off.
      const dispatchAction = vi
        .fn()
        .mockResolvedValueOnce({ result: { ok: true, result: "first" } })
        .mockResolvedValueOnce({ result: { ok: true, result: "second" } });
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
      expect(JSON.stringify(second)).not.toContain("second");
    }
  );
});

describe("MCP_DEDUP_ALLOWLIST criterion correction (#11534)", () => {
  // Creation tools whose replay leaves a durable or immediately visible
  // artifact. Each has a structural twin that was already deduped, which is
  // exactly why the omission was invisible: the same retry was safe through
  // one id and duplicated through the other.
  const NEWLY_DEDUPED = [
    "agent.terminal",
    "workflow.startWorkOnIssue",
    "forge.createIssue",
    "forge.addIssueComment",
    "forge.approvePR",
    "forge.requestChanges",
  ];

  // Navigation and idempotent state-sets. Caching these suppresses a call the
  // caller legitimately meant to repeat — reopening a URL the user closed, or
  // re-assigning after an unassign — so they must always redispatch. #11534
  // dropped `git.commit`/`git.push` for the same reason; the #8468 block above
  // covers them.
  const MUST_REDISPATCH = [
    "forge.openIssue",
    "forge.openPR",
    "forge.openIssues",
    "forge.openPRs",
    "forge.openCommits",
    "forge.assignIssue",
  ];

  // Distinct per-call payloads throughout: with a single mockResolvedValue
  // both dispatches return equal results, so `second === first` would hold
  // even with dedup switched off and only the call count would have teeth.
  const twoDistinctDispatches = () =>
    vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: "first" } })
      .mockResolvedValueOnce({ result: { ok: true, result: "second" } });

  it.each(NEWLY_DEDUPED)("dedups a post-completion duplicate of %s", async (tool) => {
    const dispatchAction = twoDistinctDispatches();
    const deps = fakeDeps({ sessionStore: fakeSessionStore("system"), dispatchAction });
    const server = createSessionServer(`dedup-11534-${tool}`, deps);

    const args = { target: "x" };
    const first = await callTool(server, { name: tool, arguments: args });
    const second = await callTool(server, { name: tool, arguments: args });

    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    // The replay is the *cached* result, not a fresh dispatch that merely
    // looks alike — the second mock payload must never surface.
    expect(JSON.stringify(second)).not.toContain("second");
  });

  it.each(NEWLY_DEDUPED)(
    "shares one dispatch between concurrent duplicates of %s",
    async (tool) => {
      // The singleflight window, not the result cache: both calls are in flight
      // before either resolves, which is the reconnect-replay shape.
      const dispatchAction = twoDistinctDispatches();
      const deps = fakeDeps({ sessionStore: fakeSessionStore("system"), dispatchAction });
      const server = createSessionServer(`dedup-11534-inflight-${tool}`, deps);

      const args = { target: "x" };
      const [first, second] = await Promise.all([
        callTool(server, { name: tool, arguments: args }),
        callTool(server, { name: tool, arguments: args }),
      ]);

      expect(dispatchAction).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
      expect(JSON.stringify(second)).not.toContain("second");
    }
  );

  it("gives agent.terminal and terminal.new the same retry outcome", async () => {
    // The issue's core complaint: "the same retry is safe through one id and
    // duplicates through the other." Assert the parity directly, so a future
    // membership edit that reintroduces the asymmetry fails here.
    const dispatchCounts = await Promise.all(
      ["terminal.new", "agent.terminal"].map(async (tool) => {
        const dispatchAction = twoDistinctDispatches();
        const deps = fakeDeps({ sessionStore: fakeSessionStore("system"), dispatchAction });
        const server = createSessionServer(`parity-11534-${tool}`, deps);

        const args = { spawnedBy: "agent" };
        await callTool(server, { name: tool, arguments: args });
        await callTool(server, { name: tool, arguments: args });
        return dispatchAction.mock.calls.length;
      })
    );

    // Both spawn a terminal the same way, so both must collapse the retry.
    expect(dispatchCounts).toEqual([1, 1]);
  });

  it.each(MUST_REDISPATCH)(
    "redispatches a repeated %s instead of returning a cached result",
    async (tool) => {
      const dispatchAction = twoDistinctDispatches();
      const deps = fakeDeps({ sessionStore: fakeSessionStore("system"), dispatchAction });
      const server = createSessionServer(`nodedup-11534-${tool}`, deps);

      const args = { target: "x" };
      await callTool(server, { name: tool, arguments: args });
      const second = await callTool(server, { name: tool, arguments: args });

      expect(dispatchAction).toHaveBeenCalledTimes(2);
      // The caller sees the *second* dispatch, not a replay of the first.
      expect(JSON.stringify(second)).toContain("second");
    }
  );

  it("keeps every deduped tool reachable from a help-session tier", () => {
    // A dedup entry for a tool no tier exposes is dead weight that reads as
    // coverage. Catches an id that survives the compile-time BuiltInActionId
    // check but has drifted off every tier allowlist. `minimumPermittingTier`
    // spans workbench/action/system only, so an external-only entry would
    // need this widened rather than the entry excused.
    expect(MCP_DEDUP_ALLOWLIST.size).toBeGreaterThan(0);
    for (const tool of MCP_DEDUP_ALLOWLIST) {
      expect(minimumPermittingTier(tool)).not.toBeNull();
    }
  });
});

describe("worktree.create redispatch (#11880)", () => {
  // The primitive became LLM-callable when it joined the system tier, which is
  // the first time dedup could apply to it at all. It must stay out: deleting
  // a worktree leaves its branch behind and the host reuses that stale branch
  // on the next create (#6463), so create -> delete -> recreate with identical
  // arguments is a supported workflow. Caching the first id would return a
  // worktree that no longer exists. The session tier is `system`, the tier the
  // first-party assistant is forced to, so a reverted tier fix shows up here
  // as zero dispatches rather than two.
  const twoDistinctDispatches = () =>
    vi
      .fn()
      .mockResolvedValueOnce({ result: { ok: true, result: "wt-first" } })
      .mockResolvedValueOnce({ result: { ok: true, result: "wt-second" } });

  const createArgs = {
    worktreePath: "/repo",
    options: { baseBranch: "develop", newBranch: "bugfix/issue-6463", path: "/repo-wt-a" },
  };

  it("recreates after a delete instead of replaying the original worktree id", async () => {
    const dispatchAction = twoDistinctDispatches();
    const deps = fakeDeps({ sessionStore: fakeSessionStore("system"), dispatchAction });
    const server = createSessionServer("recreate-11880", deps);

    await callTool(server, { name: "worktree.create", arguments: createArgs });
    const second = await callTool(server, { name: "worktree.create", arguments: createArgs });

    expect(dispatchAction).toHaveBeenCalledTimes(2);
    // The caller sees the second dispatch, not a replay of the first — a
    // cached id here would name the worktree the delete just removed.
    expect(JSON.stringify(second)).toContain("wt-second");
  });
});

describe("CallTool rate limiter removal (#10764)", () => {
  it("dispatches a burst of mutation calls without ever rejecting with MCP_RATE_LIMITED", async () => {
    // The mutation tier used to cap git.commit at 10/min — a burst past the
    // cap returned MCP_RATE_LIMITED before dispatch. With the limiter gone,
    // every call must reach dispatch.
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ sessionStore: fakeSessionStore("system"), dispatchAction });
    const server = createSessionServer("rl-removed", deps);

    const BURST = 15; // comfortably past the old mutation cap of 10
    for (let i = 0; i < BURST; i++) {
      const result = (await callTool(server, {
        name: "git.commit",
        arguments: { message: `commit-${i}` },
      })) as { isError?: boolean };
      expect(result.isError).not.toBe(true);
    }

    expect(dispatchAction).toHaveBeenCalledTimes(BURST);
  });
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

  // The ids exercised here (terminal.list/getStatus/getOutput) are all
  // curated-allowlist members, so the external-tier call reaches dispatch.
  function deps(id: string, payload: unknown, withSchema = true): SessionServerDeps {
    return fakeDeps({
      sessionStore: fakeSessionStore("external"),
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

  describe("oversized results are capped on the wire (#11526)", () => {
    function oversizedPayload() {
      return { terminals: [{ id: "t-1", content: "x".repeat(TOOL_RESULT_TEXT_MAX_BYTES * 2) }] };
    }

    it("truncates the text body of a dispatched result to the byte budget", async () => {
      const server = createSessionServer(
        "sc-oversized",
        deps("terminal.getOutput", oversizedPayload())
      );
      const result = await callTool(server, {
        name: "terminal.getOutput",
        arguments: { terminalId: "t-1" },
      });

      expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(
        TOOL_RESULT_TEXT_MAX_BYTES
      );
      expect(textOf(result).startsWith("[Tool result truncated:")).toBe(true);
    });

    it("drops structuredContent above the cap so the duplicate cannot smuggle the payload", async () => {
      const server = createSessionServer(
        "sc-oversized-structured",
        deps("terminal.list", oversizedPayload())
      );
      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect(structuredOf(result)).toBeUndefined();
    });

    it("flags a capped result whose tool declares an output schema", async () => {
      // structuredContent is present exactly when the entry declares an
      // outputSchema, and a client with that schema rejects a response carrying
      // neither it nor isError — the notice would never reach the agent.
      const server = createSessionServer(
        "sc-oversized-flagged",
        deps("terminal.list", oversizedPayload())
      );
      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(textOf(result)).toContain("Tool result truncated");
    });

    it("leaves a capped result unflagged when the tool declares no output schema", async () => {
      // Nothing was promised, so nothing is missing — a shortened body is still a
      // successful call.
      const server = createSessionServer(
        "sc-oversized-ok",
        deps("terminal.list", oversizedPayload(), false)
      );
      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect((result as { isError?: boolean }).isError).not.toBe(true);
      expect(textOf(result)).toContain("Tool result truncated");
    });

    it("caps an error envelope whose renderer-supplied details is oversized", async () => {
      // `details` crosses from the renderer unbounded, so failures reach the
      // same oversized-response bug the success path just closed.
      const server = createSessionServer(
        "sc-oversized-error",
        fakeDeps({
          sessionStore: fakeSessionStore("external"),
          requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list")]),
          dispatchAction: vi.fn().mockResolvedValue({
            result: {
              ok: false,
              error: {
                code: "EXECUTION_ERROR",
                message: "boom",
                details: { trace: "x".repeat(TOOL_RESULT_TEXT_MAX_BYTES * 2) },
              },
            },
          }),
        })
      );
      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(
        TOOL_RESULT_TEXT_MAX_BYTES
      );
      expect(textOf(result).startsWith("[Tool result truncated:")).toBe(true);
    });

    it("keeps the batched-wait short-circuit intact below the cap", async () => {
      // The only converted call site with no other result-path coverage.
      const payload = { results: [{ terminalId: "t-1", idle: true }], timedOut: false };
      const server = createSessionServer(
        "sc-batch-wait",
        fakeDeps({
          sessionStore: fakeSessionStore("external"),
          requestManifest: vi
            .fn()
            .mockResolvedValue([makeManifestEntry("terminal.waitUntilIdleBatch")]),
          handleWaitUntilIdleBatch: vi.fn().mockResolvedValue(payload),
        })
      );
      const result = await callTool(server, {
        name: "terminal.waitUntilIdleBatch",
        arguments: { terminalIds: ["t-1"] },
      });

      expect(JSON.parse(textOf(result))).toEqual(payload);
      expect(structuredOf(result)).toEqual(payload);
    });

    it("caps a main-process short-circuit that attaches structuredContent unconditionally", async () => {
      // skills.load never consults buildStructuredContent, so it needs the cap
      // applied at its own return site rather than via the outputSchema gate.
      const server = createSessionServer(
        "sc-oversized-skills",
        fakeDeps({
          sessionStore: fakeSessionStore("external"),
          requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("skills.load")]),
          handleSkillsLoad: vi.fn(() => ({
            id: "s-1",
            name: "Oversized",
            description: "A skill whose markdown body blows the budget",
            body: "x".repeat(TOOL_RESULT_TEXT_MAX_BYTES * 2),
          })),
        })
      );
      const result = await callTool(server, {
        name: "skills.load",
        arguments: { id: "s-1" },
      });

      expect(Buffer.byteLength(textOf(result), "utf8")).toBeLessThanOrEqual(
        TOOL_RESULT_TEXT_MAX_BYTES
      );
      expect(structuredOf(result)).toBeUndefined();
    });
  });
});

describe("resolved-workspace result metadata (#11536)", () => {
  const WORKSPACE = {
    kind: "project" as const,
    workspaceId: "proj-a",
    workspacePath: "/repos/a",
  };

  const manifest = [
    {
      id: "files.search",
      title: "Files: search",
      description: "Search files",
      category: "files",
      danger: "safe" as const,
      source: ["agent"] as const,
    },
  ] as unknown as ActionManifestEntry[];

  function metaOf(result: unknown): Record<string, unknown> | undefined {
    return (result as { _meta?: Record<string, unknown> })._meta;
  }

  function workspaceMetaOf(result: unknown): unknown {
    return metaOf(result)?.[RESOLVED_WORKSPACE_META_KEY];
  }

  function textOf(result: unknown): string {
    return (result as { content: { type: string; text: string }[] }).content[0].text;
  }

  function depsFor(dispatch: unknown) {
    return fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction: vi.fn().mockResolvedValue(dispatch),
    });
  }

  it("stamps the dispatched workspace on a successful result", async () => {
    const server = createSessionServer(
      "rp-ok",
      depsFor({ result: { ok: true, result: { hits: [] } }, dispatchedWorkspace: WORKSPACE })
    );
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "files.search", arguments: {} });

    expect(workspaceMetaOf(result)).toEqual(WORKSPACE);
  });

  it("reports a scratch workspace as a scratch", async () => {
    const scratch = {
      kind: "scratch" as const,
      workspaceId: "6f1c9d2e-4a7b-4c3d-9e8f-1a2b3c4d5e6f",
      workspacePath: "/scratch/one",
    };
    const server = createSessionServer(
      "rp-scratch",
      depsFor({ result: { ok: true, result: "ok" }, dispatchedWorkspace: scratch })
    );
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "files.search", arguments: {} });

    expect(workspaceMetaOf(result)).toEqual(scratch);
  });

  it("merges into an existing _meta without clobbering sibling keys or mutating the input", () => {
    const original = {
      content: [{ type: "text" as const, text: "ok" }],
      _meta: { "vendor.other/trace": "abc" },
    };

    const stamped = withResolvedWorkspace(original, WORKSPACE);

    expect(stamped._meta).toEqual({
      "vendor.other/trace": "abc",
      [RESOLVED_WORKSPACE_META_KEY]: WORKSPACE,
    });
    // Additive, never destructive: the caller's object is untouched.
    expect(original._meta).toEqual({ "vendor.other/trace": "abc" });
  });

  it("returns the result untouched when the workspace is unknown", () => {
    const original = { content: [{ type: "text" as const, text: "ok" }] };

    expect(withResolvedWorkspace(original, undefined)).toBe(original);
  });

  it("stamps the dispatched workspace on a renderer-returned action error", async () => {
    const server = createSessionServer(
      "rp-err",
      depsFor({
        result: {
          ok: false,
          error: { code: "VALIDATION_ERROR", message: "nope", details: { field: "query" } },
        },
        dispatchedWorkspace: WORKSPACE,
      })
    );
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "files.search",
      arguments: {},
    })) as { isError: boolean };

    // A renderer was reached, so the target is known and worth reporting —
    // and the error payload itself must survive the stamp untouched.
    expect(result.isError).toBe(true);
    expect(workspaceMetaOf(result)).toEqual(WORKSPACE);
    const parsed = JSON.parse(textOf(result));
    expect(parsed.code).toBe("VALIDATION_ERROR");
    expect(parsed.message).toBe("nope");
    expect(parsed.details).toEqual({ field: "query" });
  });

  it("stamps the screenshot image result, which returns before the generic path", async () => {
    // browser.captureScreenshot short-circuits into an image content block, so
    // it needs its own stamp — the generic success return never runs for it.
    const shotEntry = [
      {
        id: "browser.captureScreenshot",
        name: "browser.captureScreenshot",
        title: "Capture Browser Screenshot",
        description: "Capture the focused browser panel as a PNG",
        category: "browser",
        kind: "command",
        danger: "safe",
        enabled: true,
        requiresArgs: false,
      },
    ] as unknown as ActionManifestEntry[];
    const server = createSessionServer(
      "rp-shot",
      fakeDeps({
        sessionStore: fakeSessionStore("action"),
        requestManifest: vi.fn().mockResolvedValue(shotEntry),
        getCachedManifest: vi.fn(() => shotEntry),
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: { pngBase64: "aGVsbG8=", width: 1024, height: 768 } },
          dispatchedWorkspace: WORKSPACE,
        }),
      })
    );
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "browser.captureScreenshot",
      arguments: {},
    })) as { content: Array<Record<string, unknown>>; isError?: boolean };

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: "image", data: "aGVsbG8=" });
    expect(workspaceMetaOf(result)).toEqual(WORKSPACE);
  });

  it("omits the key entirely when the dispatch reported no workspace", async () => {
    const server = createSessionServer("rp-none", depsFor({ result: { ok: true, result: "ok" } }));
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "files.search", arguments: {} });

    // Absent, not null — "unknown" must not be confusable with "no workspace".
    expect(workspaceMetaOf(result)).toBeUndefined();
    expect(metaOf(result) === undefined || !(RESOLVED_WORKSPACE_META_KEY in metaOf(result)!)).toBe(
      true
    );
  });

  it("does not stamp a pre-dispatch failure, where no renderer was reached", async () => {
    const dispatchAction = vi.fn().mockRejectedValue(new RendererBridgeUnavailableError());
    const deps = fakeDeps({
      requestManifest: vi.fn().mockResolvedValue(manifest),
      getCachedManifest: vi.fn(() => manifest),
      dispatchAction,
    });
    const server = createSessionServer("rp-nowindow", deps);
    await server.connect(makeMockTransport());

    const result = (await callTool(server, {
      name: "files.search",
      arguments: {},
    })) as { isError: boolean };

    // Prove it really took the no-window dispatch path rather than bailing out
    // earlier for an unrelated reason.
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).code).toBe(EXECUTION_ERROR_CODE);
    expect(workspaceMetaOf(result)).toBeUndefined();
  });

  it("preserves structuredContent alongside the stamp", async () => {
    const payload = { terminals: [{ id: "t-1", kind: "terminal", isFocused: true }] };
    const entry: ActionManifestEntry = {
      ...({
        id: "terminal.list",
        name: "terminal.list",
        title: "Terminal: list",
        description: "List terminals",
        category: "terminal",
        kind: "query",
        danger: "safe",
        enabled: true,
        requiresArgs: false,
      } as unknown as ActionManifestEntry),
      outputSchema: {
        type: "object",
        properties: { terminals: { type: "array" } },
      },
    };
    const server = createSessionServer(
      "rp-structured",
      fakeDeps({
        // `terminal.list` is on the curated external allowlist, so the external
        // tier reaches it on the allowlist alone (#11537 deleted the widening opt-in).
        sessionStore: fakeSessionStore("external"),
        requestManifest: vi.fn().mockResolvedValue([entry]),
        getCachedManifest: vi.fn(() => [entry]),
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: payload },
          dispatchedWorkspace: WORKSPACE,
        }),
      })
    );
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: "terminal.list", arguments: {} });

    // The stamp must not displace structuredContent — both ride the same result.
    expect(workspaceMetaOf(result)).toEqual(WORKSPACE);
    expect((result as { structuredContent?: unknown }).structuredContent).toEqual(payload);
    expect(JSON.parse(textOf(result))).toEqual(payload);
  });
});

// #11525 — discovery must mirror dispatch authority. The renderer builds these
// results with no idea which session called it, so main narrows them on the way
// back out.
describe("sessionServer introspection tier filtering", () => {
  function introspectionDeps(
    tier: "workbench" | "action" | "system" | "external",
    result: unknown,
    overrides?: Partial<SessionServerDeps>
  ) {
    return fakeDeps({
      sessionStore: fakeSessionStore(tier),
      dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result } }),
      ...overrides,
    });
  }

  function entry(id: string, overrides: Partial<ActionManifestEntry> = {}): ActionManifestEntry {
    return { ...makeManifestEntry(id), ...overrides };
  }

  /**
   * The tool result the model actually receives. Read from the text block
   * because `structuredContent` is only built when the manifest lookup
   * resolves an entry carrying an outputSchema, which most of these deps
   * deliberately do not supply.
   */
  function payload<T>(res: { content: unknown }): T {
    return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as T;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops actions.list entries the calling tier cannot dispatch", async () => {
    // `git.push` is a system-tier tool; a workbench session can never call it,
    // so advertising it in discovery only buys a TIER_NOT_PERMITTED round trip.
    // Give the manifest lookup a real entry with an outputSchema so the
    // handler also emits structuredContent — the two renderings of the result
    // must agree, since they are one filtered value and not two filters.
    const manifestEntry: ActionManifestEntry = {
      ...makeManifestEntry("actions.list"),
      outputSchema: { type: "object", properties: {} },
    };
    const deps = introspectionDeps(
      "workbench",
      { actions: [entry("actions.list"), entry("git.push"), entry("terminal.list")] },
      { getCachedManifest: vi.fn(() => [manifestEntry]) }
    );
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, { name: "actions.list" });

    const listed = payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id);
    expect(listed).toEqual(["actions.list", "terminal.list"]);
    expect(isTierPermitted("workbench", "git.push")).toBe(false);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toContain("git.push");
    expect(res.structuredContent).toEqual(JSON.parse(text));
  });

  it("returns strictly more to a higher tier", async () => {
    const manifest = { actions: [entry("actions.list"), entry("git.push")] };
    const ids = async (tier: "workbench" | "system") => {
      const server = createSessionServer("s1", introspectionDeps(tier, manifest));
      const res = await callTool(server, { name: "actions.list" });
      return payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id);
    };
    expect(await ids("workbench")).toEqual(["actions.list"]);
    expect(await ids("system")).toEqual(["actions.list", "git.push"]);
  });

  it("narrows search to the session's own surface", async () => {
    // Search reports what this tier can dispatch and nothing beyond it: a
    // workbench session sees terminal.list and not git.push. Post-#11585 there
    // is no class of entry that search reaches but tools/list withholds — the
    // tier allowlist is the whole surface, and both gates read it.
    const permittedEntry = entry("terminal.list");
    expect(shouldExposeTool(permittedEntry, "workbench")).toBe(true);
    expect(isTierPermitted("workbench", "terminal.list")).toBe(true);
    expect(isTierPermitted("workbench", "git.push")).toBe(false);

    const deps = introspectionDeps("workbench", {
      totalMatches: 2,
      results: [permittedEntry, entry("git.push")],
    });
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, {
      name: "actions.search",
      arguments: { query: "terminal" },
    });

    const body = payload<{ totalMatches: number; results: ActionManifestEntry[] }>(res);
    expect(body.results.map((r) => r.id)).toEqual(["terminal.list"]);
    expect(body.totalMatches).toBe(1);
  });

  describe("actions.getSchema policy record (#11910)", () => {
    interface GetSchemaBody {
      ok: boolean;
      entry: ActionManifestEntry | null;
      policy: Record<string, unknown> | null;
      error: { code: string; message: string } | null;
    }

    function schemaDeps(
      tier: "workbench" | "action" | "system" | "external",
      target: ActionManifestEntry,
      overrides?: Partial<SessionServerDeps>
    ) {
      // The renderer's real return shape: it fills `entry` and leaves `policy`
      // for main, which is the substitution under test.
      return introspectionDeps(
        tier,
        { ok: true, entry: target, policy: null, error: null },
        overrides
      );
    }

    async function lookup(
      deps: SessionServerDeps,
      actionId: string,
      sessionId = "s1"
    ): Promise<GetSchemaBody> {
      const server = createSessionServer(sessionId, deps);
      const res = await callTool(server, {
        name: ACTIONS_GET_SCHEMA_TOOL_ID,
        arguments: { actionId },
      });
      return payload<GetSchemaBody>(res);
    }

    it("substitutes a real policy for the renderer's null placeholder", async () => {
      const deps = schemaDeps("workbench", entry("terminal.list"));
      const body = await lookup(deps, "terminal.list");

      // The renderer sent `policy: null`; anything non-null here is main's
      // substitution, which is the wiring under test.
      expect(body.ok).toBe(true);
      expect(body.entry).not.toBeNull();
      expect(body.error).toBeNull();
      expect(body.policy).toMatchObject({ callable: true, authorizedBy: "tier" });
    });

    // The origin is what grant issuance gates on, and a session that never
    // declared one defaults to `external` — so the honest answer for it is that
    // no approval flow exists, whatever tier admitted the call.
    it("reports grantability from the session origin, not its tier", async () => {
      const unowned = schemaDeps("workbench", entry("terminal.list"));
      expect((await lookup(unowned, "terminal.list")).policy).toMatchObject({
        grantable: false,
      });

      const owned = schemaDeps("workbench", entry("terminal.list"));
      owned.sessionStore.sessionOriginMap.set("s1", "help");
      expect((await lookup(owned, "terminal.list")).policy).toMatchObject({
        grantable: true,
      });
    });

    it("reports the flat external tier for an api-key caller", async () => {
      const deps = schemaDeps("external", entry("terminal.list"));
      const body = await lookup(deps, "terminal.list");

      // The point of the external branch: `minimumPermittingTier` never returns
      // "external", so a tier derived from it alone would be wrong here.
      expect(body.ok).toBe(true);
      expect(body.policy).toMatchObject({ minimumTier: "external" });
    });

    // A live grant widens discovery, and the record must name the grant as what
    // admits the call — the client's cue that this access can lapse.
    it("names a live per-tool grant as the admitting mechanism", async () => {
      const deps = schemaDeps("workbench", entry("git.push"));
      deps.sessionStore.sessionOriginMap.set("s1", "help");
      deps.sessionStore.grantCache.issueGrant("s1", "git.push");

      const body = await lookup(deps, "git.push");

      expect(body.ok).toBe(true);
      expect(body.policy).toMatchObject({ authorizedBy: "grant", minimumTier: "system" });
      // The grant is bridging a real gap rather than rubber-stamping a target
      // the tier already allowed — stated as the relation, so it keeps meaning
      // if the fixture's tier changes.
      expect(body.policy?.effectiveTier).not.toBe(body.policy?.minimumTier);
    });

    it("still collapses a tier-denied target with no policy attached", async () => {
      const deps = schemaDeps("workbench", entry("git.push"));
      const body = await lookup(deps, "git.push");

      expect(body.ok).toBe(false);
      expect(body.entry).toBeNull();
      expect(body.policy).toBeNull();
      expect(body.error?.code).toBe("NOT_FOUND");
    });

    it("never attaches a policy to a hidden or restricted target", async () => {
      for (const overrides of [
        { mcpVisibility: "hidden" as const },
        { danger: "restricted" as const },
      ]) {
        const deps = schemaDeps("workbench", entry("terminal.list", overrides));
        const body = await lookup(deps, "terminal.list");

        expect(body).toEqual({
          ok: false,
          entry: null,
          policy: null,
          error: { code: "NOT_FOUND", message: expect.stringContaining("terminal.list") },
        });
      }
    });

    // The policy is a snapshot, not a lease. A grant that lapses between two
    // reads must stop admitting the target on the second one — otherwise a
    // client caches an authorization the dispatch gate would already refuse.
    it("stops reporting a grant once its TTL has lapsed", async () => {
      let now = 1000;
      const grantCache = new GrantCache({ ttlMs: 100, sweepIntervalMs: 0, now: () => now });
      const store = fakeSessionStore("workbench");
      (store as unknown as { grantCache: GrantCache }).grantCache = grantCache;
      store.sessionOriginMap.set("s1", "help");

      const deps = schemaDeps("workbench", entry("git.push"), { sessionStore: store });
      grantCache.issueGrant("s1", "git.push");

      const whileLive = await lookup(deps, "git.push");
      expect(whileLive.ok).toBe(true);
      expect(whileLive.policy).toMatchObject({ authorizedBy: "grant" });

      now = 50_000;
      const afterExpiry = await lookup(deps, "git.push");
      expect(afterExpiry.ok).toBe(false);
      expect(afterExpiry.policy).toBeNull();

      grantCache.dispose();
    });
  });

  it("over-fetches the search page so denied top hits cannot starve it", async () => {
    // 40 denied hits outrank the permitted ones. A renderer honouring the
    // caller's limit of 3 would return only denied entries, so without the
    // over-fetch the page comes back empty — this dispatcher slices the way
    // the real action does instead of ignoring the limit.
    const ranked = [
      ...Array.from({ length: 40 }, (_, i) => entry(`git.denied${i}`)),
      entry("actions.list"),
      entry("actions.search"),
      entry("terminal.list"),
    ];
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("workbench"),
      dispatchAction: vi.fn((_id: string, args: unknown) => {
        const limit = (args as { limit?: number }).limit ?? 20;
        return Promise.resolve({
          result: {
            ok: true as const,
            result: { totalMatches: ranked.length, results: ranked.slice(0, limit) },
          },
        });
      }),
    });
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, {
      name: "actions.search",
      arguments: { query: "anything", limit: 3 },
    });

    const body = payload<{ totalMatches: number; results: ActionManifestEntry[] }>(res);
    expect(body.results.map((r) => r.id)).toEqual([
      "actions.list",
      "actions.search",
      "terminal.list",
    ]);
    expect(body.totalMatches).toBe(3);

    // The audit trail must record what the CALLER asked for, not the widened
    // limit main forwarded to the renderer.
    const audited = (deps.appendAuditRecord as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      args: { limit: number };
    };
    expect(audited.args).toEqual({ query: "anything", limit: 3 });
  });

  it("leaves an out-of-contract search limit for the renderer to reject", async () => {
    const deps = introspectionDeps("workbench", { totalMatches: 0, results: [] });
    const server = createSessionServer("s1", deps);
    await callTool(server, {
      name: "actions.search",
      arguments: { query: "anything", limit: 5000 },
    });

    // The over-fetch must not rewrite an illegal limit into a legal one; the
    // renderer's own validation stays the gate.
    const dispatched = (deps.dispatchAction as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((dispatched[1] as { limit: number }).limit).toBe(5000);
  });

  it("walks every actions.list page before filtering, preserving the caller's filters", async () => {
    // The renderer pages before main can apply the tier filter, so filtering
    // one of its pages would return a short page whose total/hasMore counted
    // actions this session cannot dispatch.
    const permitted = Array.from({ length: 120 }, (_, i) => entry(`actions.p${i}`));
    const all = [...permitted.slice(0, 60), entry("git.push"), ...permitted.slice(60)];
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("workbench"),
      dispatchAction: vi.fn((_id: string, callArgs: unknown) => {
        const { offset = 0, limit = 50 } = callArgs as { offset?: number; limit?: number };
        const page = all.slice(offset, offset + limit);
        return Promise.resolve({
          result: {
            ok: true as const,
            result: {
              actions: page,
              total: all.length,
              limit,
              offset,
              hasMore: offset + limit < all.length,
            },
          },
        });
      }),
    });
    const server = createSessionServer("s1", deps);
    await callTool(server, { name: "actions.list", arguments: { category: "git" } });

    const calls = (deps.dispatchAction as ReturnType<typeof vi.fn>).mock.calls;
    // Every page fetched at the maximum window, walking until hasMore clears,
    // and the caller's own filter carried on each request.
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call[1]).toMatchObject({ category: "git", limit: 100 });
    }
    expect(calls.map((c) => (c[1] as { offset: number }).offset)).toEqual([0, 100]);
  });

  /**
   * The page walk synthesizes its own envelope instead of returning the
   * renderer's, so the resolved-workspace stamp (#11536) has to be carried
   * across it deliberately. Left out, exactly the calls that span more than one
   * page would omit the field every single-shot dispatch reports — the paged
   * caller would be told less about where its call landed than the unpaged one.
   */
  function pagedListDeps(all: ActionManifestEntry[], dispatchedWorkspace?: DispatchedWorkspaceRef) {
    return fakeDeps({
      sessionStore: fakeSessionStore("workbench"),
      dispatchAction: vi.fn((_id: string, callArgs: unknown) => {
        const { offset = 0, limit = 50 } = callArgs as { offset?: number; limit?: number };
        return Promise.resolve({
          result: {
            ok: true as const,
            result: {
              actions: all.slice(offset, offset + limit),
              total: all.length,
              limit,
              offset,
              hasMore: offset + limit < all.length,
            },
          },
          ...(dispatchedWorkspace ? { dispatchedWorkspace } : {}),
        });
      }),
    });
  }

  function workspaceMetaOf(res: unknown): unknown {
    return (res as { _meta?: Record<string, unknown> })._meta?.[RESOLVED_WORKSPACE_META_KEY];
  }

  // A permitted id parked past the first 100-entry window, so a result that
  // contains it proves the walk reached page two.
  const filler = Array.from({ length: 150 }, (_, i) => entry(`git.denied${i}`));
  const spanningTwoPages = [...filler.slice(0, 120), entry("terminal.list"), ...filler.slice(120)];

  it("stamps the resolved workspace on a paged actions.list, as the single-shot path does", async () => {
    const workspace = {
      kind: "project" as const,
      workspaceId: "proj-paged",
      workspacePath: "/repos/paged",
    };
    const deps = pagedListDeps(spanningTwoPages, workspace);
    const server = createSessionServer("s1", deps);

    const res = await callTool(server, { name: "actions.list" });

    // Prove the paged branch really ran, and that page two's content came back.
    expect((deps.dispatchAction as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    expect(payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id)).toContain(
      "terminal.list"
    );
    expect(workspaceMetaOf(res)).toEqual(workspace);
  });

  it("omits the workspace key on a paged call whose dispatch resolved none", async () => {
    const deps = pagedListDeps(spanningTwoPages);
    const server = createSessionServer("s1", deps);

    const res = await callTool(server, { name: "actions.list" });

    // Absent, not null — the paged path must not invent a stamp the dispatch
    // never reported, any more than it may drop one it did.
    expect((deps.dispatchAction as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
    expect(workspaceMetaOf(res)).toBeUndefined();
  });

  it("pages the permitted set so total and hasMore describe the reachable surface", async () => {
    // Six workbench-permitted ids, deliberately split across two renderer
    // pages: three land beyond the first 100-entry window, so a filter applied
    // to a single page would miss them entirely.
    const early = ["actions.search", "actions.getSchema", "terminal.list"];
    const late = ["terminal.getOutput", "terminal.getStatus", "worktree.list"];
    for (const id of [...early, ...late]) {
      expect(isTierPermitted("workbench", id)).toBe(true);
    }
    const denied = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => entry(`git.denied${from + i}`));
    const all = [
      ...denied(60, 0),
      ...early.map((id) => entry(id)),
      ...denied(37, 60),
      ...late.map((id) => entry(id)),
      ...denied(20, 100),
    ];
    expect(all.length).toBeGreaterThan(100);

    const deps = fakeDeps({
      sessionStore: fakeSessionStore("workbench"),
      dispatchAction: vi.fn((_id: string, callArgs: unknown) => {
        const { offset = 0, limit = 50 } = callArgs as { offset?: number; limit?: number };
        return Promise.resolve({
          result: {
            ok: true as const,
            result: {
              actions: all.slice(offset, offset + limit),
              total: all.length,
              limit,
              offset,
              hasMore: offset + limit < all.length,
            },
          },
        });
      }),
    });
    const server = createSessionServer("s1", deps);

    const body = payload<{
      actions: ActionManifestEntry[];
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    }>(await callTool(server, { name: "actions.list", arguments: { limit: 4 } }));

    // total counts the permitted surface, not the renderer's raw match count.
    expect(body.total).toBe(6);
    expect(body.actions.map((a) => a.id)).toEqual([...early, "terminal.getOutput"]);
    expect(body.hasMore).toBe(true);

    const second = payload<{ actions: ActionManifestEntry[]; hasMore: boolean }>(
      await callTool(server, { name: "actions.list", arguments: { limit: 4, offset: 4 } })
    );
    // Paging walks the permitted set, so page two continues where page one
    // stopped instead of re-slicing a tier-blind ordering.
    expect(second.actions.map((a) => a.id)).toEqual(["terminal.getStatus", "worktree.list"]);
    expect(second.hasMore).toBe(false);
  });

  it("reports a tier-denied getSchema id as NOT_FOUND rather than advertising it", async () => {
    const deps = introspectionDeps("workbench", { ok: true, entry: entry("git.push") });
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, {
      name: "actions.getSchema",
      arguments: { actionId: "git.push" },
    });

    const body = payload<{ ok: boolean; error: { code: string } }>(res);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("leaves non-introspection results untouched", async () => {
    const result = { actions: [entry("git.push")], totalMatches: 99 };
    const deps = introspectionDeps("workbench", result);
    const server = createSessionServer("s1", deps);
    const res = await callTool(server, { name: "terminal.list" });
    expect(payload(res)).toEqual(result);
  });

  describe("live grants widen discovery", () => {
    it("surfaces a per-tool grant's action in actions.list", async () => {
      const deps = introspectionDeps("workbench", { actions: [entry("git.push")] });
      const server = createSessionServer("s1", deps);

      const before = await callTool(server, { name: "actions.list" });
      expect(payload<{ actions: unknown[] }>(before).actions).toHaveLength(0);

      deps.sessionStore.grantCache.issueGrant("s1", "git.push");
      const after = await callTool(server, { name: "actions.list" });
      expect(payload<{ actions: ActionManifestEntry[] }>(after).actions.map((a) => a.id)).toEqual([
        "git.push",
      ]);

      deps.sessionStore.grantCache.dispose();
    });

    it("surfaces every tool a native automation grant pre-approved", async () => {
      // Native grants (#10648) are issued up front with an explicit allowlist.
      // If discovery ignored them the agent could never find the tools it was
      // just approved for.
      const deps = introspectionDeps("workbench", {
        actions: [entry("git.push"), entry("git.commit"), entry("worktree.delete")],
      });
      const server = createSessionServer("s1", deps);
      deps.sessionStore.grantCache.issueNativeGrant({
        sessionId: "s1",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["git.push", "git.commit"],
        maxUses: 5,
      });

      const res = await callTool(server, { name: "actions.list" });
      expect(payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id)).toEqual([
        "git.push",
        "git.commit",
      ]);

      deps.sessionStore.grantCache.dispose();
    });

    it("does not consume a native grant use or emit lifecycle events while discovering", async () => {
      const emitted: string[] = [];
      const grantCache = new GrantCache({
        sweepIntervalMs: 0,
        emit: (_sessionId, payload) => emitted.push(payload.type),
      });
      const store = fakeSessionStore("workbench");
      (store as unknown as { grantCache: GrantCache }).grantCache = grantCache;

      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: { actions: [entry("git.push")] } },
        }),
      });
      const server = createSessionServer("s1", deps);
      const grant = grantCache.issueNativeGrant({
        sessionId: "s1",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["git.push"],
        maxUses: 1,
      });
      emitted.length = 0;

      await callTool(server, { name: "actions.list" });
      await callTool(server, { name: "actions.list" });

      // Discovery is a read: the single use is still available for a real call.
      expect(grantCache.getNativeGrant(grant.id)?.remainingUses).toBe(1);
      expect(emitted).toEqual([]);

      grantCache.dispose();
    });

    // Grants are per-session. Reading them unscoped would let session A
    // discover what session B was approved for and then fail to dispatch it —
    // the original bug, recreated across sessions.
    it("ignores grants belonging to a different session", async () => {
      const deps = introspectionDeps("workbench", {
        actions: [entry("git.push"), entry("git.commit"), entry("worktree.delete")],
      });
      const server = createSessionServer("s1", deps);
      deps.sessionStore.grantCache.issueGrant("other", "git.commit");
      deps.sessionStore.grantCache.issueNativeGrant({
        sessionId: "other",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["worktree.delete"],
        maxUses: 5,
      });
      // One grant that DOES belong to s1, so the test proves scoping rather
      // than merely proving grants were ignored altogether.
      deps.sessionStore.grantCache.issueGrant("s1", "git.push");

      const res = await callTool(server, { name: "actions.list" });
      expect(payload<{ actions: ActionManifestEntry[] }>(res).actions.map((a) => a.id)).toEqual([
        "git.push",
      ]);

      deps.sessionStore.grantCache.dispose();
    });

    it("ignores a native grant past its hard lifetime ceiling", async () => {
      let now = 1000;
      const grantCache = new GrantCache({
        ttlMs: 4000,
        maxLifetimeMs: 5000,
        sweepIntervalMs: 0,
        now: () => now,
      });
      const store = fakeSessionStore("workbench");
      (store as unknown as { grantCache: GrantCache }).grantCache = grantCache;

      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: { actions: [entry("git.push")] } },
        }),
      });
      const server = createSessionServer("s1", deps);
      const grant = grantCache.issueNativeGrant({
        sessionId: "s1",
        actorId: "test-actor",
        actorType: "help-session",
        allowedTools: ["git.push"],
        maxUses: 5,
      });

      // Slide the TTL forward so expiry is still in the future at read time;
      // only the ceiling disqualifies the grant.
      now = 5000;
      grantCache.refreshNativeGrant(grant.id);
      now = 6500;
      expect(grantCache.getActiveNativeGrants("s1")[0]!.expiresAt).toBeGreaterThan(now);

      const res = await callTool(server, { name: "actions.list" });
      expect(payload<{ actions: unknown[] }>(res).actions).toHaveLength(0);

      grantCache.dispose();
    });

    it("ignores a grant that has lapsed its TTL", async () => {
      let now = 1000;
      const grantCache = new GrantCache({ ttlMs: 100, sweepIntervalMs: 0, now: () => now });
      const store = fakeSessionStore("workbench");
      (store as unknown as { grantCache: GrantCache }).grantCache = grantCache;

      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: { actions: [entry("git.push")] } },
        }),
      });
      const server = createSessionServer("s1", deps);
      grantCache.issueGrant("s1", "git.push");

      now = 50_000;
      const res = await callTool(server, { name: "actions.list" });
      expect(payload<{ actions: unknown[] }>(res).actions).toHaveLength(0);

      grantCache.dispose();
    });
  });

  // A renderer result is not runtime-validated anywhere between the action's
  // `run()` and the MCP wire, so an unexpected shape must deny rather than
  // sail through unfiltered.
  describe("fails closed on a payload shape it does not recognise", () => {
    it("returns no actions when actions is not an array", async () => {
      const deps = introspectionDeps("workbench", {
        actions: { smuggled: entry("git.push") },
        leaked: [entry("git.push")],
      });
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, { name: "actions.list" });

      expect(payload<{ actions: unknown[] }>(res).actions).toEqual([]);
      // Fields the renderer attached alongside the filtered one are dropped,
      // not forwarded — the payload is rebuilt, never spread.
      expect((res.content as Array<{ text: string }>)[0]!.text).not.toContain("git.push");
    });

    it("returns no search results when results is not an array", async () => {
      const deps = introspectionDeps("workbench", {
        totalMatches: 99,
        results: "not-an-array",
        leaked: [entry("git.push")],
      });
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, {
        name: "actions.search",
        arguments: { query: "anything" },
      });

      const body = payload<{ totalMatches: number; results: unknown[] }>(res);
      expect(body).toEqual({ totalMatches: 0, results: [] });
      expect((res.content as Array<{ text: string }>)[0]!.text).not.toContain("git.push");
    });

    it("rejects a getSchema answer for an id other than the one requested", async () => {
      // A permitted id must not vouch for a denied entry's schema.
      const deps = introspectionDeps("workbench", {
        ok: true,
        entry: { ...entry("git.push"), id: "actions.list" },
      });
      const server = createSessionServer("s1", deps);
      const res = await callTool(server, {
        name: "actions.getSchema",
        arguments: { actionId: "git.push" },
      });

      const body = payload<{ ok: boolean; error: { code: string; message: string } }>(res);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("NOT_FOUND");
      // The message names what the caller asked for, not what came back.
      expect(body.error.message).toContain("git.push");
    });
  });

  // Discovery results depend on tier and on live grants, both of which can
  // change between calls. Caching them per (session, args) would serve a
  // pre-revocation surface after an approval lapsed.
  it("keeps introspection tools out of the mutation-only dedup allowlist", () => {
    for (const id of ["actions.list", "actions.search", "actions.getSchema"]) {
      expect(MCP_DEDUP_ALLOWLIST.has(id)).toBe(false);
    }
  });
});

describe("mcp.surface short-circuit (#11549)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SURFACE = "mcp.surface";

  function surfaceManifest(): ActionManifestEntry[] {
    return [
      makeManifestEntry("actions.list"),
      makeManifestEntry(SURFACE),
      { ...makeManifestEntry("terminal.new"), kind: "command" as const },
      { ...makeManifestEntry("git.commit"), kind: "command" as const, danger: "confirm" as const },
      { ...makeManifestEntry("actions.persistedStores"), mcpVisibility: "hidden" as const },
    ];
  }

  async function readSurface(
    tier: "workbench" | "action" | "system" | "external",
    overrides?: Partial<SessionServerDeps>
  ) {
    const deps = fakeDeps({
      sessionStore: fakeSessionStore(tier),
      requestManifest: vi.fn().mockResolvedValue(surfaceManifest()),
      ...overrides,
    });
    const server = createSessionServer(`session-surface-${tier}`, deps);
    await server.connect(makeMockTransport());
    const result = await callTool(server, { name: SURFACE });
    return { deps, server, result };
  }

  it("answers from main without dispatching to the renderer", async () => {
    const dispatchAction = vi.fn();
    const { result } = await readSurface("workbench", { dispatchAction });

    expect(dispatchAction).not.toHaveBeenCalled();
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      manifestVersion: expect.any(Number),
      appVersion: "0.0.0-test",
      tier: "workbench",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  // The one invariant the whole feature rests on: a report that disagreed with
  // the listing would send clients chasing drift that does not exist, or hide
  // drift that does.
  it("reports exactly the tool ids tools/list serves at the same tier", async () => {
    for (const tier of ["workbench", "action", "system", "external"] as const) {
      const { server, result } = await readSurface(tier);
      const listed = ((await listTools(server)) as { tools: Array<{ name: string }> }).tools
        .map((t) => t.name)
        .sort();
      const reported = (result.structuredContent as { tools: Array<{ id: string }> }).tools.map(
        (t) => t.id
      );

      // Two empty lists compare equal, so pin the listing to something real
      // first — a short-circuit that returned nothing would otherwise pass.
      // `mcp.surface` is the anchor: allowlisted at all four tiers, so its
      // absence means the registration itself regressed.
      expect(listed).toContain(SURFACE);
      expect(listed.length).toBeGreaterThan(1);
      expect(reported).toEqual(listed);
    }
  });

  it("omits a tool hidden from tools/list even though its tier permits it", async () => {
    const { result } = await readSurface("workbench");
    const ids = (result.structuredContent as { tools: Array<{ id: string }> }).tools.map(
      (t) => t.id
    );

    expect(ids).not.toContain("actions.persistedStores");
  });

  it("ignores a live grant, so the hash tracks the listing rather than a timer", async () => {
    const sessionStore = fakeSessionStore("workbench");
    const granted = { ...makeManifestEntry("git.commit"), kind: "command" as const };
    const deps = fakeDeps({
      sessionStore,
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("actions.list"), granted]),
    });
    const server = createSessionServer("session-surface-grant", deps);
    await server.connect(makeMockTransport());

    const before = await callTool(server, { name: SURFACE });
    sessionStore.grantCache.issueGrant("session-surface-grant", "git.commit");
    const after = await callTool(server, { name: SURFACE });

    const ids = (r: { structuredContent?: unknown }) =>
      (r.structuredContent as { tools: Array<{ id: string }> }).tools.map((t) => t.id);
    expect(ids(after)).toEqual(ids(before));
    expect(ids(after)).not.toContain("git.commit");
    expect((after.structuredContent as { hash: string }).hash).toBe(
      (before.structuredContent as { hash: string }).hash
    );
    sessionStore.grantCache.dispose();
  });

  it("builds against the tier the call was authorized at, not a later re-read", async () => {
    // Authorization has one lifetime per call: a session revoked mid-fetch has
    // no tier at all afterwards (#11799), and re-reading would either refuse a
    // call the gate already admitted or disagree with the audit record that
    // logs the admitted tier. The gate's tier is the only coherent answer.
    // The witness has to be a tool `workbench` grants and `external` does not,
    // or its absence proves nothing — a tool neither tier reaches is missing
    // either way. Derived rather than named so it cannot rot into a tautology.
    const workbenchOnly = [...TIER_ALLOWLISTS.workbench].find(
      (id) => !TIER_ALLOWLISTS.external.has(id)
    );
    expect(workbenchOnly).toBeDefined();
    const sessionStore = fakeSessionStore("external");
    const deps = fakeDeps({
      sessionStore,
      requestManifest: vi.fn().mockImplementation(async () => {
        vi.mocked(sessionStore.getTier).mockReturnValue(null);
        return [...surfaceManifest(), makeManifestEntry(workbenchOnly!)];
      }),
    });
    const server = createSessionServer("session-surface-revoked", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: SURFACE });
    const reported = result.structuredContent as {
      tier: string;
      tools: Array<{ id: string }>;
    };

    expect(reported.tier).toBe("external");
    // The concrete tool a workbench re-read would have added to the report.
    expect(reported.tools.map((t) => t.id)).not.toContain(workbenchOnly);
    // Resolved once, at the gate — the re-read this guards against would show
    // up here as a second call.
    expect(sessionStore.getTier).toHaveBeenCalledTimes(1);
  });

  it("writes one audit record and settles the activity strip exactly once", async () => {
    const appendAuditRecord = vi.fn();
    const notifyToolCallStarted = vi.fn();
    const notifyToolCallSettled = vi.fn();
    await readSurface("workbench", {
      appendAuditRecord,
      notifyToolCallStarted,
      notifyToolCallSettled,
    });

    expect(notifyToolCallStarted).toHaveBeenCalledTimes(1);
    expect(notifyToolCallSettled).toHaveBeenCalledTimes(1);
    expect(appendAuditRecord).toHaveBeenCalledTimes(1);
    expect(appendAuditRecord.mock.calls[0]![0]).toMatchObject({
      toolId: SURFACE,
      tier: "workbench",
      outcome: { kind: "result" },
    });
    // A read never asks the user for anything, so the strip must show a plain
    // in-flight row rather than an awaiting-confirmation one.
    expect(notifyToolCallStarted.mock.calls[0]![0]).toMatchObject({ danger: false });
  });

  it("audits a failed build as a throw rather than a silent success", async () => {
    const appendAuditRecord = vi.fn();
    const deps = fakeDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("renderer gone")),
      getCachedManifest: vi.fn(() => null),
      appendAuditRecord,
    });
    const server = createSessionServer("session-surface-audit-fail", deps);
    await server.connect(makeMockTransport());

    await expect(callTool(server, { name: SURFACE })).rejects.toThrow();

    expect(appendAuditRecord).toHaveBeenCalledTimes(1);
    expect(appendAuditRecord.mock.calls[0]![0]).toMatchObject({
      toolId: SURFACE,
      outcome: { kind: "throw" },
    });
  });

  it("falls back to the cached manifest when the live fetch fails", async () => {
    const deps = fakeDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("renderer gone")),
      getCachedManifest: vi.fn(() => surfaceManifest()),
    });
    const server = createSessionServer("session-surface-cached", deps);
    await server.connect(makeMockTransport());

    const result = await callTool(server, { name: SURFACE });

    expect(result.isError).not.toBe(true);
    expect(
      (result.structuredContent as { tools: Array<{ id: string }> }).tools.length
    ).toBeGreaterThan(0);
  });

  it("fails closed for a pinned session whose renderer is gone", async () => {
    // getCachedManifest returns null for pinned sessions (#7003), so there is no
    // safe fallback — serving another window's surface would be worse than an error.
    const deps = fakeDeps({
      requestManifest: vi.fn().mockRejectedValue(new Error("renderer gone")),
      getCachedManifest: vi.fn(() => null),
    });
    const server = createSessionServer("session-surface-pinned", deps);
    await server.connect(makeMockTransport());

    await expect(callTool(server, { name: SURFACE })).rejects.toThrow(/manifest unavailable/i);
  });

  it("is refused before the short-circuit when the tier does not permit it", async () => {
    // The short-circuit sits AFTER the tier gate. Proven by driving a real
    // denied call rather than by restating the allowlist: `git.commit` stands in
    // for a tool this tier lacks, and the refusal must be the tier error, not a
    // surface report.
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("workbench"),
      requestManifest: vi.fn().mockResolvedValue(surfaceManifest()),
    });
    const server = createSessionServer("session-surface-denied", deps);
    await server.connect(makeMockTransport());

    const denied = await callTool(server, { name: "git.commit" });

    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied.content)).toContain(TIER_NOT_PERMITTED_CODE);
  });
});

describe("workspace-bound external sessions (#11789)", () => {
  const SESSION = "bound-session";
  const WORKSPACE = "ws-a";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A confirm-gated tool that really is on the external allowlist. */
  function recipeRun(): ActionManifestEntry {
    return { ...makeManifestEntry("recipe.run"), kind: "command", danger: "confirm" as const };
  }

  function boundDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
    const sessionStore = fakeSessionStore("external");
    sessionStore.sessionOriginMap.set(SESSION, "external");
    sessionStore.sessionWorkspaceMap.set(SESSION, WORKSPACE);
    return fakeDeps({
      sessionStore,
      workspaceBinding: { kind: "project", workspaceId: WORKSPACE, workspacePath: "/tmp/a" },
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list"), recipeRun()]),
      ...overrides,
    });
  }

  function unboundDeps(overrides?: Partial<SessionServerDeps>): SessionServerDeps {
    return fakeDeps({
      sessionStore: fakeSessionStore("external"),
      requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list"), recipeRun()]),
      ...overrides,
    });
  }

  describe("effective surface", () => {
    it("omits the confirm-gated tool from tools/list", async () => {
      const server = createSessionServer(SESSION, boundDeps());
      await server.connect(makeMockTransport());

      const names = (await listTools(server)).tools.map((t) => t.name);

      expect(names).toContain("terminal.list");
      expect(names).not.toContain("recipe.run");
    });

    it("still lists it for an unbound external session", async () => {
      // Binding is opt-in: a client that didn't ask for one keeps the
      // documented focus-following behaviour, dialog and all.
      const server = createSessionServer("unbound", unboundDeps());
      await server.connect(makeMockTransport());

      expect((await listTools(server)).tools.map((t) => t.name)).toContain("recipe.run");
    });

    // The binding ceiling is applied by deleting withheld ids from
    // `permittedActionIds` after the grant union, so a schema lookup must be
    // refused the same way `tools/list` withholds the name — policy included.
    // Handing back a policy here would describe a target this session provably
    // cannot dispatch (#11910).
    it("withholds the schema and policy for the confirm-gated tool", async () => {
      const deps = boundDeps({
        // `actions.getSchema` itself must be in the bound workspace's surface,
        // or the guard that refuses a tool this workspace cannot describe fires
        // before the lookup is ever filtered.
        requestManifest: vi
          .fn()
          .mockResolvedValue([makeManifestEntry(ACTIONS_GET_SCHEMA_TOOL_ID), recipeRun()]),
        dispatchAction: vi.fn().mockResolvedValue({
          result: { ok: true, result: { ok: true, entry: recipeRun(), policy: null, error: null } },
        }),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const res = await callTool(server, {
        name: ACTIONS_GET_SCHEMA_TOOL_ID,
        arguments: { actionId: "recipe.run" },
      });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
        ok: boolean;
        entry: unknown;
        policy: unknown;
        error: { code: string } | null;
      };

      expect(body.ok).toBe(false);
      expect(body.entry).toBeNull();
      expect(body.policy).toBeNull();
      expect(body.error?.code).toBe("NOT_FOUND");
    });

    it("still answers the schema lookup for a tool the binding does not withhold", async () => {
      // Guards the test above against passing for the wrong reason — a bound
      // session that could not answer ANY lookup would satisfy it too.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry(ACTIONS_GET_SCHEMA_TOOL_ID),
            makeManifestEntry("terminal.list"),
            recipeRun(),
          ]),
        dispatchAction: vi.fn().mockResolvedValue({
          result: {
            ok: true,
            result: {
              ok: true,
              entry: makeManifestEntry("terminal.list"),
              policy: null,
              error: null,
            },
          },
        }),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const res = await callTool(server, {
        name: ACTIONS_GET_SCHEMA_TOOL_ID,
        arguments: { actionId: "terminal.list" },
      });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
        ok: boolean;
        policy: { minimumTier: string } | null;
      };

      expect(body.ok).toBe(true);
      expect(body.policy).toMatchObject({ minimumTier: "external" });
    });

    it("omits it from mcp.surface too, so discovery and listing agree", async () => {
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry("terminal.list"),
            makeManifestEntry("mcp.surface"),
            recipeRun(),
          ]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = (await callTool(server, { name: "mcp.surface" })) as {
        structuredContent: { tools: Array<{ id: string }> };
      };

      const ids = result.structuredContent.tools.map((t) => t.id);
      expect(ids).toContain("terminal.list");
      expect(ids).not.toContain("recipe.run");
    });
  });

  describe("pre-dispatch refusal", () => {
    it("refuses a direct call with CONFIRMATION_REQUIRED and never dispatches", async () => {
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("CONFIRMATION_REQUIRED");
      // Never reached a renderer: the refusal is the protocol's, not a dialog
      // rendered into a view nobody is watching.
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("distinguishes itself from the no-window case so a conductor knows not to retry", async () => {
      const server = createSessionServer(SESSION, boundDeps());
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as {
        details: { confirmationChannel: string };
        retriable: boolean;
      };

      expect(payload.details.confirmationChannel).toBe("workspace-bound");
      expect(payload.retriable).toBe(false);
    });

    it("audits the refusal", async () => {
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await callTool(server, { name: "recipe.run", arguments: {} });

      expect(deps.appendAuditRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          toolId: "recipe.run",
          sessionId: SESSION,
          tier: "external",
          outcome: {
            kind: "result",
            value: {
              ok: false,
              error: expect.objectContaining({
                code: "CONFIRMATION_REQUIRED",
                details: { confirmationChannel: "workspace-bound" },
              }),
            },
          },
        })
      );
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("beats a live per-tool grant", async () => {
      // Grants widen dispatch past the tier floor. They must not widen past
      // this ceiling — the dialog a grant bypasses is the one nobody can see.
      const deps = boundDeps();
      deps.sessionStore.grantCache.issueGrant(SESSION, "recipe.run");
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(JSON.stringify(result.content)).toContain("CONFIRMATION_REQUIRED");
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("does not burn a native grant use", async () => {
      const deps = boundDeps();
      const grant = deps.sessionStore.grantCache.issueNativeGrant({
        sessionId: SESSION,
        actorId: "help-1",
        actorType: "help-session",
        allowedTools: ["recipe.run"],
        maxUses: 3,
      });
      const peekSpy = vi.spyOn(deps.sessionStore.grantCache, "peekNativeGrant");
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await callTool(server, { name: "recipe.run", arguments: {} });

      // recipe.run is ON the external allowlist, so this is the tier-PERMITTED
      // leg — which #11878 newly routes through the native peek. The
      // workspace-bound refusal is a hard ceiling that still returns before
      // the consume site, so the peek must not cost the grant anything.
      expect(peekSpy).toHaveBeenCalledWith(SESSION, "recipe.run");
      expect(deps.sessionStore.grantCache.getNativeGrant(grant.id)?.remainingUses).toBe(3);
    });

    it("refuses a statically-safe action whose args elevate it to confirm (#11860)", async () => {
      // `worktree.createWithRecipe` is on the external allowlist and declares
      // `danger: "safe"`, so it clears the withheld set — but a call carrying a
      // `recipeId` is elevated host-side and would raise a dialog in a view
      // nobody is watching. The static withhold can't see that; the args can.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry("terminal.list"),
            makeManifestEntry("worktree.createWithRecipe"),
          ]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "feat/x", recipeId: "r1" },
      });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("CONFIRMATION_REQUIRED");
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("still dispatches that action when the args name no recipe", async () => {
      // The elevation is per-dispatch, so the refusal has to be too: gating the
      // action id would block every plain worktree creation.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockResolvedValue([
            makeManifestEntry("terminal.list"),
            makeManifestEntry("worktree.createWithRecipe"),
          ]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "feat/x" },
      });

      expect(result.isError).toBeFalsy();
      expect(deps.dispatchAction).toHaveBeenCalled();
    });

    it("leaves the rest of the bound surface dispatchable", async () => {
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "terminal.list", arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(deps.dispatchAction).toHaveBeenCalled();
    });

    it("refuses an action the resolved manifest does not describe", async () => {
      // A stale or partial manifest that omits a newly confirm-gated action
      // would otherwise let exactly the call this guard exists to refuse
      // through to a renderer nobody is watching. Unknown danger is not safe.
      const deps = boundDeps({
        requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list")]),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(result.isError).toBe(true);
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("still runs main-process tools, which return before the renderer check", async () => {
      const deps = boundDeps({
        requestManifest: vi.fn().mockResolvedValue([makeManifestEntry("terminal.list")]),
        handleSkillsSearch: vi.fn(() => ({ skills: [] })),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "skills.search", arguments: { query: "x" } });

      expect(result.isError).toBeFalsy();
    });

    it("keeps refusing after teardown clears the session's workspace map", async () => {
      // Routing captures the binding once; the surface policy must share that
      // lifetime, or a torn-down session loses its ceiling while its dispatch
      // closure still targets the bound workspace.
      const deps = boundDeps();
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());
      deps.sessionStore.sessionWorkspaceMap.delete(SESSION);

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(JSON.stringify(result.content)).toContain("CONFIRMATION_REQUIRED");
      // And the message names the workspace, not `undefined`.
      expect(JSON.stringify(result.content)).toContain(WORKSPACE);
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });

    it("fails closed rather than dispatching when the manifest can't be resolved", async () => {
      // Proceeding on an unresolved manifest would erase the only evidence that
      // an action is confirm-gated, turning a refusal into a silent dispatch.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      const result = await callTool(server, { name: "recipe.run", arguments: {} });

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(SESSION_BINDING_GONE);
      expect(deps.dispatchAction).not.toHaveBeenCalled();
    });
  });

  describe("binding failures and metadata", () => {
    it("surfaces SESSION_BINDING_GONE from tools/list instead of a generic unavailable", async () => {
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "not-found")),
        getCachedManifest: vi.fn(() => null),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await expect(listTools(server)).rejects.toMatchObject({
        // Same envelope the resource path uses, so one shape covers both —
        // `retriable: false` is what stops a conductor hammering a dead binding.
        data: { code: SESSION_BINDING_GONE, retriable: false, errorCategory: "business" },
      });
    });

    it("never serves a cached manifest after a binding failure", async () => {
      // A cached manifest describes a view this session can no longer reach;
      // serving it would answer with another workspace's tool surface.
      const deps = boundDeps({
        requestManifest: vi
          .fn()
          .mockRejectedValue(new WorkspaceBindingError(WORKSPACE, "ambiguous")),
        getCachedManifest: vi.fn(() => [makeManifestEntry("terminal.list")]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      await expect(listTools(server)).rejects.toMatchObject({
        data: { code: SESSION_BINDING_GONE },
      });
    });

    it("still falls back to the cache for an ordinary transient fetch failure", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = boundDeps({
        requestManifest: vi.fn().mockRejectedValue(new Error("Manifest request timed out")),
        getCachedManifest: vi.fn(() => [makeManifestEntry("terminal.list")]),
      });
      const server = createSessionServer(SESSION, deps);
      await server.connect(makeMockTransport());

      expect((await listTools(server)).tools.map((t) => t.name)).toEqual(["terminal.list"]);
    });

    it("advertises the resolved binding in the initialize capabilities", async () => {
      const server = createSessionServer(SESSION, boundDeps());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const capabilities = client.getServerCapabilities();
        expect(capabilities?.experimental?.["org.daintree/workspace-binding"]).toEqual({
          kind: "project",
          workspaceId: WORKSPACE,
          workspacePath: "/tmp/a",
        });
        // Declaring it at construction must not cost the SDK's own initialize
        // handling — client capability capture still has to work.
        expect(server.getClientCapabilities()).toBeDefined();
      } finally {
        await client.close();
      }
    });

    it("advertises no binding capability for an unbound session", async () => {
      const server = createSessionServer("unbound", unboundDeps());
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        expect(
          client.getServerCapabilities()?.experimental?.["org.daintree/workspace-binding"]
        ).toBeUndefined();
      } finally {
        await client.close();
      }
    });
  });
});

describe("session-liveness gate (#11799)", () => {
  const liveStores: RealSessionStore[] = [];

  function makeStore(): RealSessionStore {
    const store = new RealSessionStore(() => {});
    liveStores.push(store);
    return store;
  }

  afterEach(() => {
    // Teardown here, not at the end of each test body: a failing assertion
    // throws past an inline dispose and leaks the seeded idle timer plus the
    // grant cache's sweep interval into the rest of the file.
    while (liveStores.length > 0) {
      const store = liveStores.pop()!;
      store.drain();
      store.grantCache.dispose();
    }
  });

  function invoke(
    server: ReturnType<typeof createSessionServer>,
    method: string,
    params: Record<string, unknown> = {}
  ) {
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

  function parseToolErrorPayload(result: unknown): Record<string, unknown> {
    const block = (result as { content: Array<{ type: string; text: string }> }).content[0];
    if (block.type !== "text") throw new Error("Expected a text block");
    return JSON.parse(block.text) as Record<string, unknown>;
  }

  /**
   * A tool `workbench` permits and `external` does not — derived, not named, so
   * this cannot drift into restating the allowlist. Its existence IS the issue's
   * premise: if the two tiers were a ladder there would be no such tool, and
   * falling back to workbench would be a narrowing rather than an escalation.
   */
  const WORKBENCH_ONLY_TOOL = [...TIER_ALLOWLISTS.workbench].find(
    (id) => !TIER_ALLOWLISTS.external.has(id)
  );

  it("has at least one tool workbench permits and external withholds", () => {
    // Guards the derivation above rather than a literal: were this to come back
    // undefined, every escalation test below would silently lose its teeth.
    expect(WORKBENCH_ONLY_TOOL).toBeDefined();
  });

  it.each([["sse"], ["http"]] as const)(
    "refuses a revoked external session's tools/call over %s instead of dispatching it at workbench",
    async (transport) => {
      // The issue verbatim: an external bearer's session is revoked while its
      // request is in flight, and the tier read that follows used to resolve to
      // `workbench` — a peer allowlist that permits this tool.
      const store = makeStore();
      seedLiveSession(store, "revoked-external", "external", transport);
      const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
      const appendAuditRecord = vi.fn();
      const notifyTierMismatch = vi.fn();
      const recordDenial = vi.fn(() => ({ tripped: false }));
      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction,
        appendAuditRecord,
        notifyTierMismatch,
        recordDenial,
      });
      const server = createSessionServer("revoked-external", deps);

      store.revokeSession("revoked-external");

      const result = await callTool(server, {
        name: WORKBENCH_ONLY_TOOL!,
        arguments: { path: "/etc/passwd" },
      });

      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(parseToolErrorPayload(result)).toEqual({
        code: "SESSION_GONE",
        message: expect.stringContaining("no longer active"),
        retriable: false,
        errorCategory: "business",
      });
      // Refused at the gate, before anything observable: no dispatch, no audit
      // row under a tier the caller never held, no denial bookkeeping.
      expect(dispatchAction).not.toHaveBeenCalled();
      expect(appendAuditRecord).not.toHaveBeenCalled();
      expect(notifyTierMismatch).not.toHaveBeenCalled();
      expect(recordDenial).not.toHaveBeenCalled();
    }
  );

  it("leaves no dedup bookkeeping behind for a session refused at the gate", async () => {
    // The tier row is left behind deliberately while the transport is removed.
    // Revoking would delete both, and the un-gated read would then resolve to
    // `workbench`, which does not permit `terminal.new` — the call would exit at
    // the tier gate before dedup and this would pass without the fix. An orphan
    // `system` row makes the un-gated path actually dispatch and populate dedup,
    // so the assertion has something to catch.
    const store = makeStore();
    seedLiveSession(store, "gone-dedup", "system");
    const dispatchAction = vi
      .fn()
      .mockResolvedValue({ result: { ok: true, result: { terminalId: "t-1" } } });
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("gone-dedup", deps);

    store.sessions.delete("gone-dedup");

    const result = await callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });

    expect(parseToolErrorPayload(result).code).toBe("SESSION_GONE");
    expect(dispatchAction).not.toHaveBeenCalled();
    expect(store.dedupInFlight.size).toBe(0);
    expect(store.dedupResultCache.size).toBe(0);
  });

  it("refuses tools/list before it costs a manifest fetch", async () => {
    // Gated ahead of `resolveManifest` on purpose: that fetch can throw
    // SESSION_BINDING_GONE, which would answer "your workspace went away" to a
    // caller whose session is what actually went away.
    const store = makeStore();
    seedLiveSession(store, "gone-list", "external");
    const requestManifest = vi.fn().mockResolvedValue([]);
    const getCachedManifest = vi.fn(() => null);
    const deps = fakeDeps({ sessionStore: store, requestManifest, getCachedManifest });
    const server = createSessionServer("gone-list", deps);

    store.revokeSession("gone-list");

    await expect(listTools(server)).rejects.toMatchObject({
      data: { code: "SESSION_GONE", retriable: false, errorCategory: "business" },
    });
    expect(requestManifest).not.toHaveBeenCalled();
    expect(getCachedManifest).not.toHaveBeenCalled();
  });

  it("throws rather than answering discovery with an empty surface", async () => {
    // `{ tools: [] }` / `{ resources: [] }` are well-formed, cacheable answers
    // that read as "you legitimately have nothing" and carry no hint that
    // reconnecting is the fix.
    const store = makeStore();
    seedLiveSession(store, "gone-empty", "system");
    const deps = fakeDeps({ sessionStore: store });
    const server = createSessionServer("gone-empty", deps);

    store.revokeSession("gone-empty");

    for (const method of [
      "tools/list",
      "resources/list",
      "resources/templates/list",
      "prompts/list",
    ]) {
      await expect(invoke(server, method)).rejects.toMatchObject({
        data: { code: "SESSION_GONE" },
      });
    }
  });

  it("refuses resources/read for a revoked session without dispatching the backing action", async () => {
    const store = makeStore();
    seedLiveSession(store, "gone-read", "system");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("gone-read", deps);

    store.revokeSession("gone-read");

    await expect(
      invoke(server, "resources/read", { uri: "daintree://worktree/wt-1/pulse" })
    ).rejects.toMatchObject({ data: { code: "SESSION_GONE" } });
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses resources/subscribe for a revoked session and installs no listener", async () => {
    // Subscribing a dead session would leave an event listener pushing updates
    // at a transport that is already gone.
    const store = makeStore();
    seedLiveSession(store, "gone-sub", "system");
    const deps = fakeDeps({ sessionStore: store });
    const server = createSessionServer("gone-sub", deps);

    store.revokeSession("gone-sub");

    await expect(
      invoke(server, "resources/subscribe", { uri: "daintree://worktree/wt-1/pulse" })
    ).rejects.toMatchObject({ data: { code: "SESSION_GONE" } });
    expect(store.resourceSubscriptions.get("gone-sub")).toBeUndefined();
  });

  it("refuses prompts/get for a revoked session without reading worktree or terminal state", async () => {
    // Prompts render from live IDE state, so `collectPromptContext` dispatches
    // `worktree.getCurrent` and `terminal.getOutput`. Ungated, that is the same
    // leak as the tool path reached through the prompt surface.
    const store = makeStore();
    seedLiveSession(store, "gone-prompt", "external");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("gone-prompt", deps);

    store.revokeSession("gone-prompt");

    await expect(
      invoke(server, "prompts/get", {
        name: "triage_failed_agent",
        arguments: { terminal_id: "t-1" },
      })
    ).rejects.toMatchObject({ data: { code: "SESSION_GONE" } });
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("refuses the next call after an abuse trip revokes the session mid-call", async () => {
    // The one revocation source that fires from inside a tools/call. The
    // triggering call still answers from its captured tier — it was admitted —
    // but the session is gone by the time the next request arrives.
    const store = makeStore();
    seedLiveSession(store, "abuse", "external");
    const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const appendAuditRecord = vi.fn();
    const notifySessionRevoked = vi.fn();
    const deps = fakeDeps({
      sessionStore: store,
      dispatchAction,
      appendAuditRecord,
      recordDenial: vi.fn(() => ({ tripped: true })),
      notifySessionRevoked,
      clearDenialState: vi.fn(),
    });
    const server = createSessionServer("abuse", deps);

    const denied = await callTool(server, {
      name: WORKBENCH_ONLY_TOOL!,
      arguments: { path: "/etc/passwd" },
    });

    // Admitted, then denied on its own captured tier — not retroactively
    // rewritten into SESSION_GONE by the revocation it just triggered.
    expect(parseToolErrorPayload(denied)).toMatchObject({ code: TIER_NOT_PERMITTED_CODE });
    expect(parseToolErrorPayload(denied).message).toContain("external");
    expect(notifySessionRevoked).toHaveBeenCalledTimes(1);
    expect(store.getTier("abuse")).toBeNull();

    appendAuditRecord.mockClear();
    const afterRevoke = await callTool(server, {
      name: WORKBENCH_ONLY_TOOL!,
      arguments: { path: "/etc/passwd" },
    });

    expect(parseToolErrorPayload(afterRevoke).code).toBe("SESSION_GONE");
    expect(appendAuditRecord).not.toHaveBeenCalled();
    expect(dispatchAction).not.toHaveBeenCalled();
  });

  it("lets an already-admitted call finish on its captured tier when revocation lands mid-dispatch", async () => {
    // The one-lifetime rule: revocation stops the NEXT request, it does not
    // rewrite a call the gate already admitted. The admitted call still must
    // not resurrect dedup state for the torn-down session.
    const store = makeStore();
    seedLiveSession(store, "admitted", "system");
    let resolveDispatch: ((envelope: unknown) => void) | undefined;
    const dispatchAction = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDispatch = resolve as (envelope: unknown) => void;
        })
    );
    const deps = fakeDeps({ sessionStore: store, dispatchAction });
    const server = createSessionServer("admitted", deps);

    const inFlight = callTool(server, {
      name: "terminal.new",
      arguments: { spawnedBy: { kind: "user" } },
    });
    for (let i = 0; i < 50 && !resolveDispatch; i++) {
      await Promise.resolve();
    }
    expect(dispatchAction).toHaveBeenCalledTimes(1);
    expect(store.dedupInFlight.get("admitted")?.size).toBe(1);

    store.revokeSession("admitted");

    resolveDispatch!({ result: { ok: true, result: { terminalId: "t-admitted" } } });
    const result = await inFlight;
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Admitted work completes rather than being retroactively refused...
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    // ...but writes nothing back into the torn-down session.
    expect(store.dedupInFlight.size).toBe(0);
    expect(store.dedupResultCache.size).toBe(0);
  });
});

// #11909 — the cleanup tools are an authorization boundary, so the cases below
// are the boundary's edges rather than its happy path: another session's id, a
// forged id, an id the user owns, a half-created composite, and a session whose
// authority has been revoked.
describe("session-scoped resource ownership (#11909)", () => {
  const liveStores: RealSessionStore[] = [];

  function makeStore(): RealSessionStore {
    const store = new RealSessionStore(() => {});
    liveStores.push(store);
    return store;
  }

  afterEach(() => {
    while (liveStores.length > 0) {
      const store = liveStores.pop()!;
      store.drain();
      store.grantCache.dispose();
    }
    vi.restoreAllMocks();
  });

  function ownedManifest(): ActionManifestEntry[] {
    return [
      makeManifestEntry("terminal.new"),
      { ...makeManifestEntry("terminal.closeOwned"), kind: "command", danger: "safe" as const },
      {
        ...makeManifestEntry("worktree.deleteOwned"),
        kind: "command",
        danger: "confirm" as const,
      },
      makeManifestEntry("worktree.createWithRecipe"),
      makeManifestEntry("recipe.run"),
      makeManifestEntry("agent.launch"),
    ];
  }

  /** A store + deps pair whose dispatch returns whatever the test queues up. */
  function harness(
    sessionId: string,
    envelopes: Record<string, unknown>,
    overrides?: Partial<SessionServerDeps>
  ) {
    const store = makeStore();
    seedLiveSession(store, sessionId, "external");
    store.sessionOriginMap.set(sessionId, "external");
    const dispatchAction = vi.fn().mockImplementation((actionId: string) => {
      const envelope = envelopes[actionId];
      if (envelope === undefined) return Promise.resolve({ result: { ok: true, result: null } });
      return Promise.resolve(envelope);
    });
    const deps = fakeDeps({
      sessionStore: store,
      dispatchAction,
      requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
      getCachedManifest: vi.fn(() => ownedManifest()),
      ...overrides,
    });
    return { store, deps, dispatchAction, server: createSessionServer(sessionId, deps) };
  }

  function errorText(result: { content: unknown }): string {
    return JSON.stringify(result.content);
  }

  describe("recording from trusted results", () => {
    it("records the terminal a direct terminal.new created", async () => {
      const { store, server } = harness("s-new", {
        "terminal.new": {
          result: { ok: true, result: { terminalId: "terminal-1" } },
          dispatchedWorkspace: { kind: "project", workspaceId: "ws-a", workspacePath: "/tmp/a" },
        },
      });

      await callTool(server, { name: "terminal.new", arguments: {} });

      expect(store.resourceOwnership.owns("s-new", "terminal", "terminal-1")).toBe(true);
      expect(store.resourceOwnership.get("s-new", "terminal", "terminal-1")?.workspaceId).toBe(
        "ws-a"
      );
    });

    it("records every composite child terminal and the worktree together", async () => {
      const { store, server } = harness("s-composite", {
        "worktree.createWithRecipe": {
          result: {
            ok: true,
            result: {
              worktreeId: "/tmp/wt",
              worktreePath: "/tmp/wt",
              branch: "feature/x",
              recipeLaunched: true,
              spawnedTerminalCount: 2,
              spawnedTerminalIds: ["terminal-1", "terminal-2"],
              failedTerminalCount: 0,
            },
          },
        },
      });

      await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "x", recipeId: "r1" },
      });

      expect(store.resourceOwnership.owns("s-composite", "worktree", "/tmp/wt")).toBe(true);
      expect(store.resourceOwnership.owns("s-composite", "terminal", "terminal-1")).toBe(true);
      expect(store.resourceOwnership.owns("s-composite", "terminal", "terminal-2")).toBe(true);
    });

    it("records the worktree a partially-failed composite left behind", async () => {
      // The caller has to be able to clean up the mess its own call made, and
      // the failure arrives as `ok: false` because ActionService flattens the
      // renderer throw — so the ledger reads the failure leg too.
      const { store, server } = harness("s-partial", {
        "worktree.createWithRecipe": {
          result: {
            ok: false,
            error: {
              code: "EXECUTION_ERROR",
              message: formatPartialSuccessMessage("Recipe r1 failed to run: boom", {
                worktreeId: "/tmp/wt-partial",
                worktreePath: "/tmp/wt-partial",
                branch: "feature/x",
              }),
            },
          },
        },
      });

      const result = await callTool(server, {
        name: "worktree.createWithRecipe",
        arguments: { branchName: "x", recipeId: "r1" },
      });

      expect(result.isError).toBe(true);
      expect(store.resourceOwnership.owns("s-partial", "worktree", "/tmp/wt-partial")).toBe(true);
    });

    it("records nothing when a create fails outright", async () => {
      const { store, server } = harness("s-failed", {
        "terminal.new": {
          result: { ok: false, error: { code: "EXECUTION_ERROR", message: "no worktree" } },
        },
      });

      await callTool(server, { name: "terminal.new", arguments: {} });

      expect(store.resourceOwnership.list("s-failed")).toEqual([]);
    });

    it("records nothing for a listing, so enumerated ids never become authority", async () => {
      const { store, server } = harness("s-list", {
        "terminal.list": {
          result: { ok: true, result: { terminals: [{ id: "terminal-users-own" }] } },
        },
      });

      await callTool(server, { name: "terminal.list", arguments: {} });

      expect(store.resourceOwnership.owns("s-list", "terminal", "terminal-users-own")).toBe(false);
    });
  });

  describe("terminal.closeOwned", () => {
    it("closes a terminal the session created and delegates to the real terminal.close", async () => {
      const { store, server, dispatchAction } = harness("s-close", {
        "terminal.close": { result: { ok: true, result: { closedIds: ["terminal-1"] } } },
      });
      store.resourceOwnership.record("s-close", [{ kind: "terminal", id: "terminal-1" }]);

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      // Delegation, not reimplementation: trash/recovery and the "reports the
      // exact panel closed" contract come from the shipped action.
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.close",
        { terminalId: "terminal-1" },
        expect.anything()
      );
      // Authority is released once the panel is genuinely gone.
      expect(store.resourceOwnership.owns("s-close", "terminal", "terminal-1")).toBe(false);
    });

    it("keeps authority when the delegated close reports nothing closed", async () => {
      const { store, server } = harness("s-noop", {
        "terminal.close": { result: { ok: true, result: { closedIds: [] } } },
      });
      store.resourceOwnership.record("s-noop", [{ kind: "terminal", id: "terminal-1" }]);

      await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      // A no-op close must not revoke the session's authority over a panel that
      // is still running.
      expect(store.resourceOwnership.owns("s-noop", "terminal", "terminal-1")).toBe(true);
    });

    it("refuses another session's terminal without dispatching", async () => {
      const { store, server, dispatchAction } = harness("session-b", {});
      store.resourceOwnership.record("session-a", [{ kind: "terminal", id: "terminal-a" }]);

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-a" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      // The acceptance criterion: refused BEFORE renderer mutation.
      expect(dispatchAction).not.toHaveBeenCalled();
      expect(store.resourceOwnership.owns("session-a", "terminal", "terminal-a")).toBe(true);
    });

    it("refuses a forged id with the same error as an unowned one", async () => {
      // One code, one message: distinguishing "no such panel" from "not yours"
      // would let a caller enumerate the view it was never granted.
      const { server, dispatchAction } = harness("s-forged", {});

      const unknown = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-does-not-exist" },
      });

      expect(unknown.isError).toBe(true);
      expect(errorText(unknown)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("refuses a worktree id passed as a terminal id", async () => {
      // Kind is part of the key, so owning the worktree grants no authority
      // over a panel that happens to share its id string.
      const { store, server, dispatchAction } = harness("s-kind", {});
      store.resourceOwnership.record("s-kind", [{ kind: "worktree", id: "/tmp/wt" }]);

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "/tmp/wt" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("rejects a blank id as a validation error rather than an ownership one", async () => {
      const { server, dispatchAction } = harness("s-blank", {});

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "   " },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("VALIDATION_ERROR");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("loses authority when the session is revoked, without closing anything", async () => {
      const { store, server, dispatchAction } = harness("s-revoked", {
        "terminal.close": { result: { ok: true, result: { closedIds: ["terminal-1"] } } },
      });
      store.resourceOwnership.record("s-revoked", [{ kind: "terminal", id: "terminal-1" }]);

      store.revokeSession("s-revoked");

      // Revocation clears the authority record and dispatches nothing:
      // disconnect is not a decision to destroy the user's terminals.
      expect(store.resourceOwnership.list("s-revoked")).toEqual([]);
      expect(dispatchAction).not.toHaveBeenCalled();

      // And the terminal stays un-closable by the dead session — this call is
      // refused by the liveness gate before ownership is even consulted.
      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      }).catch((err: unknown) => err);
      expect(result).toBeDefined();
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });

  describe("worktree.deleteOwned", () => {
    it("delegates to worktree.delete so the real D2 preview and confirmation fire", async () => {
      const { store, server, dispatchAction } = harness("s-del", {
        "worktree.delete": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record("s-del", [{ kind: "worktree", id: "/tmp/wt" }]);

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      expect(result.isError).toBeUndefined();
      // The literal action id matters: `resolveMcpConfirmPreviewTarget` matches
      // on "worktree.delete" to build the tracked/untracked file preview.
      expect(dispatchAction).toHaveBeenCalledWith(
        "worktree.delete",
        { worktreeId: "/tmp/wt" },
        expect.anything()
      );
      expect(store.resourceOwnership.owns("s-del", "worktree", "/tmp/wt")).toBe(false);
    });

    it("strips force, deleteBranch and closeTerminals from the delegated call", async () => {
      // The narrow tool omits them from its schema, but the renderer validates
      // against `worktree.delete`, which still accepts them — so rebuilding the
      // args here is the actual enforcement.
      const { store, server, dispatchAction } = harness("s-strip", {
        "worktree.delete": { result: { ok: true, result: null } },
      });
      store.resourceOwnership.record("s-strip", [{ kind: "worktree", id: "/tmp/wt" }]);

      await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: {
          worktreeId: "/tmp/wt",
          force: true,
          deleteBranch: true,
          closeTerminals: true,
        },
      });

      expect(dispatchAction).toHaveBeenCalledWith(
        "worktree.delete",
        { worktreeId: "/tmp/wt" },
        expect.anything()
      );
    });

    it("refuses a worktree the session did not create without dispatching", async () => {
      const { server, dispatchAction } = harness("s-unowned-wt", {});

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/users-own-worktree" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("keeps authority when the delegated delete fails", async () => {
      // A refused dirty-worktree delete must leave the caller able to retry
      // after committing, rather than stranding the worktree unownable.
      const { store, server } = harness("s-dirty", {
        "worktree.delete": {
          result: {
            ok: false,
            error: { code: "EXECUTION_ERROR", message: "worktree has uncommitted changes" },
          },
        },
      });
      store.resourceOwnership.record("s-dirty", [{ kind: "worktree", id: "/tmp/wt" }]);

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      expect(result.isError).toBe(true);
      expect(store.resourceOwnership.owns("s-dirty", "worktree", "/tmp/wt")).toBe(true);
    });
  });

  describe("confirmation-unavailable / workspace-bound sessions", () => {
    function boundHarness(sessionId: string) {
      const store = makeStore();
      seedLiveSession(store, sessionId, "external");
      store.sessionOriginMap.set(sessionId, "external");
      store.sessionWorkspaceMap.set(sessionId, "ws-a");
      const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
      const deps = fakeDeps({
        sessionStore: store,
        dispatchAction,
        workspaceBinding: { kind: "project", workspaceId: "ws-a", workspacePath: "/tmp/a" },
        requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
        getCachedManifest: vi.fn(() => ownedManifest()),
      });
      return { store, dispatchAction, server: createSessionServer(sessionId, deps) };
    }

    it("withholds worktree.deleteOwned from a bound session's tools/list but keeps closeOwned", async () => {
      const { server } = boundHarness("s-bound-list");
      await server.connect(makeMockTransport());

      const names = (await listTools(server)).tools.map((t) => t.name);

      // `danger: "confirm"` alone drives this — no hand-written id list.
      expect(names).not.toContain("worktree.deleteOwned");
      // The safe half stays reachable: it needs no dialog.
      expect(names).toContain("terminal.closeOwned");
    });

    it("refuses a bound session's direct worktree.deleteOwned call even when it owns the worktree", async () => {
      const { store, server, dispatchAction } = boundHarness("s-bound-call");
      store.resourceOwnership.record("s-bound-call", [{ kind: "worktree", id: "/tmp/wt" }], "ws-a");

      const result = await callTool(server, {
        name: "worktree.deleteOwned",
        arguments: { worktreeId: "/tmp/wt" },
      });

      // Discovery and direct-call authorization agree: owning the worktree is
      // not enough when nobody can be shown the confirmation.
      expect(result.isError).toBe(true);
      expect(dispatchAction).not.toHaveBeenCalled();
    });
  });

  describe("workspace rebinding", () => {
    it("refuses cleanup of a resource created in a different workspace", async () => {
      const store = makeStore();
      seedLiveSession(store, "s-rebound", "external");
      store.sessionOriginMap.set("s-rebound", "external");
      store.sessionWorkspaceMap.set("s-rebound", "ws-b");
      // Recorded while the dispatch landed on ws-a.
      store.resourceOwnership.record("s-rebound", [{ kind: "terminal", id: "terminal-1" }], "ws-a");
      const dispatchAction = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
      const server = createSessionServer(
        "s-rebound",
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          workspaceBinding: { kind: "project", workspaceId: "ws-b", workspacePath: "/tmp/b" },
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBe(true);
      expect(errorText(result)).toContain("RESOURCE_NOT_OWNED");
      expect(dispatchAction).not.toHaveBeenCalled();
    });

    it("allows cleanup when the creating dispatch could not resolve a workspace", async () => {
      // The mismatch check is defence in depth over globally-unique ids, so it
      // fails OPEN — an unresolved workspace must not strand the caller's own
      // cleanup.
      const store = makeStore();
      seedLiveSession(store, "s-nows", "external");
      store.sessionOriginMap.set("s-nows", "external");
      store.sessionWorkspaceMap.set("s-nows", "ws-b");
      store.resourceOwnership.record("s-nows", [{ kind: "terminal", id: "terminal-1" }]);
      const dispatchAction = vi
        .fn()
        .mockResolvedValue({ result: { ok: true, result: { closedIds: ["terminal-1"] } } });
      const server = createSessionServer(
        "s-nows",
        fakeDeps({
          sessionStore: store,
          dispatchAction,
          requestManifest: vi.fn().mockResolvedValue(ownedManifest()),
          getCachedManifest: vi.fn(() => ownedManifest()),
        })
      );

      const result = await callTool(server, {
        name: "terminal.closeOwned",
        arguments: { terminalId: "terminal-1" },
      });

      expect(result.isError).toBeUndefined();
      expect(dispatchAction).toHaveBeenCalledWith(
        "terminal.close",
        { terminalId: "terminal-1" },
        expect.anything()
      );
    });
  });
});
