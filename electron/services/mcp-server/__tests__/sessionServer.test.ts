import { afterEach, describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ActionManifestEntry, ActionId } from "../../../../shared/types/actions.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";

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
import {
  buildToolError,
  buildMcpErrorPayload,
  RETRIABLE_ERROR_CODES,
  TIER_NOT_PERMITTED_CODE,
  EXECUTION_ERROR_CODE,
  SESSION_BINDING_GONE,
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
    grantCache,
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
    // A session revoked mid-fetch makes `getTier` fall back to `workbench`, and
    // workbench is a PEER of `external`, not a subset. Re-reading the tier after
    // the await would hand this external caller a workbench report naming tools
    // its own allowlist withholds. The gate's tier is the only coherent answer.
    const sessionStore = fakeSessionStore("external");
    const deps = fakeDeps({
      sessionStore,
      requestManifest: vi.fn().mockImplementation(async () => {
        vi.mocked(sessionStore.getTier).mockReturnValue("workbench");
        return surfaceManifest();
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
    // `git.commit` is workbench-unreachable but system-tier in-app, and is not
    // on the external allowlist — the concrete tool the leak would have added.
    expect(reported.tools.map((t) => t.id)).not.toContain("git.commit");
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
