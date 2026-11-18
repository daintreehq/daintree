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
import {
  fakeSessionStore,
  fakeDeps,
  makeMockTransport,
  callHandler,
} from "./helpers/sessionServerFixture.js";
import {
  RESOURCE_TEXT_MAX_BYTES,
  SESSION_BINDING_GONE,
  WORKSPACE_BINDING_RESOURCE_URI,
  type DispatchEnvelope,
} from "../shared.js";
import { SessionBindingError } from "../rendererBridge.js";

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

  describe("oversized JSON resources (#17490)", () => {
    async function readText(uri: string, result: unknown): Promise<string> {
      const deps = fakeDeps({
        sessionStore: fakeSessionStore("full"),
        dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result } }),
      });
      const server = createSessionServer(`s-res-oversized-${uri}`, deps);
      await server.connect(makeMockTransport());
      const read = (await readResource(server, uri)) as {
        contents: { uri: string; mimeType: string; text: string }[];
      };
      expect(read.contents[0].mimeType).toBe("application/json");
      return read.contents[0].text;
    }

    function issueRow(n: number) {
      return {
        number: n,
        title: `Issue ${n} ${"é".repeat(120)}`,
        state: "OPEN",
        url: `https://github.com/acme/repo/issues/${n}`,
        author: "octocat",
        assignees: ["octocat"],
        labels: ["bug", "needs-triage"],
        createdAt: 1_700_000_000_000 + n,
        updatedAt: 1_700_000_100_000 + n,
      };
    }

    it("keeps an over-budget issue page parseable, in budget, and marked partial", async () => {
      const items = Array.from({ length: 400 }, (_, i) => issueRow(i + 1));
      const page = { items, nextCursor: "cursor-2", hasMore: true, totalCount: 900 };
      expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeGreaterThan(
        RESOURCE_TEXT_MAX_BYTES
      );

      const text = await readText("daintree://project/current/issues", page);

      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(RESOURCE_TEXT_MAX_BYTES);
      const parsed = JSON.parse(text);
      expect(parsed.items.length).toBeGreaterThan(0);
      expect(parsed.items.length).toBeLessThan(items.length);
      expect(parsed.items).toEqual(items.slice(0, parsed.items.length));
      expect(parsed.nextCursor).toBe("cursor-2");
      expect(parsed.hasMore).toBe(true);
      expect(parsed.totalCount).toBe(900);
      expect(parsed.truncated).toEqual({
        maxBytes: RESOURCE_TEXT_MAX_BYTES,
        originalBytes: Buffer.byteLength(JSON.stringify(page), "utf8"),
        omitted: { items: items.length - parsed.items.length },
        note: expect.stringContaining("nextCursor"),
      });
    });

    it("keeps an over-budget pulse parseable, in budget, and marked partial", async () => {
      const heatmap = Array.from({ length: 1_500 }, (_, i) => ({
        date: `day-${String(i).padStart(4, "0")}`,
        count: i % 7,
        level: i % 5,
      }));
      const recentCommits = Array.from({ length: 10 }, (_, i) => ({
        sha: `${i}`.padStart(40, "a"),
        subject: `Commit ${i} ${"ü".repeat(200)}`,
        authorName: "Dev",
        timestamp: 1_700_000_000_000 - i,
      }));
      const pulse = {
        worktreeId: "wt-1",
        worktreePath: "/repo",
        branch: "feature/x",
        mainBranch: "main",
        rangeDays: 60,
        generatedAt: 1_700_000_000_000,
        heatmap,
        commitsInRange: 321,
        activeDays: 40,
        projectAgeDays: 900,
        currentStreakDays: 3,
        recentCommits,
      };
      expect(Buffer.byteLength(JSON.stringify(pulse), "utf8")).toBeGreaterThan(
        RESOURCE_TEXT_MAX_BYTES
      );

      const text = await readText("daintree://worktree/wt-1/pulse", pulse);

      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(RESOURCE_TEXT_MAX_BYTES);
      const parsed = JSON.parse(text);
      expect(parsed.worktreeId).toBe("wt-1");
      expect(parsed.commitsInRange).toBe(321);
      expect(parsed.currentStreakDays).toBe(3);
      expect(parsed.heatmap.length).toBeGreaterThan(0);
      expect(parsed.heatmap.length).toBeLessThan(heatmap.length);
      // The newest days are the ones kept.
      expect(parsed.heatmap).toEqual(heatmap.slice(-parsed.heatmap.length));
      expect(parsed.recentCommits).toEqual(recentCommits);
      expect(parsed.truncated).toEqual({
        maxBytes: RESOURCE_TEXT_MAX_BYTES,
        originalBytes: Buffer.byteLength(JSON.stringify(pulse), "utf8"),
        omitted: { heatmap: heatmap.length - parsed.heatmap.length },
      });
    });

    it("drops a pulse's oldest days before its newest commits, then its oldest commits", async () => {
      const heatmap = Array.from({ length: 60 }, (_, i) => ({
        date: `2026-09-${String(i).padStart(2, "0")}`,
        count: i % 3,
        level: i % 5,
      }));
      // Newest first, as `git log` lists them; together far past the cap.
      const recentCommits = Array.from({ length: 10 }, (_, i) => ({
        sha: `${i}`.padStart(40, "c"),
        subject: `Commit ${i} ${"ß".repeat(3_000)}`,
        timestamp: 1_700_000_000_000 - i,
      }));
      const pulse = {
        worktreeId: "wt-1",
        worktreePath: "/repo",
        mainBranch: "main",
        rangeDays: 60,
        generatedAt: 1_700_000_000_000,
        heatmap,
        commitsInRange: 10,
        activeDays: 10,
        projectAgeDays: 90,
        recentCommits,
      };

      const text = await readText("daintree://worktree/wt-1/pulse", pulse);

      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(RESOURCE_TEXT_MAX_BYTES);
      const parsed = JSON.parse(text);
      const keptCommits = parsed.recentCommits.length;
      const keptDays = parsed.heatmap.length;
      expect(keptCommits).toBeGreaterThan(0);
      expect(keptCommits).toBeLessThan(recentCommits.length);
      expect(parsed.recentCommits).toEqual(recentCommits.slice(0, keptCommits));
      expect(parsed.heatmap).toEqual(heatmap.slice(heatmap.length - keptDays));
      expect(parsed.truncated.omitted).toEqual({
        recentCommits: recentCommits.length - keptCommits,
        ...(keptDays < heatmap.length ? { heatmap: heatmap.length - keptDays } : {}),
      });
      // Commits were placed against an empty heatmap, and no further one fits there.
      const oneMoreCommit = JSON.stringify({
        ...parsed,
        truncated: {
          ...parsed.truncated,
          omitted: {
            recentCommits: recentCommits.length - keptCommits - 1,
            heatmap: heatmap.length,
          },
        },
        heatmap: [],
        recentCommits: recentCommits.slice(0, keptCommits + 1),
      });
      expect(Buffer.byteLength(oneMoreCommit, "utf8")).toBeGreaterThan(RESOURCE_TEXT_MAX_BYTES);
    });
  });
});

describe("resources/list reads its independent categories together (#17492)", () => {
  type Dispatch = (actionId: string, args?: unknown) => Promise<DispatchEnvelope>;
  const ok = (result: unknown): DispatchEnvelope => ({ result: { ok: true, result } });
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  // A macrotask turn drains every microtask the handler queued before its
  // first real wait, so "not dispatched yet" means it is waiting, not late.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  async function listingServer(dispatchAction: Dispatch) {
    const deps = fakeDeps({ sessionStore: fakeSessionStore("full"), dispatchAction });
    const server = createSessionServer("s_list_concurrent", deps);
    await server.connect(makeMockTransport());
    return server;
  }

  it("starts terminal.list while worktree.list is still pending, keeping the listing order", async () => {
    const worktrees = deferred<DispatchEnvelope>();
    const terminals = deferred<DispatchEnvelope>();
    const dispatchAction = vi.fn<Dispatch>((actionId) => {
      if (actionId === "worktree.list") return worktrees.promise;
      if (actionId === "terminal.list") return terminals.promise;
      return Promise.resolve(ok(null));
    });
    const server = await listingServer(dispatchAction);

    const listing = callHandler(server, "resources/list", {}) as Promise<{
      resources: Array<{ uri: string }>;
    }>;
    await settle();

    expect(dispatchAction.mock.calls.map(([id]) => id)).toEqual(["worktree.list", "terminal.list"]);

    // Settled in the reverse of listing order, so an order that followed
    // arrival would put the terminal entries first.
    terminals.resolve(ok([{ id: "t-1", title: "Shell", agentId: "claude" }]));
    await settle();
    worktrees.resolve(ok([{ id: "wt-1", branch: "main" }]));

    expect((await listing).resources.map((r) => r.uri)).toEqual([
      WORKSPACE_BINDING_RESOURCE_URI,
      "daintree://project/current/issues",
      "daintree://worktree/wt-1/pulse",
      "daintree://terminal/t-1/scrollback",
      "daintree://agent/claude/state",
    ]);
  });

  it("keeps each read's own failure handling: a failed worktree read drops only its entries", async () => {
    const worktrees = deferred<DispatchEnvelope>();
    const dispatchAction = vi.fn<Dispatch>((actionId) => {
      if (actionId === "worktree.list") return worktrees.promise;
      if (actionId === "terminal.list") {
        return Promise.resolve(ok([{ id: "t-1", title: "Shell" }]));
      }
      return Promise.resolve(ok(null));
    });
    const server = await listingServer(dispatchAction);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const listing = callHandler(server, "resources/list", {}) as Promise<{
        resources: Array<{ uri: string }>;
      }>;
      await settle();
      worktrees.reject(new Error("renderer hiccup"));

      const uris = (await listing).resources.map((r) => r.uri);
      expect(uris.some((uri) => uri.startsWith("daintree://worktree/"))).toBe(false);
      expect(uris).toContain("daintree://terminal/t-1/scrollback");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("refuses for a dead pin on worktree.list without waiting on a slow terminal.list", async () => {
    const terminals = deferred<DispatchEnvelope>();
    const dispatchAction = vi.fn<Dispatch>((actionId) => {
      if (actionId === "worktree.list") return Promise.reject(new SessionBindingError(1234));
      if (actionId === "terminal.list") return terminals.promise;
      return Promise.resolve(ok(null));
    });
    const server = await listingServer(dispatchAction);

    await expect(callHandler(server, "resources/list", {})).rejects.toMatchObject({
      data: { code: SESSION_BINDING_GONE },
    });

    // The read still out when the request gave up may fail later; that must
    // not surface as an unhandled rejection.
    expect(dispatchAction).toHaveBeenCalledWith("terminal.list", {});
    terminals.reject(new SessionBindingError(1234));
    await settle();
  });

  it("surfaces the worktree read's refusal when both reads refuse, whichever settles first", async () => {
    const worktrees = deferred<DispatchEnvelope>();
    const dispatchAction = vi.fn<Dispatch>((actionId) => {
      if (actionId === "worktree.list") return worktrees.promise;
      if (actionId === "terminal.list") return Promise.reject(new SessionBindingError(2));
      return Promise.resolve(ok(null));
    });
    const server = await listingServer(dispatchAction);

    const listing = callHandler(server, "resources/list", {});
    const outcome = listing.then(
      () => null,
      (err: unknown) => err
    );
    await settle();
    // Both refusals have to exist for the precedence to mean anything.
    expect(dispatchAction).toHaveBeenCalledWith("terminal.list", {});
    worktrees.reject(new SessionBindingError(1));

    const err = (await outcome) as { message?: string; data?: { code?: string } } | null;
    expect(err?.data?.code).toBe(SESSION_BINDING_GONE);
    // McpError prefixes its own code; the dead pin's id is what tells them apart.
    expect(err?.message).toContain(new SessionBindingError(1).message);
  });

  it("still refuses for a dead pin on terminal.list after worktree.list succeeds", async () => {
    const dispatchAction = vi.fn<Dispatch>((actionId) => {
      if (actionId === "worktree.list") return Promise.resolve(ok([{ id: "wt-1" }]));
      if (actionId === "terminal.list") return Promise.reject(new SessionBindingError(7));
      return Promise.resolve(ok(null));
    });
    const server = await listingServer(dispatchAction);

    await expect(callHandler(server, "resources/list", {})).rejects.toMatchObject({
      data: { code: SESSION_BINDING_GONE },
    });
  });
});
