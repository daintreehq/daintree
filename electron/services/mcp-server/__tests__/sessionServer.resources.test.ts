import { describe, expect, it, vi } from "vitest";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

vi.mock("electron", () => ({
  app: {
    getVersion: () => "0.0.0-test",
  },
}));

import { createSessionServer } from "../sessionServer.js";
import { getAgentAvailabilityStore } from "../../AgentAvailabilityStore.js";
import { events } from "../../events.js";
import { fakeSessionStore, fakeDeps, makeMockTransport } from "./helpers/sessionServerFixture.js";

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
    // payload attached as `data`, mirroring the tool-path JSON envelope. The
    // pulse resource rides `git.getProjectPulse`, which is in the full tool set.
    const deps = fakeDeps({
      sessionStore: fakeSessionStore("full"),
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
      sessionStore: fakeSessionStore("full"),
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
      sessionStore: fakeSessionStore("full"),
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
