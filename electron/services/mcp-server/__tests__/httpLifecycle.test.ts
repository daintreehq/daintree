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
import { createHash } from "node:crypto";
import { HttpLifecycle } from "../httpLifecycle.js";
import type { HttpLifecycleDeps } from "../httpLifecycle.js";

type BearerTestHandle = {
  touchBearer: (
    authHeader: string,
    userAgent: string,
    sessionId: string,
    tier: "workbench" | "action" | "system" | "external"
  ) => void;
  detachBearerSession: (sessionId: string) => void;
};

const hashOf = (authHeader: string) => createHash("sha256").update(authHeader).digest("hex");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MockServer = any;

function mockServer(port = 45454): MockServer {
  const s = new EventEmitter() as unknown as MockServer;
  s.closeAllConnections = vi.fn();
  s.closeIdleConnections = vi.fn();
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
      sessionHelpIdMap: new Map(),
      resourceSubscriptions: new Map(),
      drain: vi.fn(),
      getTier: vi.fn(() => "workbench" as const),
      createIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
      createHttpIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
      resetIdleTimer: vi.fn(),
      resetHttpIdleTimer: vi.fn(),
      armTierElevationTimer: vi.fn(),
      clearElevationTimer: vi.fn(),
      revokeSession: vi.fn(() => false),
      registerClientMetadata: vi.fn(),
      listExternalActiveClients: vi.fn(() => []),
    },
    auditService: {
      hydrate: vi.fn(),
      flushNow: vi.fn(),
      appendRecord: vi.fn(),
      appendGrantRecord: vi.fn(),
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
    abusePolicy: {
      recordDenial: vi.fn(() => ({ tripped: false })),
      dropSession: vi.fn(),
      clear: vi.fn(),
      getSnapshot: vi.fn(() => null),
    },
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
    it("drains gracefully: closeIdleConnections after close starts, no eager closeAllConnections (#8779)", async () => {
      const deps = fakeDeps();
      const s = mockServer();
      (s as MockServer & { listening: boolean }).listening = true;
      const callOrder: string[] = [];
      s.closeAllConnections.mockImplementation(() => {
        callOrder.push("closeAllConnections");
      });
      s.closeIdleConnections.mockImplementation(() => {
        callOrder.push("closeIdleConnections");
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

      // close() starts the drain; closeIdleConnections() drops bare keep-alive
      // sockets immediately after. The eager force-kill is gone — when close
      // completes within the deadline closeAllConnections is never called.
      expect(callOrder[0]).toBe("close");
      expect(callOrder).toContain("closeIdleConnections");
      expect(s.closeAllConnections).not.toHaveBeenCalled();
    });

    it("does not log a timeout warning when close completes within the deadline (#8779)", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const deps = fakeDeps();
      const s = mockServer();
      (s as MockServer & { listening: boolean }).listening = true;

      const lc = new HttpLifecycle(deps);
      (lc as unknown as { httpServer: MockServer }).httpServer = s;
      (lc as unknown as { port: number }).port = 45454;

      await lc.stop();
      // Fire the (already-resolved) deadline timer — its callback must not warn.
      await vi.advanceTimersByTimeAsync(4_000);

      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("server.close() timed out"));
    });

    it("force-closes connections only after the 3s drain deadline (#8779)", async () => {
      const deps = fakeDeps();
      const s = mockServer();
      (s as MockServer & { listening: boolean }).listening = true;
      s.close.mockImplementation(() => s); // never calls callback — close hangs

      const lc = new HttpLifecycle(deps);
      (lc as unknown as { httpServer: MockServer }).httpServer = s;
      (lc as unknown as { port: number }).port = 45454;

      const stopPromise = lc.stop();
      // Before the deadline the active sockets are left to drain.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(s.closeAllConnections).not.toHaveBeenCalled();
      // Past the 3s deadline the remaining sockets are force-closed.
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(stopPromise).resolves.toBeUndefined();
      expect(s.closeIdleConnections).toHaveBeenCalled();
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
      // The elevation must arm the decay timer with the pre-elevation tier
      // as the baseline (#8462) — otherwise the elevation is unbounded.
      expect(deps.sessionStore.armTierElevationTimer).toHaveBeenCalledWith(
        "sess-1",
        "system",
        "workbench"
      );
    });

    it("writes a tier.elevated audit record with from/to tier and the bounded window (#9151)", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-aud", "workbench");
      pinnedSession(deps, "sess-aud", 42);

      const lc = new HttpLifecycle(deps);
      lc.setSessionTier("sess-aud", "action");

      expect(deps.auditService.appendGrantRecord).toHaveBeenCalledTimes(1);
      const record = (deps.auditService.appendGrantRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(record).toMatchObject({
        type: "tier.elevated",
        sessionId: "sess-aud",
        toolId: "*",
        tier: "action",
        previousTier: "workbench",
      });
      expect(record.ttlMs).toBeGreaterThan(0);
      expect(record.expiresAt).toBeGreaterThan(0);
    });

    it("does not audit a same-tier re-elevation (no actual privilege change, #9151)", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-same", "action");
      pinnedSession(deps, "sess-same", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-same", "action");

      expect(result.tier).toBe("action");
      // Same tier in → nothing elevated → no audit row (would be a misleading
      // action→action entry).
      expect(deps.auditService.appendGrantRecord).not.toHaveBeenCalled();
    });

    it("refuses downgrades silently and keeps current tier without auditing", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-2", "system");
      pinnedSession(deps, "sess-2", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-2", "workbench");

      expect(result.tier).toBe("system");
      expect(deps.sessionStore.sessionTierMap.get("sess-2")).toBe("system");
      // No mutation, no audit row — only accepted elevations are logged.
      expect(deps.auditService.appendGrantRecord).not.toHaveBeenCalled();
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

  describe("buildSessionServerDeps — appendAuditRecord turnId/helpSessionId stamping", () => {
    it("resolves turnId via the HELP session id and stamps both onto the record", () => {
      const deps = fakeDeps();
      (
        deps.turnOutcomeService.getCurrentTurnIdForSession as ReturnType<typeof vi.fn>
      ).mockReturnValue("turn-uuid-abc");
      deps.sessionStore.sessionHelpIdMap.set("session-1", "help-session-9");
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
      // The turn-id register is keyed by HELP session id, not the MCP
      // transport id — passing the transport id always missed (#9759 gap).
      expect(deps.turnOutcomeService.getCurrentTurnIdForSession).toHaveBeenCalledWith(
        "help-session-9"
      );
      expect(deps.auditService.appendRecord).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: "turn-uuid-abc", helpSessionId: "help-session-9" })
      );
    });

    it("omits turnId when getCurrentTurnIdForSession returns null", () => {
      const deps = fakeDeps();
      (
        deps.turnOutcomeService.getCurrentTurnIdForSession as ReturnType<typeof vi.fn>
      ).mockReturnValue(null);
      deps.sessionStore.sessionHelpIdMap.set("session-1", "help-session-9");
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
      expect(callArgs.helpSessionId).toBe("help-session-9");
    });

    it("skips turn lookup and helpSessionId for sessions with no help binding", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const deps_ = (
        lc as unknown as {
          buildSessionServerDeps: (sessionId: string) => {
            appendAuditRecord: (input: Record<string, unknown>) => void;
          };
        }
      ).buildSessionServerDeps("session-external");
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-external",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: { kind: "result", value: { ok: true, result: null } },
      });
      expect(deps.turnOutcomeService.getCurrentTurnIdForSession).not.toHaveBeenCalled();
      const callArgs = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(callArgs.turnId).toBeUndefined();
      expect(callArgs.helpSessionId).toBeUndefined();
    });
  });

  describe("buildSessionServerDeps — appendAuditRecord resultMeta for rate_limited (#10014)", () => {
    function captureAppendInput(sessionId: string) {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const deps_ = (
        lc as unknown as {
          buildSessionServerDeps: (sessionId: string) => {
            appendAuditRecord: (input: Record<string, unknown>) => void;
          };
        }
      ).buildSessionServerDeps(sessionId);
      return { deps, deps_, appendInput: (input: Record<string, unknown>) => void 0 };
    }

    it("forwards resultMeta.retryAfter on rate_limited outcomes and omits resultSummary", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const deps_ = (
        lc as unknown as {
          buildSessionServerDeps: (sessionId: string) => {
            appendAuditRecord: (input: Record<string, unknown>) => void;
          };
        }
      ).buildSessionServerDeps("session-rl");
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-rl",
        tier: "action",
        args: {},
        durationMs: 0,
        outcome: { kind: "rate_limited", retryAfter: 5 },
      });
      expect(deps.auditService.appendRecord).toHaveBeenCalledWith(
        expect.objectContaining({ resultMeta: { retryAfter: 5 } })
      );
      const callArgs = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(callArgs.resultSummary).toBeUndefined();
    });

    it("does not attach resultMeta for unauthorized / dedup / collision outcomes", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const deps_ = (
        lc as unknown as {
          buildSessionServerDeps: (sessionId: string) => {
            appendAuditRecord: (input: Record<string, unknown>) => void;
          };
        }
      ).buildSessionServerDeps("session-gate");
      for (const outcome of [{ kind: "unauthorized" }, { kind: "dedup" }, { kind: "collision" }]) {
        deps_.appendAuditRecord({
          toolId: "agent.terminal",
          sessionId: "session-gate",
          tier: "action",
          args: {},
          durationMs: 0,
          outcome,
        });
      }
      const calls = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(3);
      for (const call of calls) {
        expect(call[0].resultMeta).toBeUndefined();
        expect(call[0].resultSummary).toBeUndefined();
      }
    });

    it("does not attach resultMeta for success outcomes (only rate_limited carries hints)", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const deps_ = (
        lc as unknown as {
          buildSessionServerDeps: (sessionId: string) => {
            appendAuditRecord: (input: Record<string, unknown>) => void;
          };
        }
      ).buildSessionServerDeps("session-ok");
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-ok",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: { kind: "result", value: { ok: true, result: null } },
      });
      const callArgs = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(callArgs.resultMeta).toBeUndefined();
      // Success dispatches DO carry a resultSummary (tool output).
      expect(callArgs.resultSummary).toBeDefined();
    });
  });

  describe("bearer register", () => {
    const authA = "Bearer secret-token-aaaa";
    const authB = "Bearer secret-token-bbbb";

    it("registers a bearer and exposes only the suffix, never the raw token", () => {
      const lc = new HttpLifecycle(fakeDeps());
      (lc as unknown as BearerTestHandle).touchBearer(
        authA,
        "Claude Code/1.0",
        "sess-1",
        "external"
      );

      const bearers = lc.listActiveBearers();
      expect(bearers).toHaveLength(1);
      expect(bearers[0]).toMatchObject({
        tokenHash: hashOf(authA),
        token4LastChars: "aaaa",
        userAgent: "Claude Code/1.0",
        requestsSinceLaunch: 1,
      });
      // The raw token must never cross the listing surface.
      expect(JSON.stringify(bearers)).not.toContain("secret-token-aaaa");
      // sessionIds is internal only.
      expect(bearers[0]).not.toHaveProperty("sessionIds");
    });

    it("hides internal (help/pane) bearers from the settings list but still tracks them (#9151)", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Help/1", "sess-help", "action");
      handle.touchBearer(authB, "Pane/1", "sess-pane", "workbench");
      // Filtered out of the External-clients settings row...
      expect(lc.listActiveBearers()).toHaveLength(0);
      // ...but tracked in the register so eager teardown can find them.
      expect(lc.getBearerSessionIds(hashOf(authA))).toEqual(["sess-help"]);
      expect(lc.getBearerSessionIds(hashOf(authB))).toEqual(["sess-pane"]);
      // Help-bearer handshakes don't push a runtime-state change (they never
      // surface in the UI) — only the external bearer below does.
      expect(deps.emitRuntimeStateChange).not.toHaveBeenCalled();
      // A subsequent external bearer is still tracked AND listed.
      handle.touchBearer("Bearer external-cccc", "Claude/1", "sess-ext", "external");
      expect(lc.listActiveBearers()).toHaveLength(1);
      expect(deps.emitRuntimeStateChange).toHaveBeenCalledTimes(1);
    });

    it("findHelpBearerHash resolves a help token to its register key, ignoring external bearers (#9151)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      // Raw tokens are the part after "Bearer ".
      handle.touchBearer("Bearer help-token-xyz", "Help/1", "sess-help", "action");
      handle.touchBearer("Bearer ext-token-abc", "Claude/1", "sess-ext", "external");

      expect(lc.findHelpBearerHash("help-token-xyz")).toBe(hashOf("Bearer help-token-xyz"));
      // External bearers are not help sessions — never resolved by token here.
      expect(lc.findHelpBearerHash("ext-token-abc")).toBeNull();
      // Unknown token → null.
      expect(lc.findHelpBearerHash("never-seen")).toBeNull();
    });

    it("findHelpBearerHash returns null after the help session detaches (#9151)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer("Bearer help-token-xyz", "Help/1", "sess-help", "action");
      handle.detachBearerSession("sess-help");
      expect(lc.findHelpBearerHash("help-token-xyz")).toBeNull();
    });

    it("findHelpBearerHash returns null after clearBearer evicts the entry (server stop/restart, #9151)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      const auth = "Bearer help-token-xyz";
      handle.touchBearer(auth, "Help/1", "sess-help", "action");
      lc.clearBearer(hashOf(auth));
      expect(lc.findHelpBearerHash("help-token-xyz")).toBeNull();
    });

    it("pushes a runtime-state change on connect and on final disconnect", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Client/1", "sess-1", "external");
      expect(deps.emitRuntimeStateChange).toHaveBeenCalledTimes(1);
      handle.detachBearerSession("sess-1");
      expect(deps.emitRuntimeStateChange).toHaveBeenCalledTimes(2);
    });

    it("coalesces two sessions onto one entry and only drops it when both close", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Client/1", "sess-1", "external");
      handle.touchBearer(authA, "Client/2", "sess-2", "external");

      const bearers = lc.listActiveBearers();
      expect(bearers).toHaveLength(1);
      // requestsSinceLaunch counts each handshake; userAgent reflects the latest.
      expect(bearers[0]!.requestsSinceLaunch).toBe(2);
      expect(bearers[0]!.userAgent).toBe("Client/2");

      handle.detachBearerSession("sess-1");
      expect(lc.listActiveBearers()).toHaveLength(1);

      handle.detachBearerSession("sess-2");
      expect(lc.listActiveBearers()).toHaveLength(0);
    });

    it("keys distinct tokens to distinct entries", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Client/1", "sess-1", "external");
      handle.touchBearer(authB, "Client/2", "sess-2", "external");
      expect(lc.listActiveBearers()).toHaveLength(2);
    });

    it("detachBearerSession is a no-op for unknown sessions", () => {
      const lc = new HttpLifecycle(fakeDeps());
      expect(() => (lc as unknown as BearerTestHandle).detachBearerSession("ghost")).not.toThrow();
      expect(lc.listActiveBearers()).toHaveLength(0);
    });

    it("getBearerSessionIds returns a snapshot or null", () => {
      const lc = new HttpLifecycle(fakeDeps());
      (lc as unknown as BearerTestHandle).touchBearer(authA, "Client/1", "sess-1", "external");
      expect(lc.getBearerSessionIds(hashOf(authA))).toEqual(["sess-1"]);
      expect(lc.getBearerSessionIds("nonexistent")).toBeNull();
    });

    it("clearBearer evicts the entry and its reverse-lookup rows", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Client/1", "sess-1", "external");
      lc.clearBearer(hashOf(authA));
      expect(lc.listActiveBearers()).toHaveLength(0);
      // Reverse rows gone: a late detach for the cleared session is harmless.
      expect(() => handle.detachBearerSession("sess-1")).not.toThrow();
    });
  });

  describe("getBearerInfoForSession (#9157)", () => {
    const authExt = "Bearer ext-token-1234";

    type BearerInfoHandle = BearerTestHandle & {
      getBearerInfoForSession: (
        sessionId: string
      ) => { token4LastChars: string; userAgent: string } | null;
    };

    it("returns the display-only identity for an external bearer", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerInfoHandle;
      handle.touchBearer(authExt, "Claude Code", "sess-ext", "external");

      expect(handle.getBearerInfoForSession("sess-ext")).toEqual({
        token4LastChars: "1234",
        userAgent: "Claude Code",
      });
    });

    it("returns null for help-session bearers — the assistant's own panel stays provenance-free", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerInfoHandle;
      handle.touchBearer("Bearer help-token-9999", "Help/1", "sess-help", "action");

      expect(handle.getBearerInfoForSession("sess-help")).toBeNull();
    });

    it("returns null for an unknown / detached session", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerInfoHandle;
      expect(handle.getBearerInfoForSession("ghost")).toBeNull();

      handle.touchBearer(authExt, "Claude Code", "sess-ext", "external");
      handle.detachBearerSession("sess-ext");
      expect(handle.getBearerInfoForSession("sess-ext")).toBeNull();
    });

    it("threads callerInfo into the unpinned dispatch for external sessions", async () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authExt, "Claude Code", "sess-ext", "external");

      const sessionDeps = (
        lc as unknown as {
          buildSessionServerDeps: (
            sessionId: string
          ) => import("../sessionServer.js").SessionServerDeps;
        }
      ).buildSessionServerDeps("sess-ext");

      await sessionDeps.dispatchAction("terminal.kill", { id: "t-1" }, false);

      expect(deps.dispatchAction).toHaveBeenCalledWith("terminal.kill", { id: "t-1" }, false, {
        token4LastChars: "1234",
        userAgent: "Claude Code",
      });
    });

    it("passes callerInfo: undefined when the session has no tracked bearer", async () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);

      const sessionDeps = (
        lc as unknown as {
          buildSessionServerDeps: (
            sessionId: string
          ) => import("../sessionServer.js").SessionServerDeps;
        }
      ).buildSessionServerDeps("sess-untracked");

      await sessionDeps.dispatchAction("actions.list", {}, false);

      expect(deps.dispatchAction).toHaveBeenCalledWith("actions.list", {}, false, undefined);
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
