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

// Mock electron so the suite loads without the Electron binary present (no
// `node_modules/electron/path.txt`). httpLifecycle.ts and its transitive imports
// only touch these at runtime — never in these unit tests — so stubs suffice.
// The controllable WebContents registry lets targeted-send paths (e.g.
// notifyTurnOutcomeAlert) be exercised without a real renderer; the source only
// imports `webContents` from electron, so this mock is a superset of that.
const { mockWebContentsById } = vi.hoisted(() => ({
  mockWebContentsById: new Map<
    number,
    { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void }
  >(),
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  webContents: { fromId: (id: number) => mockWebContentsById.get(id) ?? null },
  ipcMain: { on: () => undefined, removeListener: () => undefined },
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
      grantCache: {
        clearDenialCounts: vi.fn(),
        revokeSession: vi.fn(() => 0),
        issueGrant: vi.fn(),
      },
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

  describe("resetDenialCounts (#10017)", () => {
    function grantCacheOf(deps: HttpLifecycleDeps) {
      return (
        deps.sessionStore as unknown as {
          grantCache: { clearDenialCounts: ReturnType<typeof vi.fn> };
        }
      ).grantCache;
    }

    it("clears the session's denial counters without revoking its grants", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("sess-1", 42);
      const lc = new HttpLifecycle(deps);

      lc.resetDenialCounts("sess-1");

      expect(grantCacheOf(deps).clearDenialCounts).toHaveBeenCalledWith("sess-1");
      // Resetting denials must NOT touch per-tool grants — those have their
      // own approval lifecycle (#8442).
      expect(deps.sessionStore.grantCache.revokeSession).not.toHaveBeenCalled();
    });

    it("throws when the caller WebContents id doesn't match the pinned id", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("sess-pin", 42);
      const lc = new HttpLifecycle(deps);

      expect(() => lc.resetDenialCounts("sess-pin", 99)).toThrow(/not the pinned renderer/);
      expect(grantCacheOf(deps).clearDenialCounts).not.toHaveBeenCalled();
    });

    it("accepts the caller WebContents id when it matches the pinned id", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("sess-ok", 42);
      const lc = new HttpLifecycle(deps);

      lc.resetDenialCounts("sess-ok", 42);
      expect(grantCacheOf(deps).clearDenialCounts).toHaveBeenCalledWith("sess-ok");
    });

    it("is an idempotent no-op for a drained session (no pin) so banner dismissal always succeeds", () => {
      const deps = fakeDeps();
      // No sessionWebContentsMap entry — session already drained.
      const lc = new HttpLifecycle(deps);

      expect(() => lc.resetDenialCounts("sess-gone", 99)).not.toThrow();
      expect(grantCacheOf(deps).clearDenialCounts).toHaveBeenCalledWith("sess-gone");
    });

    it("throws for blank session ids", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      expect(() => lc.resetDenialCounts("")).toThrow(/Invalid sessionId/);
    });
  });

  describe("buildSessionServerDeps — pinned manifest cache routing (#9887)", () => {
    type CacheDeps = {
      getCachedManifest: () => unknown[] | null;
    };
    const buildDeps = (lc: HttpLifecycle, sessionId: string): CacheDeps =>
      (
        lc as unknown as { buildSessionServerDeps: (id: string) => CacheDeps }
      ).buildSessionServerDeps(sessionId);

    it("routes a pinned session's getCachedManifest to its own per-WebContents cache, never the shared one", () => {
      const deps = fakeDeps();
      (deps.getCachedManifest as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "shared" }]);
      const perWc = vi.fn(() => [{ id: "pinned" }]);
      deps.getCachedManifestForWebContents =
        perWc as unknown as typeof deps.getCachedManifestForWebContents;
      deps.sessionStore.sessionWebContentsMap.set("session-1", 101);
      const lc = new HttpLifecycle(deps);

      const result = buildDeps(lc, "session-1").getCachedManifest();

      expect(result).toEqual([{ id: "pinned" }]);
      expect(perWc).toHaveBeenCalledWith(101);
      expect(deps.getCachedManifest).not.toHaveBeenCalled();
    });

    it("routes an unpinned session's getCachedManifest to the shared cache", () => {
      const deps = fakeDeps();
      (deps.getCachedManifest as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "shared" }]);
      const perWc = vi.fn(() => [{ id: "pinned" }]);
      deps.getCachedManifestForWebContents =
        perWc as unknown as typeof deps.getCachedManifestForWebContents;
      // No sessionWebContentsMap entry → api-key/external session.
      const lc = new HttpLifecycle(deps);

      const result = buildDeps(lc, "session-1").getCachedManifest();

      expect(result).toEqual([{ id: "shared" }]);
      expect(perWc).not.toHaveBeenCalled();
    });

    it("a pinned session torn down mid-call stays pinned (fails closed), never flipping to the shared cache", () => {
      const deps = fakeDeps();
      (deps.getCachedManifest as ReturnType<typeof vi.fn>).mockReturnValue([{ id: "shared" }]);
      // After teardown the per-WebContents cache is evicted → returns null.
      const perWc = vi.fn(() => null);
      deps.getCachedManifestForWebContents =
        perWc as unknown as typeof deps.getCachedManifestForWebContents;
      deps.sessionStore.sessionWebContentsMap.set("session-1", 101);
      const lc = new HttpLifecycle(deps);
      const sessionDeps = buildDeps(lc, "session-1");

      // Simulate the pin being deleted (idle timeout / revoke) after deps build.
      deps.sessionStore.sessionWebContentsMap.delete("session-1");

      const result = sessionDeps.getCachedManifest();

      // Build-time capture keeps it pinned → null (fail-closed), not the shared
      // cache — the #7003 isolation invariant the fix protects.
      expect(result).toBeNull();
      expect(perWc).toHaveBeenCalledWith(101);
      expect(deps.getCachedManifest).not.toHaveBeenCalled();
    });
  });

  describe("buildSessionServerDeps — turnId snapshot stamping (#10067)", () => {
    type TurnDeps = {
      getCurrentTurnId?: () => string | null;
      appendAuditRecord: (input: Record<string, unknown>) => void;
    };
    const buildDeps = (lc: HttpLifecycle, sessionId: string): TurnDeps =>
      (
        lc as unknown as { buildSessionServerDeps: (id: string) => TurnDeps }
      ).buildSessionServerDeps(sessionId);

    it("resolves the live turn id via the HELP session id through getCurrentTurnId", () => {
      const deps = fakeDeps();
      (
        deps.turnOutcomeService.getCurrentTurnIdForSession as ReturnType<typeof vi.fn>
      ).mockReturnValue("turn-uuid-abc");
      deps.sessionStore.sessionHelpIdMap.set("session-1", "help-session-9");
      const lc = new HttpLifecycle(deps);
      const deps_ = buildDeps(lc, "session-1");
      // The turn-id register is keyed by HELP session id, not the MCP transport
      // id — passing the transport id always missed (#9759 gap).
      expect(deps_.getCurrentTurnId?.()).toBe("turn-uuid-abc");
      expect(deps.turnOutcomeService.getCurrentTurnIdForSession).toHaveBeenCalledWith(
        "help-session-9"
      );
    });

    it("stamps the captured turn id onto the audit record without re-reading it", () => {
      const deps = fakeDeps();
      (
        deps.turnOutcomeService.getCurrentTurnIdForSession as ReturnType<typeof vi.fn>
      ).mockReturnValue("turn-uuid-abc");
      deps.sessionStore.sessionHelpIdMap.set("session-1", "help-session-9");
      const lc = new HttpLifecycle(deps);
      const deps_ = buildDeps(lc, "session-1");
      (deps.turnOutcomeService.getCurrentTurnIdForSession as ReturnType<typeof vi.fn>).mockClear();
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: { kind: "result", value: { ok: true, result: null } },
        capturedTurnId: "turn-uuid-abc",
      });
      // The write path must not re-read the live register — the snapshot is the
      // single source of truth, so the audit record can't disagree with the
      // started/settled strip events.
      expect(deps.turnOutcomeService.getCurrentTurnIdForSession).not.toHaveBeenCalled();
      expect(deps.auditService.appendRecord).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: "turn-uuid-abc", helpSessionId: "help-session-9" })
      );
      // `capturedTurnId` is a transport-only carrier — it must be peeled off and
      // never persist into the stored record (the public field is `turnId`).
      const persisted = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(persisted.capturedTurnId).toBeUndefined();
    });

    it("omits turnId when the captured snapshot is null", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionHelpIdMap.set("session-1", "help-session-9");
      const lc = new HttpLifecycle(deps);
      const deps_ = buildDeps(lc, "session-1");
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: { kind: "result", value: { ok: true, result: null } },
        capturedTurnId: null,
      });
      const callArgs = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(callArgs).toBeDefined();
      expect(callArgs.turnId).toBeUndefined();
      expect(callArgs.helpSessionId).toBe("help-session-9");
    });

    it("getCurrentTurnId returns null and skips lookup for sessions with no help binding", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const deps_ = buildDeps(lc, "session-external");
      expect(deps_.getCurrentTurnId?.()).toBeNull();
      expect(deps.turnOutcomeService.getCurrentTurnIdForSession).not.toHaveBeenCalled();
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-external",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: { kind: "result", value: { ok: true, result: null } },
        capturedTurnId: null,
      });
      const callArgs = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0];
      expect(callArgs.turnId).toBeUndefined();
      expect(callArgs.helpSessionId).toBeUndefined();
    });

    it("stamps the start-time snapshot even after the FSM clears the turn mid-call", () => {
      const deps = fakeDeps();
      const liveTurn = deps.turnOutcomeService.getCurrentTurnIdForSession as ReturnType<
        typeof vi.fn
      >;
      liveTurn.mockReturnValue("turn-T1");
      deps.sessionStore.sessionHelpIdMap.set("session-1", "help-session-9");
      const lc = new HttpLifecycle(deps);
      const deps_ = buildDeps(lc, "session-1");

      // Snapshot at dispatch start, while the turn is still active.
      const capturedTurnId = deps_.getCurrentTurnId?.() ?? null;
      expect(capturedTurnId).toBe("turn-T1");

      // The active→passive FSM transition clears the register before the call
      // settles — a fresh read would now return null (the #10067 race).
      liveTurn.mockReturnValue(null);

      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-1",
        tier: "action",
        args: {},
        durationMs: 5,
        outcome: { kind: "result", value: { ok: true, result: null } },
        capturedTurnId,
      });

      // The audit record carries the snapshot, not the post-transition null —
      // so it groups with the started/settled events under the same turn.
      expect(deps.auditService.appendRecord).toHaveBeenCalledWith(
        expect.objectContaining({ turnId: "turn-T1", helpSessionId: "help-session-9" })
      );
    });
  });

  describe("buildSessionServerDeps — appendAuditRecord resultMeta for rate_limited (#10014)", () => {
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

    it("hides internal (help/pane) bearers from the External-clients list but still tracks them (#9151)", () => {
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
      // A subsequent external bearer is still tracked AND listed.
      handle.touchBearer("Bearer external-cccc", "Claude/1", "sess-ext", "external");
      expect(lc.listActiveBearers()).toHaveLength(1);
    });

    it("surfaces help-session bearers in listHelpSessionBearers with display fields only (#10036)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Daintree Assistant/1", "sess-help-1", "action");
      handle.touchBearer(authA, "Daintree Assistant/1", "sess-help-2", "action");
      handle.touchBearer("Bearer external-cccc", "Claude/1", "sess-ext", "external");

      const help = lc.listHelpSessionBearers();
      // Only the help-session bearer is returned — the external one is excluded.
      expect(help).toHaveLength(1);
      expect(help[0]).toEqual({
        userAgent: "Daintree Assistant/1",
        lastActiveAt: expect.any(Number),
        requestsSinceLaunch: 2,
        sessionCount: 2,
      });
      // No token, hash, or raw session ids cross the listing surface.
      const serialized = JSON.stringify(help);
      expect(serialized).not.toContain("secret-token-aaaa");
      expect(help[0]).not.toHaveProperty("tokenHash");
      expect(help[0]).not.toHaveProperty("token4LastChars");
      expect(help[0]).not.toHaveProperty("sessionIds");
    });

    it("listHelpSessionBearers is empty when only external bearers are connected (#10036)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Claude/1", "sess-ext", "external");
      expect(lc.listHelpSessionBearers()).toHaveLength(0);
    });

    it("listHelpSessionBearers covers every non-external tier, not just the help chat (#10036)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      // In-panel agent (pane) tokens are non-external too — they belong in the
      // Internal connections row alongside the help-chat assistant.
      handle.touchBearer(authA, "Help/1", "sess-help", "action");
      handle.touchBearer(authB, "Pane/1", "sess-pane", "workbench");
      handle.touchBearer("Bearer external-cccc", "Claude/1", "sess-ext", "external");

      const help = lc.listHelpSessionBearers();
      expect(help).toHaveLength(2);
      expect(help.map((h) => h.userAgent).sort()).toEqual(["Help/1", "Pane/1"]);
    });

    it("pushes a runtime-state change on help-session connect and disconnect (#10036)", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Daintree Assistant/1", "sess-help", "action");
      expect(deps.emitRuntimeStateChange).toHaveBeenCalledTimes(1);
      handle.detachBearerSession("sess-help");
      expect(deps.emitRuntimeStateChange).toHaveBeenCalledTimes(2);
      expect(lc.listHelpSessionBearers()).toHaveLength(0);
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

  describe("assistant-pane pinning resolvers (#10647)", () => {
    function pinnedResolver(lc: HttpLifecycle) {
      return (
        lc as unknown as { resolvePinnedWebContentsId: (h: string) => number | null }
      ).resolvePinnedWebContentsId.bind(lc);
    }
    function ctxResolver(lc: HttpLifecycle) {
      return (
        lc as unknown as { resolveActionContext: (h: string) => unknown }
      ).resolveActionContext.bind(lc);
    }

    it("falls through to the assistant resolver for a pinned pane bearer", () => {
      const lc = new HttpLifecycle(fakeDeps());
      // A help resolver is wired but returns null for this (non-help) token.
      lc.setHelpSessionWebContentsResolver(() => null);
      lc.setAssistantPaneWebContentsResolver((token) => (token === "assistant-tok" ? 77 : null));

      const resolve = pinnedResolver(lc);
      expect(resolve("Bearer assistant-tok")).toBe(77);
      expect(resolve("Bearer unknown-tok")).toBeNull();
    });

    it("prefers the help resolver over the assistant resolver", () => {
      const lc = new HttpLifecycle(fakeDeps());
      lc.setHelpSessionWebContentsResolver((token) => (token === "help-tok" ? 11 : null));
      const assistant = vi.fn(() => 99);
      lc.setAssistantPaneWebContentsResolver(assistant);

      expect(pinnedResolver(lc)("Bearer help-tok")).toBe(11);
      // Help match short-circuits — the assistant resolver is never consulted.
      expect(assistant).not.toHaveBeenCalled();
    });

    it("replays the assistant ActionContext for a pinned pane bearer", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const ctx = { projectId: "p1", activeWorktreeId: "wt-3" };
      lc.setHelpSessionActionContextResolver(() => null);
      lc.setAssistantPaneActionContextResolver((token) => (token === "assistant-tok" ? ctx : null));

      const resolve = ctxResolver(lc);
      expect(resolve("Bearer assistant-tok")).toEqual(ctx);
      expect(resolve("Bearer unknown-tok")).toBeNull();
    });

    it("returns null for external/api-key bearers so they keep the focused-window fallback", () => {
      const lc = new HttpLifecycle(fakeDeps());
      // No resolvers wired at all (e.g. server up before any assistant spawn).
      expect(pinnedResolver(lc)("Bearer anything")).toBeNull();
      expect(ctxResolver(lc)("Bearer anything")).toBeNull();
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

  describe("notifyTurnOutcomeAlert (#10018)", () => {
    beforeEach(() => {
      mockWebContentsById.clear();
    });

    function liveWc(id: number) {
      const wc = { isDestroyed: () => false, send: vi.fn() };
      mockWebContentsById.set(id, wc);
      return wc;
    }
    function deadWc(id: number) {
      const wc = { isDestroyed: () => true, send: vi.fn() };
      mockWebContentsById.set(id, wc);
      return wc;
    }

    it("sends the alert to the pinned WebContents of the matching help session", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionHelpIdMap.set("transport-1", "help-9");
      deps.sessionStore.sessionWebContentsMap.set("transport-1", 42);
      const wc = liveWc(42);
      const lc = new HttpLifecycle(deps);

      lc.notifyTurnOutcomeAlert({ helpSessionId: "help-9", outcome: "agent-stuck" });

      expect(wc.send).toHaveBeenCalledTimes(1);
      expect(wc.send).toHaveBeenCalledWith(
        "mcp-server:turn-outcome-alert",
        expect.objectContaining({ helpSessionId: "help-9", outcome: "agent-stuck" })
      );
      // No turnId on the payload means none is forwarded.
      expect(wc.send.mock.calls[0]![1]).not.toHaveProperty("turnId");
    });

    it("forwards turnId when present", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionHelpIdMap.set("transport-1", "help-9");
      deps.sessionStore.sessionWebContentsMap.set("transport-1", 42);
      const wc = liveWc(42);
      const lc = new HttpLifecycle(deps);

      lc.notifyTurnOutcomeAlert({
        helpSessionId: "help-9",
        outcome: "reasoning-loop",
        turnId: "turn-7",
      });

      expect(wc.send).toHaveBeenCalledWith(
        "mcp-server:turn-outcome-alert",
        expect.objectContaining({ outcome: "reasoning-loop", turnId: "turn-7" })
      );
    });

    it("falls through a destroyed WebContents to a second live transport for the same help session", () => {
      const deps = fakeDeps();
      // Two transports map to the same help session; the first is destroyed.
      deps.sessionStore.sessionHelpIdMap.set("transport-dead", "help-9");
      deps.sessionStore.sessionWebContentsMap.set("transport-dead", 41);
      deps.sessionStore.sessionHelpIdMap.set("transport-live", "help-9");
      deps.sessionStore.sessionWebContentsMap.set("transport-live", 42);
      const dead = deadWc(41);
      const live = liveWc(42);
      const lc = new HttpLifecycle(deps);

      lc.notifyTurnOutcomeAlert({ helpSessionId: "help-9", outcome: "agent-stuck" });

      expect(dead.send).not.toHaveBeenCalled();
      expect(live.send).toHaveBeenCalledTimes(1);
    });

    it("no-ops when no transport session maps to the help session", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionHelpIdMap.set("transport-1", "help-other");
      deps.sessionStore.sessionWebContentsMap.set("transport-1", 42);
      const wc = liveWc(42);
      const lc = new HttpLifecycle(deps);

      lc.notifyTurnOutcomeAlert({ helpSessionId: "help-9", outcome: "agent-stuck" });

      expect(wc.send).not.toHaveBeenCalled();
    });
  });
});
