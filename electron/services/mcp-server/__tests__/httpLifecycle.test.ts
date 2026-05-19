import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Mock store BEFORE imports. The source file imports from "../../store.js"
// which resolves to electron/store.js. From this test file (one directory deeper),
// the correct relative path is "../../../store.js".
vi.mock("../../../store.js", () => ({
  store: {
    get: vi.fn().mockReturnValue({
      enabled: true,
      port: 45454,
      apiKey: "test-api-key",
    }),
  },
}));

import http from "node:http";
import { EventEmitter } from "node:events";
import { HttpLifecycle } from "../httpLifecycle.js";
import type { HttpLifecycleDeps } from "../httpLifecycle.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockServer = any;

function mockServer(port = 45454): MockServer {
  const s = new EventEmitter() as unknown as MockServer;
  s.closeAllConnections = vi.fn();
  s.close = vi.fn((cb?: () => void) => {
    cb?.();
    return s;
  });
  s.listen = vi.fn((_p: number, _h: string, cb?: () => void) => {
    Object.defineProperty(s, "listening", { value: true, writable: true, configurable: true });
    cb?.();
    return s;
  });
  s.address = vi.fn(() => ({ port, family: "IPv4" as const, address: "127.0.0.1" }));
  Object.defineProperty(s, "listening", { value: false, writable: true, configurable: true });
  s.keepAliveTimeout = 5000;
  s.headersTimeout = 60000;
  s.requestTimeout = 300000;
  return s;
}

function fakeDeps(overrides?: Partial<HttpLifecycleDeps>): HttpLifecycleDeps {
  return {
    sessionStore: {
      sessions: new Map(),
      httpSessions: new Map(),
      sessionTierMap: new Map(),
      sessionWebContentsMap: new Map(),
      sessionContextMap: new Map(),
      resourceSubscriptions: new Map(),
      drain: vi.fn(),
      getTier: vi.fn(() => "workbench" as const),
      createIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
      createHttpIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
      resetIdleTimer: vi.fn(),
      resetHttpIdleTimer: vi.fn(),
    },
    auditService: {
      hydrate: vi.fn(),
      flushNow: vi.fn(),
      appendRecord: vi.fn(),
      recordAuth401: vi.fn(),
      getAuditStats: vi.fn(() => ({ auth401Count: 0 })),
    },
    turnOutcomeService: {
      flushNow: vi.fn(),
      handleTransition: vi.fn(),
      appendOutput: vi.fn(),
      dropTerminal: vi.fn(),
      recordDirectOutcome: vi.fn(),
      getRecords: vi.fn(() => []),
      clear: vi.fn(),
      getCurrentTurnIdForSession: vi.fn(() => null),
    },
    requestManifest: vi.fn().mockResolvedValue([]),
    dispatchAction: vi.fn().mockResolvedValue({ result: { ok: true, result: null } }),
    handleWaitUntilIdle: vi.fn(),
    getCachedManifest: vi.fn(() => null),
    clearCachedManifest: vi.fn(),
    cleanupListeners: [],
    pendingManifests: new Map(),
    pendingDispatches: new Map(),
    setupIpcListeners: vi.fn(),
    emitStatusChange: vi.fn(),
    emitRuntimeStateChange: vi.fn(),
    setConfig: vi.fn(),
    ...overrides,
  } as unknown as HttpLifecycleDeps;
}

describe("HttpLifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("server timeouts", () => {
    it("sets keepAliveTimeout=30_000 and headersTimeout=60_000", async () => {
      let capturedServer: http.Server | null = null;
      vi.spyOn(http, "createServer").mockImplementation(((...args: unknown[]) => {
        const handler = args.find((a) => typeof a === "function") as
          | http.RequestListener
          | undefined;
        const s = mockServer();
        capturedServer = s;
        if (handler) s.on("request", handler);
        return s;
      }) as unknown as typeof http.createServer);

      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      lc.isEnabled = () => true;

      await expect(lc.start({} as unknown as never)).resolves.toBeUndefined();

      expect(capturedServer).not.toBeNull();
      expect(capturedServer!.keepAliveTimeout).toBe(30_000);
      expect(capturedServer!.headersTimeout).toBe(60_000);
    });
  });

  describe("listenWithRetry", () => {
    it("retries on EADDRINUSE and succeeds on next port", async () => {
      const s = mockServer(45456);
      let attempts = 0;
      s.listen.mockImplementation((_port: number, _host: string, cb?: () => void) => {
        attempts++;
        if (attempts < 3) {
          s.emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
          return s;
        }
        Object.defineProperty(s, "listening", { value: true, writable: true, configurable: true });
        s.address = vi.fn(() => ({ port: 45456, family: "IPv4" as const, address: "127.0.0.1" }));
        cb?.();
        return s;
      });

      const lc = new HttpLifecycle(fakeDeps());
      const result = await (
        lc as unknown as {
          listenWithRetry: (s: http.Server, p: number) => Promise<number | null>;
        }
      ).listenWithRetry(s, 45454);

      expect(result).toBe(45456);
      expect(attempts).toBe(3);
    });

    it("returns null after exhausting all retries", async () => {
      const s = mockServer();
      s.listen.mockImplementation(() => {
        s.emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
        return s;
      });

      const lc = new HttpLifecycle(fakeDeps());
      const result = await (
        lc as unknown as {
          listenWithRetry: (s: http.Server, p: number) => Promise<number | null>;
        }
      ).listenWithRetry(s, 45454);

      expect(result).toBeNull();
    });
  });

  describe("IPC listener lifecycle", () => {
    it("does not call setupIpcListeners when bind fails", async () => {
      const setupIpcListeners = vi.fn();
      const deps = fakeDeps({ setupIpcListeners });

      const s = mockServer();
      s.listen.mockImplementation(() => {
        s.emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
        return s;
      });
      vi.spyOn(http, "createServer").mockReturnValue(s);

      const lc = new HttpLifecycle(deps);
      lc.isEnabled = () => true;

      await expect(lc.start({} as unknown as never)).rejects.toThrow("Failed to bind");

      expect(setupIpcListeners).not.toHaveBeenCalled();
    });
  });

  describe("stop()", () => {
    it("calls closeAllConnections before close", async () => {
      const deps = fakeDeps();
      const s = mockServer();
      (s as MockServer & { listening: boolean }).listening = true;
      const callOrder: string[] = [];
      s.closeAllConnections.mockImplementation(() => {
        callOrder.push("closeAllConnections");
      });
      s.close.mockImplementation((cb?: () => void) => {
        callOrder.push("close");
        cb?.();
        return s;
      });

      const lc = new HttpLifecycle(deps);
      (lc as unknown as { httpServer: MockServer }).httpServer = s;
      (lc as unknown as { port: number }).port = 45454;

      await lc.stop();

      expect(callOrder[0]).toBe("closeAllConnections");
      expect(callOrder[1]).toBe("close");
    });

    it("resolves after timeout when close hangs", async () => {
      const deps = fakeDeps();
      const s = mockServer();
      (s as MockServer & { listening: boolean }).listening = true;
      s.close.mockImplementation(() => s); // never calls callback

      const lc = new HttpLifecycle(deps);
      (lc as unknown as { httpServer: MockServer }).httpServer = s;
      (lc as unknown as { port: number }).port = 45454;

      const stopPromise = lc.stop();
      await vi.advanceTimersByTimeAsync(11_000);

      await expect(stopPromise).resolves.toBeUndefined();
      expect(s.closeAllConnections).toHaveBeenCalled();
      expect((lc as unknown as { httpServer: unknown }).httpServer).toBeNull();
    });
  });

  describe("setSessionTier", () => {
    function pinnedSession(deps: HttpLifecycleDeps, sessionId: string, wcId: number) {
      deps.sessionStore.sessionWebContentsMap.set(sessionId, wcId);
      // Mark transport active so the live-session guard passes.
      (deps.sessionStore.httpSessions as Map<string, unknown>).set(sessionId, {
        transport: { close: vi.fn().mockResolvedValue(undefined) },
        idleTimer: setTimeout(() => {}, 1_000_000),
      } as never);
    }

    it("elevates a help-session tier and updates sessionTierMap", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-1", "workbench");
      pinnedSession(deps, "sess-1", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-1", "system");

      expect(result).toEqual({ sessionId: "sess-1", tier: "system" });
      expect(deps.sessionStore.sessionTierMap.get("sess-1")).toBe("system");
    });

    it("refuses downgrades silently and keeps current tier", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-2", "system");
      pinnedSession(deps, "sess-2", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-2", "workbench");

      expect(result.tier).toBe("system");
      expect(deps.sessionStore.sessionTierMap.get("sess-2")).toBe("system");
    });

    it("throws for unknown sessions", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("nonexistent", "system")).toThrow(/Unknown session/);
    });

    it("throws when caller WebContents id doesn't match the pinned id", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-pin", "workbench");
      pinnedSession(deps, "sess-pin", 42);

      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("sess-pin", "system", 99)).toThrow(/not the pinned renderer/);
      // Tier must remain unchanged on rejection.
      expect(deps.sessionStore.sessionTierMap.get("sess-pin")).toBe("workbench");
    });

    it("accepts caller WebContents id when it matches the pinned id", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-ok", "workbench");
      pinnedSession(deps, "sess-ok", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-ok", "action", 42);
      expect(result.tier).toBe("action");
    });

    it("throws when the session's transport has already closed (idle/torn down)", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-dead", "workbench");
      deps.sessionStore.sessionWebContentsMap.set("sess-dead", 42);
      // Don't add to sessions/httpSessions — transport is dead.

      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("sess-dead", "system")).toThrow(/no longer active/);
    });

    it("throws for sessions without a pinned WebContents (api-key/external)", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("ext-1", "external");
      (deps.sessionStore.httpSessions as Map<string, unknown>).set("ext-1", {
        transport: { close: vi.fn().mockResolvedValue(undefined) },
        idleTimer: setTimeout(() => {}, 1_000_000),
      } as never);
      // No sessionWebContentsMap entry — this is an api-key session.

      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("ext-1", "system")).toThrow(
        /not eligible for renderer tier elevation/
      );
    });

    it("throws for invalid tier values", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-3", "workbench");
      pinnedSession(deps, "sess-3", 42);

      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("sess-3", "external" as never)).toThrow(/Invalid tier/);
    });

    it("throws for blank session ids", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("", "system")).toThrow(/Invalid sessionId/);
    });
  });

  describe("buildSessionServerDeps — appendAuditRecord turnId stamping", () => {
    it("stamps turnId on appendRecord when getCurrentTurnIdForSession returns a value", () => {
      const deps = fakeDeps();
      (
        deps.turnOutcomeService.getCurrentTurnIdForSession as ReturnType<typeof vi.fn>
      ).mockReturnValue("turn-uuid-abc");
      const lc = new HttpLifecycle(deps);
      const deps_ = (
        lc as unknown as {
          buildSessionServerDeps: (sessionId: string) => {
            appendAuditRecord: (input: Record<string, unknown>) => void;
          };
        }
      ).buildSessionServerDeps("session-1");
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: { kind: "result", value: { ok: true, result: null } },
      });
      expect(deps.auditService.appendRecord).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: "turn-uuid-abc" })
      );
    });

    it("omits turnId when getCurrentTurnIdForSession returns null", () => {
      const deps = fakeDeps();
      (
        deps.turnOutcomeService.getCurrentTurnIdForSession as ReturnType<typeof vi.fn>
      ).mockReturnValue(null);
      const lc = new HttpLifecycle(deps);
      const deps_ = (
        lc as unknown as {
          buildSessionServerDeps: (sessionId: string) => {
            appendAuditRecord: (input: Record<string, unknown>) => void;
          };
        }
      ).buildSessionServerDeps("session-1");
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: { kind: "result", value: { ok: true, result: null } },
      });
      const callArgs = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs.turnId).toBeUndefined();
    });
  });

  describe("auth gate", () => {
    it("returns 401 with WWW-Authenticate: Bearer realm header", async () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      lc.setApiKey("test-api-key");
      (lc as unknown as { port: number }).port = 45454;

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
        headersSent: false,
      } as unknown as http.ServerResponse;
      const req = {
        method: "GET",
        url: "/sse",
        headers: { host: "127.0.0.1:45454" },
      } as unknown as http.IncomingMessage;

      await (
        lc as unknown as {
          handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
        }
      ).handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(
        401,
        expect.objectContaining({ "WWW-Authenticate": 'Bearer realm="Daintree MCP"' })
      );
      expect(res.end).toHaveBeenCalledWith("Unauthorized");
      expect(deps.auditService.recordAuth401).toHaveBeenCalledTimes(1);
    });

    it("does not increment the 401 counter on a 403 (host mismatch)", async () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      lc.setApiKey("test-api-key");
      (lc as unknown as { port: number }).port = 45454;

      const res = {
        writeHead: vi.fn(),
        end: vi.fn(),
        headersSent: false,
      } as unknown as http.ServerResponse;
      const req = {
        method: "GET",
        url: "/sse",
        headers: { host: "evil.example.com" },
      } as unknown as http.IncomingMessage;

      await (
        lc as unknown as {
          handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
        }
      ).handleRequest(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
      expect(deps.auditService.recordAuth401).not.toHaveBeenCalled();
    });
  });
});
