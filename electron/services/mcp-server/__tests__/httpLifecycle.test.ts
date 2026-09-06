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
import { minimumPermittingTier } from "../shared.js";
import type { SessionServerDeps } from "../sessionServer.js";
import { WorkspaceBindingError } from "../rendererBridge.js";

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

/**
 * Workspace ids shaped the way the real id spaces are — 64 hex for a project, a
 * UUIDv4 for a scratch — because the handshake now refuses anything else
 * outright (#12082). A `WS_A`-style placeholder would be rejected on shape
 * before any of these tests reached the behaviour they are about.
 */
const WS_A = "a".repeat(64);
const WS_B = "b".repeat(64);
const WS_MISSING = "c".repeat(64);
const WS_DUP = "d".repeat(64);
const WS_SCRATCH = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

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
      sessionOriginMap: new Map(),
      sessionWorkspaceMap: new Map(),
      sessionHelpIdMap: new Map(),
      resourceSubscriptions: new Map(),
      // Real behaviour, not a stub: these are authorization predicates, and a
      // fixture that always answered `true` would make every origin gate in
      // this suite vacuous (#11789).
      getOrigin(sessionId: string) {
        return this.sessionOriginMap.get(sessionId) ?? "external";
      },
      isRendererOwnedOrigin(sessionId: string) {
        const origin = this.getOrigin(sessionId);
        return origin === "help" || origin === "assistant-pane";
      },
      clearSessionBinding(sessionId: string) {
        this.sessionWebContentsMap.delete(sessionId);
        this.sessionContextMap.delete(sessionId);
        this.sessionOriginMap.delete(sessionId);
        this.sessionWorkspaceMap.delete(sessionId);
      },
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
      // The rest of the teardown surface. Stubbed rather than omitted because
      // the uninitialized-session sweep (#12082) walks all of it, and an
      // absent method there is a TypeError that reads as a lifecycle bug.
      clearClientMetadata: vi.fn(),
      clearDedupState: vi.fn(),
      clearFigureCounter: vi.fn(),
      listExternalActiveClients: vi.fn(() => []),
      resolveLiveTransportForHelpSession: vi.fn(() => null),
      grantCache: {
        clearDenialCounts: vi.fn(),
        revokeSession: vi.fn(() => 0),
        issueGrant: vi.fn(),
        issueNativeGrant: vi.fn(),
        getNativeGrant: vi.fn(() => undefined),
        revokeNativeGrant: vi.fn(() => false),
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
    handleSkillsSearch: vi.fn(() => ({ skills: [] })),
    handleSkillsLoad: vi.fn(),
    handleProjectRunCheck: vi.fn(),
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
          http.RequestListener | undefined;
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
      // Elevation is gated on origin, not merely on having a route (#11789).
      deps.sessionStore.sessionOriginMap.set(sessionId, "help");
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

  // The single-tool "Approve once" path must enforce the same floor as
  // issueNativeGrant: a grant may only name a tool some non-external help tier
  // already permits. The call gate honours a grant OVER failed tier membership,
  // so without this check a pinned renderer could mint a grant for an id in no
  // tier at all and the authorization contract would rest on the UI never
  // offering the button rather than on main refusing it (#11585).
  describe("issueGrant tool validation (#11585)", () => {
    function grantCacheOf(deps: HttpLifecycleDeps) {
      return (
        deps.sessionStore as unknown as { grantCache: { issueGrant: ReturnType<typeof vi.fn> } }
      ).grantCache;
    }
    function pinnedDeps() {
      const deps = fakeDeps();
      deps.sessionStore.httpSessions.set("sess-1", {} as never);
      deps.sessionStore.sessionWebContentsMap.set("sess-1", 42);
      // Grants are gated on origin, not merely on having a route (#11789).
      deps.sessionStore.sessionOriginMap.set("sess-1", "help");
      return deps;
    }

    it("mints a grant for a tool a help tier permits", () => {
      const deps = pinnedDeps();
      grantCacheOf(deps).issueGrant.mockReturnValue({ ttlMs: 900_000, expiresAt: 1_000_000 });
      const lc = new HttpLifecycle(deps);

      // Ground truth: git.commit is genuinely reachable at the system tier, so
      // the rejections below are a real boundary rather than an unknown string.
      expect(minimumPermittingTier("git.commit")).not.toBeNull();
      expect(lc.issueGrant("sess-1", "git.commit", 42).toolId).toBe("git.commit");
      expect(grantCacheOf(deps).issueGrant).toHaveBeenCalledWith("sess-1", "git.commit");
    });

    it.each([
      // In no tier allowlist at all — the case the new hidden marking documents.
      "actions.persistedStores",
      "totally.notatool",
    ])("refuses to grant %s", (toolId) => {
      const deps = pinnedDeps();
      const lc = new HttpLifecycle(deps);

      expect(minimumPermittingTier(toolId)).toBeNull();
      expect(() => lc.issueGrant("sess-1", toolId, 42)).toThrow(/non-grantable/);
      expect(grantCacheOf(deps).issueGrant).not.toHaveBeenCalled();
    });
  });

  describe("issueNativeGrant / revokeNativeGrant (#10648)", () => {
    type NativeGrantCache = {
      issueNativeGrant: ReturnType<typeof vi.fn>;
      getNativeGrant: ReturnType<typeof vi.fn>;
      revokeNativeGrant: ReturnType<typeof vi.fn>;
    };
    function grantCacheOf(deps: HttpLifecycleDeps) {
      return (deps.sessionStore as unknown as { grantCache: NativeGrantCache }).grantCache;
    }
    function resolverOf(deps: HttpLifecycleDeps) {
      return deps.sessionStore.resolveLiveTransportForHelpSession as ReturnType<typeof vi.fn>;
    }
    function mintEntry(allowedTools: string[], maxUses: number) {
      return {
        id: "grant-uuid",
        sessionId: "transport-1",
        actorId: "help-1",
        actorType: "help-session" as const,
        allowedTools: new Set(allowedTools),
        maxUses,
        remainingUses: maxUses,
        ttlMs: 900_000,
        expiresAt: 1_000_000,
      };
    }

    it("resolves the transport session and mints a grant for valid input", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      grantCacheOf(deps).issueNativeGrant.mockReturnValue(mintEntry(["git.commit"], 5));
      const lc = new HttpLifecycle(deps);

      const result = lc.issueNativeGrant(
        "help-1",
        { allowedTools: ["git.commit"], maxUses: 5 },
        42
      );

      expect(resolverOf(deps)).toHaveBeenCalledWith("help-1", 42);
      expect(grantCacheOf(deps).issueNativeGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "transport-1",
          actorId: "help-1",
          actorType: "help-session",
          allowedTools: ["git.commit"],
          maxUses: 5,
        })
      );
      expect(result.grantId).toBe("grant-uuid");
    });

    it("requires a caller WebContents id (fails closed)", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      expect(() => lc.issueNativeGrant("help-1", { allowedTools: ["git.commit"] })).toThrow(
        /Caller WebContents id is required/
      );
    });

    it("throws when no live pinned session backs the help id", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue(null);
      const lc = new HttpLifecycle(deps);
      expect(() => lc.issueNativeGrant("help-gone", { allowedTools: ["git.commit"] }, 42)).toThrow(
        /No live pinned session/
      );
    });

    it("rejects an empty tool allowlist", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      const lc = new HttpLifecycle(deps);
      expect(() => lc.issueNativeGrant("help-1", { allowedTools: [] }, 42)).toThrow(
        /at least one tool/
      );
      expect(grantCacheOf(deps).issueNativeGrant).not.toHaveBeenCalled();
    });

    it("rejects an unknown / non-grantable tool", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      const lc = new HttpLifecycle(deps);
      expect(() =>
        lc.issueNativeGrant("help-1", { allowedTools: ["totally.notatool"] }, 42)
      ).toThrow(/non-grantable/);
      expect(grantCacheOf(deps).issueNativeGrant).not.toHaveBeenCalled();
    });

    it("rejects a fan-out tool a use count cannot bound (#12121)", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      const lc = new HttpLifecycle(deps);
      for (const toolId of ["terminal.killAll", "terminal.closeAll"]) {
        // Both are real, tier-reachable tools — so it is the fan-out policy
        // refusing them here, not the unknown-tool check above.
        expect(minimumPermittingTier(toolId)).not.toBe(null);
        // Names the offender AND the reason: `/cannot cover/` alone would also
        // pass if the tool had merely fallen out of every tier allowlist.
        expect(() => lc.issueNativeGrant("help-1", { allowedTools: [toolId] }, 42)).toThrow(
          new RegExp(`cannot cover ${toolId.replaceAll(".", "\\.")}\\b.*every target it finds`)
        );
      }
      expect(grantCacheOf(deps).issueNativeGrant).not.toHaveBeenCalled();
    });

    it("rejects a mixed scope rather than silently narrowing it (#12121)", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      const lc = new HttpLifecycle(deps);
      // The minted scope must be exactly the scope the user approved: dropping
      // the offenders would hand back a grant card that reads as approved-in-full.
      // Two of them, so this also pins the plural branch of the message — with
      // one offender the singular wording passes either way.
      const attempt = () =>
        lc.issueNativeGrant(
          "help-1",
          { allowedTools: ["git.commit", "terminal.killAll", "terminal.closeAll"] },
          42
        );
      expect(attempt).toThrow(/cannot cover terminal\.killAll, terminal\.closeAll\b/);
      expect(attempt).toThrow(/Remove them\b/);
      expect(grantCacheOf(deps).issueNativeGrant).not.toHaveBeenCalled();
    });

    it("rejects an out-of-range maxUses", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      const lc = new HttpLifecycle(deps);
      expect(() =>
        lc.issueNativeGrant("help-1", { allowedTools: ["git.commit"], maxUses: 0 }, 42)
      ).toThrow(/maxUses/);
      expect(() =>
        lc.issueNativeGrant("help-1", { allowedTools: ["git.commit"], maxUses: 9999 }, 42)
      ).toThrow(/maxUses/);
    });

    it("revokeNativeGrant enforces caller-pin against the grant's session", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("transport-1", 42);
      grantCacheOf(deps).getNativeGrant.mockReturnValue(mintEntry(["git.commit"], 5));
      const lc = new HttpLifecycle(deps);
      expect(() => lc.revokeNativeGrant("grant-uuid", 99)).toThrow(/not the pinned renderer/);
      expect(grantCacheOf(deps).revokeNativeGrant).not.toHaveBeenCalled();
    });

    it("revokeNativeGrant is an idempotent no-op for an already-gone grant", () => {
      const deps = fakeDeps();
      grantCacheOf(deps).getNativeGrant.mockReturnValue(undefined);
      const lc = new HttpLifecycle(deps);
      expect(lc.revokeNativeGrant("grant-gone", 99)).toEqual({
        grantId: "grant-gone",
        revoked: false,
      });
      expect(grantCacheOf(deps).revokeNativeGrant).not.toHaveBeenCalled();
    });

    it("revokeNativeGrant drops the grant when the caller is the pinned renderer", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("transport-1", 42);
      grantCacheOf(deps).getNativeGrant.mockReturnValue(mintEntry(["git.commit"], 5));
      grantCacheOf(deps).revokeNativeGrant.mockReturnValue(true);
      const lc = new HttpLifecycle(deps);
      expect(lc.revokeNativeGrant("grant-uuid", 42)).toEqual({
        grantId: "grant-uuid",
        revoked: true,
      });
      expect(grantCacheOf(deps).revokeNativeGrant).toHaveBeenCalledWith("grant-uuid", "user");
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
    // Picked from the real dep contract rather than a `Record<string, unknown>`
    // carrier: this block is the only coverage of the closure's
    // `{ capturedTurnId, ...recordInput }` hop, and a structural stand-in would
    // let a field the real callers must pass go missing here unnoticed.
    type TurnDeps = Pick<SessionServerDeps, "getCurrentTurnId" | "appendAuditRecord">;
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
        startedAt: 1_767_225_600_000,
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

    it("passes startedAt through the closure untouched (#12122)", () => {
      // This hop has no explicit handling for `startedAt` — it survives only on
      // the `...recordInput` rest spread, which peels off `capturedTurnId` and
      // keeps everything else. So this asserts a property the closure has
      // always had rather than one #12122 added; it earns its place as the
      // guard against a future destructure widening to drop the field, which
      // would otherwise fail nowhere until a consumer noticed missing starts.
      const deps = fakeDeps();
      deps.sessionStore.sessionHelpIdMap.set("session-1", "help-session-9");
      const lc = new HttpLifecycle(deps);
      const deps_ = buildDeps(lc, "session-1");
      const startedAt = 1_767_225_600_123;
      deps_.appendAuditRecord({
        toolId: "agent.terminal",
        sessionId: "session-1",
        tier: "action",
        args: {},
        durationMs: 5,
        startedAt,
        outcome: { kind: "result", value: { ok: true, result: null } },
        capturedTurnId: null,
      });
      expect(deps.auditService.appendRecord).toHaveBeenCalledWith(
        expect.objectContaining({ startedAt })
      );
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
        startedAt: 1_767_225_600_000,
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
        startedAt: 1_767_225_600_000,
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
        startedAt: 1_767_225_600_000,
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

      expect(deps.dispatchAction).toHaveBeenCalledWith(
        "terminal.kill",
        { id: "t-1" },
        false,
        { token4LastChars: "1234", userAgent: "Claude Code" },
        "external"
      );
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

      expect(deps.dispatchAction).toHaveBeenCalledWith(
        "actions.list",
        {},
        false,
        undefined,
        "external"
      );
    });
  });

  describe("buildSessionServerDeps — spawn provenance origin (#11808)", () => {
    type OriginHandle = {
      buildSessionServerDeps: (
        sessionId: string
      ) => import("../sessionServer.js").SessionServerDeps;
    };

    /** Pinned-route fixture: `fakeDeps` leaves the pinned dispatcher unwired. */
    function pinnedOriginDeps(): HttpLifecycleDeps {
      return fakeDeps({
        dispatchActionForWebContents: vi
          .fn()
          .mockResolvedValue({ result: { ok: true, result: null } }),
      } as unknown as Partial<HttpLifecycleDeps>);
    }

    it.each(["help", "assistant-pane", "external"] as const)(
      "forwards a %s session's origin on the pinned dispatch route",
      async (origin) => {
        const deps = pinnedOriginDeps();
        const lc = new HttpLifecycle(deps);
        deps.sessionStore.sessionOriginMap.set("sess-origin", origin);
        deps.sessionStore.sessionWebContentsMap.set("sess-origin", 42);

        const sessionDeps = (lc as unknown as OriginHandle).buildSessionServerDeps("sess-origin");
        await sessionDeps.dispatchAction("agent.launch", {}, false);

        expect(deps.dispatchActionForWebContents).toHaveBeenCalledWith(
          42,
          "agent.launch",
          {},
          false,
          undefined,
          origin
        );
      }
    );

    it("keeps the build-time origin after the session's binding is torn down", async () => {
      const deps = pinnedOriginDeps();
      const lc = new HttpLifecycle(deps);
      deps.sessionStore.sessionOriginMap.set("sess-teardown", "assistant-pane");
      deps.sessionStore.sessionWebContentsMap.set("sess-teardown", 7);

      const sessionDeps = (lc as unknown as OriginHandle).buildSessionServerDeps("sess-teardown");

      // `clearSessionBinding` runs on teardown while a dispatch can still be in
      // flight, and `getOrigin` fails closed to "external" once the entry is
      // gone. Reading origin inside the closure would therefore relabel the
      // assistant's own spawn as an external client's the moment its session
      // ended — the build-time snapshot is what stops that. The pin is cleared
      // by the same call, so this asserts through the unpinned route.
      deps.sessionStore.clearSessionBinding("sess-teardown");
      await sessionDeps.dispatchAction("agent.launch", {}, false);

      expect(deps.dispatchAction).toHaveBeenCalledWith(
        "agent.launch",
        {},
        false,
        undefined,
        "assistant-pane"
      );
    });

    it("falls back to external for a session that never recorded an origin", async () => {
      const deps = pinnedOriginDeps();
      const lc = new HttpLifecycle(deps);
      deps.sessionStore.sessionWebContentsMap.set("sess-no-origin", 9);

      const sessionDeps = (lc as unknown as OriginHandle).buildSessionServerDeps("sess-no-origin");
      await sessionDeps.dispatchAction("agent.launch", {}, false);

      expect(deps.dispatchActionForWebContents).toHaveBeenCalledWith(
        9,
        "agent.launch",
        {},
        false,
        undefined,
        "external"
      );
    });
  });

  describe("assistant-pane pinning resolvers (#10647)", () => {
    function pinResolver(lc: HttpLifecycle) {
      return (
        lc as unknown as {
          resolveSessionPin: (
            h: string
          ) => { origin: "help" | "assistant-pane" | "external"; webContentsId: number } | null;
        }
      ).resolveSessionPin.bind(lc);
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

      const resolve = pinResolver(lc);
      expect(resolve("Bearer assistant-tok")).toEqual({
        origin: "assistant-pane",
        webContentsId: 77,
      });
      expect(resolve("Bearer unknown-tok")).toBeNull();
    });

    it("prefers the help resolver over the assistant resolver", () => {
      const lc = new HttpLifecycle(fakeDeps());
      lc.setHelpSessionWebContentsResolver((token) => (token === "help-tok" ? 11 : null));
      const assistant = vi.fn(() => 99);
      lc.setAssistantPaneWebContentsResolver(assistant);

      expect(pinResolver(lc)("Bearer help-tok")).toEqual({ origin: "help", webContentsId: 11 });
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
      expect(pinResolver(lc)("Bearer anything")).toBeNull();
      expect(ctxResolver(lc)("Bearer anything")).toBeNull();
    });
  });

  describe("auth gate", () => {
    it.each(["/mcp", "/messages?sessionId=victim-session"])(
      "cannot revoke a session claimed by an unauthenticated request to %s",
      async (url) => {
        const deps = fakeDeps();
        vi.mocked(deps.abusePolicy.recordDenial).mockReturnValue({ tripped: true });
        const lc = new HttpLifecycle(deps);
        lc.setApiKey("test-api-key");
        (lc as unknown as { port: number }).port = 45454;
        const req = {
          method: "POST",
          url,
          headers: { host: "127.0.0.1:45454", "mcp-session-id": "victim-session" },
        } as unknown as http.IncomingMessage;
        const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as http.ServerResponse;

        await (
          lc as unknown as {
            handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
          }
        ).handleRequest(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(401, expect.anything());
        expect(deps.auditService.recordAuth401).toHaveBeenCalledOnce();
        expect(deps.abusePolicy.recordDenial).not.toHaveBeenCalled();
        expect(deps.sessionStore.revokeSession).not.toHaveBeenCalled();
      }
    );

    it.each(["Authorization", "Host", "Origin", "Mcp-Session-Id"])(
      "refuses ambiguous duplicate %s headers before resolving a session",
      async (header) => {
        const deps = fakeDeps();
        const lc = new HttpLifecycle(deps);
        lc.setApiKey("test-api-key");
        (lc as unknown as { port: number }).port = 45454;
        const req = {
          method: "GET",
          url: "/unknown",
          headers: {
            host: "127.0.0.1:45454",
            authorization: "Bearer test-api-key",
          },
          rawHeaders: [header, "first", header.toLowerCase(), "second"],
        } as unknown as http.IncomingMessage;
        const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as http.ServerResponse;

        await (
          lc as unknown as {
            handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
          }
        ).handleRequest(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(400, expect.anything());
        expect(deps.dispatchAction).not.toHaveBeenCalled();
        expect(deps.sessionStore.revokeSession).not.toHaveBeenCalled();
      }
    );

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
  describe("workspace binding (#11789)", () => {
    beforeEach(() => {
      mockWebContentsById.clear();
    });

    type StreamableHandler = (
      req: http.IncomingMessage,
      res: http.ServerResponse,
      url: URL
    ) => Promise<void>;

    function handshakeHandler(lc: HttpLifecycle): StreamableHandler {
      return (
        lc as unknown as { handleStreamableHttpRequest: StreamableHandler }
      ).handleStreamableHttpRequest.bind(lc);
    }

    function sessionDepsFor(
      lc: HttpLifecycle,
      sessionId: string,
      binding?: { workspaceId: string }
    ) {
      return (
        lc as unknown as {
          buildSessionServerDeps: (
            id: string,
            b?: { workspaceId: string }
          ) => import("../sessionServer.js").SessionServerDeps;
        }
      ).buildSessionServerDeps(sessionId, binding);
    }

    function fakeReq(headers: Record<string, string | string[]>): http.IncomingMessage {
      return { method: "POST", headers } as unknown as http.IncomingMessage;
    }

    function fakeRes() {
      return {
        writeHead: vi.fn(),
        end: vi.fn(),
        headersSent: false,
      } as unknown as http.ServerResponse & {
        writeHead: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
    }

    function parseRejection(res: { end: ReturnType<typeof vi.fn> }) {
      return JSON.parse(res.end.mock.calls[0]![0] as string) as {
        error: { code: number; message: string; data: { code: string } };
      };
    }

    /** Deps whose workspace resolver knows exactly one workspace, WS_A. */
    function bindingDeps(overrides?: Partial<HttpLifecycleDeps>) {
      return fakeDeps({
        resolveWorkspaceBinding: vi.fn((workspaceId: string) => {
          if (workspaceId !== WS_A) throw new WorkspaceBindingError(workspaceId, "not-found");
          return { workspaceId, kind: "project" as const, workspacePath: "/tmp/a" };
        }),
        ...overrides,
      });
    }

    describe("handshake rejection", () => {
      it.each([
        [
          "disagreeing header and query param",
          { "daintree-workspace-id": WS_A },
          `?workspaceId=${WS_B}`,
          "WORKSPACE_SELECTOR_MISMATCH",
        ],
        [
          "a comma-folded header",
          { "daintree-workspace-id": `${WS_A},${WS_B}` },
          "",
          "WORKSPACE_SELECTOR_INVALID",
        ],
        [
          // A refusal is permanent for the client, so it is reserved for a
          // selector that can never become valid (#12082). A value outside both
          // id spaces names nothing that could ever exist.
          "a selector that is not shaped like a workspace id",
          { "daintree-workspace-id": "my-project" },
          "",
          "WORKSPACE_SELECTOR_INVALID",
        ],
        [
          "a project id truncated below the full hash length",
          { "daintree-workspace-id": WS_A.slice(0, 32) },
          "",
          "WORKSPACE_SELECTOR_INVALID",
        ],
      ])("refuses %s", async (_label, headers, query, expectedCode) => {
        const deps = bindingDeps();
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq(headers),
          res,
          new URL(`http://127.0.0.1:45454/mcp${query}`)
        );

        expect(res.writeHead).toHaveBeenCalledWith(400, { "Content-Type": "application/json" });
        expect(parseRejection(res).error.data.code).toBe(expectedCode);
        expect(deps.sessionStore.sessionWorkspaceMap.size).toBe(0);
      });

      it("refuses a shape-invalid selector before consulting the resolver at all", async () => {
        // The shape test is the reason an arbitrary string cannot mint a
        // session now that resolution failures no longer refuse one.
        const deps = bindingDeps();
        const lc = new HttpLifecycle(deps);

        await handshakeHandler(lc)(
          fakeReq({ "daintree-workspace-id": "../../etc/passwd" }),
          fakeRes(),
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(deps.resolveWorkspaceBinding).not.toHaveBeenCalled();
      });

      it("refuses a selector when the build has no workspace resolver wired", async () => {
        // Not a transient condition: a host that cannot resolve bindings will
        // not gain the ability part-way through a session.
        const deps = fakeDeps({ resolveWorkspaceBinding: undefined });
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "daintree-workspace-id": WS_A }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(parseRejection(res).error.data.code).toBe("WORKSPACE_SELECTOR_NOT_ALLOWED");
        expect(deps.sessionStore.sessionWorkspaceMap.size).toBe(0);
      });

      it("creates no session when the resolver fails unexpectedly", async () => {
        // An unexpected throw is a host bug of unknown duration, so it is
        // neither refused as a client error nor quietly bound — it propagates
        // to the request handler's 500, having allocated nothing.
        const deps = fakeDeps({
          resolveWorkspaceBinding: vi.fn(() => {
            throw new TypeError("registry exploded");
          }),
        });
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await expect(
          handshakeHandler(lc)(
            fakeReq({ "daintree-workspace-id": WS_A }),
            res,
            new URL("http://127.0.0.1:45454/mcp")
          )
        ).rejects.toThrow("registry exploded");

        expect(deps.sessionStore.sessionTierMap.size).toBe(0);
        expect(deps.sessionStore.sessionWorkspaceMap.size).toBe(0);
        expect(res.writeHead).not.toHaveBeenCalled();
      });

      it("leaves no session state behind — no id, tier, origin, or client metadata", async () => {
        const deps = bindingDeps();
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "daintree-workspace-id": "not-a-workspace-id" }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(deps.sessionStore.sessionTierMap.size).toBe(0);
        expect(deps.sessionStore.sessionOriginMap.size).toBe(0);
        expect(deps.sessionStore.sessionWorkspaceMap.size).toBe(0);
        expect(deps.sessionStore.registerClientMetadata).not.toHaveBeenCalled();
        // No Mcp-Session-Id: there is no session to resume.
        expect(res.writeHead.mock.calls[0]![1]).not.toHaveProperty("Mcp-Session-Id");
        expect(res.writeHead.mock.calls[0]![1]).not.toHaveProperty("mcp-session-id");
      });

      it("uses a JSON-RPC code in the implementation-defined range, distinct from session-not-found", async () => {
        const deps = bindingDeps();
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "daintree-workspace-id": "not-a-workspace-id" }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        const { code } = parseRejection(res).error;
        expect(code).toBeLessThanOrEqual(-32000);
        expect(code).toBeGreaterThanOrEqual(-32099);
        expect(code).not.toBe(-32000);
      });

      it("refuses a selector from a bearer that already routes through its own renderer", async () => {
        // A help bearer sending a workspace selector has two plausible targets.
        // Letting either win silently is the ambiguity this feature removes.
        const deps = bindingDeps();
        const lc = new HttpLifecycle(deps);
        lc.setHelpSessionWebContentsResolver((token) => (token === "help-tok" ? 42 : null));
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ authorization: "Bearer help-tok", "daintree-workspace-id": WS_A }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(parseRejection(res).error.data.code).toBe("WORKSPACE_SELECTOR_NOT_ALLOWED");
        expect(deps.resolveWorkspaceBinding).not.toHaveBeenCalled();
      });
    });

    describe("binding allocation when the workspace has no single live view (#12082)", () => {
      // Scoped to what the lifecycle itself does with the selector: whether a
      // session is allocated and what it binds to. These stop short of a
      // completed MCP handshake — the SDK transport rejects the stub request on
      // its own — so "the client really can connect and use the surface" is
      // proved end to end in `McpServerService.authAndToolSurface.test.ts`
      // against a real `StreamableHTTPClientTransport`, not here.
      /**
       * Drive the real selector path and report what it bound.
       *
       * The SDK transport rejects the stub request on its own (no Host header),
       * and the lifecycle then reclaims the uninitialized session — correctly,
       * and asserted below. So the maps are empty by the time the promise
       * settles, and the binding has to be observed as it is written rather
       * than read off the wreckage afterwards. Wrapping the real `set` is the
       * narrowest way to do that: it watches the exact production write instead
       * of a proxy for it.
       */
      async function handshake(deps: HttpLifecycleDeps, headers: Record<string, string>) {
        const map = deps.sessionStore.sessionWorkspaceMap;
        const realSet = map.set.bind(map);
        const bound: string[] = [];
        map.set = (sessionId: string, workspaceId: string) => {
          bound.push(workspaceId);
          return realSet(sessionId, workspaceId);
        };

        const lc = new HttpLifecycle(deps);
        const res = fakeRes();
        await handshakeHandler(lc)(fakeReq(headers), res, new URL("http://127.0.0.1:45454/mcp"));
        return { res, bound };
      }

      /**
       * The selector rejection code, or `null` when the response is not one.
       *
       * Not a bare "was 400 written" check: the SDK transport writes its own
       * 400 for the stub request, and conflating the two would let a genuine
       * refusal hide behind it. Only `rejectHandshake` emits `error.data.code`.
       */
      function rejectionCode(res: { end: ReturnType<typeof vi.fn> }): string | null {
        const body = res.end.mock.calls[0]?.[0];
        if (typeof body !== "string") return null;
        try {
          return (
            (JSON.parse(body) as { error?: { data?: { code?: string } } }).error?.data?.code ?? null
          );
        } catch {
          return null;
        }
      }

      function viewlessDeps(workspaceId: string, reason: "not-found" | "ambiguous") {
        return fakeDeps({
          resolveWorkspaceBinding: vi.fn(() => {
            throw new WorkspaceBindingError(workspaceId, reason);
          }),
        });
      }

      it.each([
        ["no live view", WS_MISSING, "not-found" as const],
        ["more than one live view", WS_DUP, "ambiguous" as const],
      ])(
        "allocates a bound session for a workspace with %s instead of refusing the handshake",
        async (_label, id, reason) => {
          // A 400 at `initialize` is terminal in every MCP client SDK, so
          // refusing here costs the client Daintree's whole tool surface for its
          // lifetime over a condition the user fixes by opening a window.
          const deps = viewlessDeps(id, reason);

          const { res, bound } = await handshake(deps, { "daintree-workspace-id": id });

          expect(rejectionCode(res)).toBeNull();
          expect(bound).toEqual([id]);
          expect(deps.sessionStore.registerClientMetadata).toHaveBeenCalled();
        }
      );

      it("allocates a binding for a scratch workspace id, not just a project id", async () => {
        const deps = viewlessDeps(WS_SCRATCH, "not-found");

        const { bound } = await handshake(deps, { "daintree-workspace-id": WS_SCRATCH });

        expect(bound).toEqual([WS_SCRATCH]);
      });

      it("leaves nothing behind when the SDK rejects the request before initializing", async () => {
        // The SDK answers a malformed pre-initialize request rather than
        // throwing, so `onsessioninitialized` never fires and there is no
        // `httpSessions` entry for the idle reaper to find. Without the
        // post-`handleRequest` sweep the tier, origin and workspace rows would
        // outlive the request forever — and a bound handshake now writes a
        // workspace row on this path.
        const deps = viewlessDeps(WS_MISSING, "not-found");

        const { bound } = await handshake(deps, { "daintree-workspace-id": WS_MISSING });

        // Premise: a binding really was written, so the emptiness below is the
        // sweep doing its job rather than the handshake never getting there.
        expect(bound).toEqual([WS_MISSING]);
        expect(deps.sessionStore.httpSessions.size).toBe(0);
        expect(deps.sessionStore.sessionWorkspaceMap.size).toBe(0);
        expect(deps.sessionStore.sessionTierMap.size).toBe(0);
        expect(deps.sessionStore.sessionOriginMap.size).toBe(0);
        expect(deps.sessionStore.clearClientMetadata).toHaveBeenCalled();
      });

      it("keeps the bound session routed at its workspace rather than following focus", async () => {
        // The guarantee #11789 exists to provide. A degraded binding must not
        // be a quiet downgrade to the focused-window path.
        const deps = bindingDeps({
          requestManifestForWorkspace: vi.fn().mockResolvedValue([]),
          dispatchActionForWorkspace: vi.fn().mockResolvedValue({ result: { ok: true } }),
        });
        const lc = new HttpLifecycle(deps);
        const sessionDeps = sessionDepsFor(lc, "bound", { workspaceId: WS_MISSING });

        await sessionDeps.requestManifest();
        await sessionDeps.dispatchAction("terminal.list", {}, false);

        expect(deps.requestManifestForWorkspace).toHaveBeenCalledWith(WS_MISSING);
        expect(deps.requestManifest).not.toHaveBeenCalled();
        expect(deps.dispatchAction).not.toHaveBeenCalled();
      });

      it("still refuses to read another workspace's warm cache", async () => {
        const deps = bindingDeps();
        const lc = new HttpLifecycle(deps);
        const sessionDeps = sessionDepsFor(lc, "bound", { workspaceId: WS_MISSING });

        expect(sessionDeps.getCachedManifest()).toBeNull();
        expect(deps.getCachedManifest).not.toHaveBeenCalled();
      });
    });

    describe("selector on an established session", () => {
      function liveSession(deps: HttpLifecycleDeps, sessionId: string, workspaceId?: string) {
        (deps.sessionStore.httpSessions as Map<string, unknown>).set(sessionId, {
          transport: { handleRequest: vi.fn().mockResolvedValue(undefined) },
          idleTimer: setTimeout(() => {}, 1_000_000),
        } as never);
        if (workspaceId) deps.sessionStore.sessionWorkspaceMap.set(sessionId, workspaceId);
      }

      function transportOf(deps: HttpLifecycleDeps, sessionId: string) {
        return (
          deps.sessionStore.httpSessions.get(sessionId) as unknown as {
            transport: { handleRequest: ReturnType<typeof vi.fn> };
          }
        ).transport;
      }

      it("passes a repeated matching selector straight through", async () => {
        const deps = bindingDeps();
        liveSession(deps, "sess-1", WS_A);
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "mcp-session-id": "sess-1", "daintree-workspace-id": WS_A }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(transportOf(deps, "sess-1").handleRequest).toHaveBeenCalled();
        expect(res.writeHead).not.toHaveBeenCalled();
      });

      it("refuses a selector naming a different workspace rather than rebinding", async () => {
        const deps = bindingDeps();
        liveSession(deps, "sess-1", WS_A);
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "mcp-session-id": "sess-1", "daintree-workspace-id": WS_B }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(parseRejection(res).error.data.code).toBe("WORKSPACE_SELECTOR_MISMATCH");
        // The call never reached the transport, so it cannot have run anywhere.
        expect(transportOf(deps, "sess-1").handleRequest).not.toHaveBeenCalled();
        // And the binding is unchanged — a selector never rebinds.
        expect(deps.sessionStore.sessionWorkspaceMap.get("sess-1")).toBe(WS_A);
      });

      it("refuses a selector on a session that never bound one", async () => {
        // The client believes its calls are scoped; every one of them would in
        // fact follow focus. Failing loud is the whole point.
        const deps = bindingDeps();
        liveSession(deps, "sess-1");
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "mcp-session-id": "sess-1", "daintree-workspace-id": WS_A }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(parseRejection(res).error.data.code).toBe("WORKSPACE_SELECTOR_MISMATCH");
        expect(transportOf(deps, "sess-1").handleRequest).not.toHaveBeenCalled();
      });

      it("exempts DELETE so a conflicting selector cannot strand a client", async () => {
        // DELETE terminates the session and routes no action anywhere, so
        // refusing it would only stop a client cleaning up after itself.
        const deps = bindingDeps();
        liveSession(deps, "sess-1", WS_A);
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          {
            method: "DELETE",
            headers: { "mcp-session-id": "sess-1", "daintree-workspace-id": WS_B },
          } as unknown as http.IncomingMessage,
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(transportOf(deps, "sess-1").handleRequest).toHaveBeenCalled();
        expect(res.writeHead).not.toHaveBeenCalled();
      });

      it("refuses a malformed selector on an established session", async () => {
        const deps = bindingDeps();
        liveSession(deps, "sess-1", WS_A);
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "mcp-session-id": "sess-1", "daintree-workspace-id": "  " }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(parseRejection(res).error.data.code).toBe("WORKSPACE_SELECTOR_INVALID");
        expect(transportOf(deps, "sess-1").handleRequest).not.toHaveBeenCalled();
      });

      it("refuses a query-param selector naming a different workspace", async () => {
        const deps = bindingDeps();
        liveSession(deps, "sess-1", WS_A);
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "mcp-session-id": "sess-1" }),
          res,
          new URL(`http://127.0.0.1:45454/mcp?workspaceId=${WS_B}`)
        );

        expect(parseRejection(res).error.data.code).toBe("WORKSPACE_SELECTOR_MISMATCH");
        expect(transportOf(deps, "sess-1").handleRequest).not.toHaveBeenCalled();
      });

      it("leaves a session carrying no selector completely alone", async () => {
        const deps = bindingDeps();
        liveSession(deps, "sess-1", WS_A);
        const lc = new HttpLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ "mcp-session-id": "sess-1" }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(transportOf(deps, "sess-1").handleRequest).toHaveBeenCalled();
      });
    });

    describe("routing", () => {
      it("routes a bound session's manifest and dispatch through its workspace", async () => {
        const deps = bindingDeps({
          requestManifestForWorkspace: vi.fn().mockResolvedValue([]),
          dispatchActionForWorkspace: vi.fn().mockResolvedValue({ result: { ok: true } }),
        });
        const lc = new HttpLifecycle(deps);
        const sessionDeps = sessionDepsFor(lc, "bound", { workspaceId: WS_A });

        await sessionDeps.requestManifest();
        await sessionDeps.dispatchAction("terminal.list", {}, false);

        expect(deps.requestManifestForWorkspace).toHaveBeenCalledWith(WS_A);
        // Only external sessions may bind a workspace — a selector from a
        // pinned bearer is refused at handshake — so the origin threaded here
        // is always "external" (#11808).
        expect(deps.dispatchActionForWorkspace).toHaveBeenCalledWith(
          WS_A,
          "terminal.list",
          {},
          false,
          "external"
        );
        // Never the focus-following path — that is the retargeting this removes.
        expect(deps.dispatchAction).not.toHaveBeenCalled();
        expect(deps.requestManifest).not.toHaveBeenCalled();
      });

      it("keeps an unbound external session on the focus-following path", () => {
        const deps = bindingDeps({
          dispatchActionForWorkspace: vi.fn(),
        });
        const lc = new HttpLifecycle(deps);
        const sessionDeps = sessionDepsFor(lc, "unbound");

        void sessionDeps.dispatchAction("terminal.list", {}, false);

        expect(deps.dispatchActionForWorkspace).not.toHaveBeenCalled();
        expect(deps.dispatchAction).toHaveBeenCalled();
      });

      it.each(["requestManifestForWorkspace", "dispatchActionForWorkspace"] as const)(
        "fails closed rather than following focus when %s is unwired",
        async (missing) => {
          // "Bound, and quietly following focus instead" is the precise bug
          // this feature removes, so a missing workspace helper can never be a
          // fallback — even though production wires them all.
          const deps = bindingDeps({
            requestManifestForWorkspace:
              missing === "requestManifestForWorkspace" ? undefined : vi.fn().mockResolvedValue([]),
            dispatchActionForWorkspace:
              missing === "dispatchActionForWorkspace"
                ? undefined
                : vi.fn().mockResolvedValue({ result: { ok: true } }),
          });
          const lc = new HttpLifecycle(deps);
          const sessionDeps = sessionDepsFor(lc, "bound", { workspaceId: WS_A });

          const call =
            missing === "requestManifestForWorkspace"
              ? sessionDeps.requestManifest()
              : sessionDeps.dispatchAction("terminal.list", {}, false);

          await expect(call).rejects.toMatchObject({ code: "SESSION_BINDING_GONE" });
          expect(deps.dispatchAction).not.toHaveBeenCalled();
          expect(deps.requestManifest).not.toHaveBeenCalled();
        }
      );

      it("reads the bound workspace's cached manifest, never the shared one", () => {
        const deps = bindingDeps({
          getCachedManifestForWorkspace: vi.fn(() => []),
        });
        const lc = new HttpLifecycle(deps);

        expect(sessionDepsFor(lc, "bound", { workspaceId: WS_A }).getCachedManifest()).toEqual([]);
        expect(deps.getCachedManifestForWorkspace).toHaveBeenCalledWith(WS_A);
        expect(deps.getCachedManifest).not.toHaveBeenCalled();
      });
    });

    describe("origin gates", () => {
      function boundExternal(deps: HttpLifecycleDeps, sessionId: string, wcId: number) {
        (deps.sessionStore.httpSessions as Map<string, unknown>).set(sessionId, {
          transport: { close: vi.fn().mockResolvedValue(undefined) },
          idleTimer: setTimeout(() => {}, 1_000_000),
        } as never);
        deps.sessionStore.sessionTierMap.set(sessionId, "external");
        deps.sessionStore.sessionOriginMap.set(sessionId, "external");
        deps.sessionStore.sessionWorkspaceMap.set(sessionId, WS_A);
        deps.sessionStore.sessionWebContentsMap.set(sessionId, wcId);
      }

      it("refuses issueGrant for a bound external session even though it has a route", () => {
        // The sharp edge the origin split exists for: issueGrant has no rank
        // floor, and the call gate honours a grant over failed tier membership,
        // so reaching it would mint access to tools outside the external list.
        const deps = bindingDeps();
        boundExternal(deps, "bound", 42);
        const lc = new HttpLifecycle(deps);

        expect(() => lc.issueGrant("bound", "git.commit", 42)).toThrow(/not eligible/);
      });

      it("refuses setSessionTier for a bound external session", () => {
        const deps = bindingDeps();
        boundExternal(deps, "bound", 42);
        const lc = new HttpLifecycle(deps);

        expect(() => lc.setSessionTier("bound", "system", 42)).toThrow(/not eligible/);
        expect(deps.sessionStore.sessionTierMap.get("bound")).toBe("external");
      });

      it.each(["notifyToolCallStarted", "notifyTierMismatch"] as const)(
        "suppresses %s for a bound external session",
        (channel) => {
          const deps = bindingDeps();
          boundExternal(deps, "bound", 42);
          const wc = { isDestroyed: () => false, send: vi.fn() };
          mockWebContentsById.set(42, wc);
          const lc = new HttpLifecycle(deps);
          const sessionDeps = sessionDepsFor(lc, "bound", { workspaceId: WS_A });

          if (channel === "notifyToolCallStarted") {
            sessionDeps.notifyToolCallStarted?.({
              sessionId: "bound",
              toolId: "terminal.list",
              args: {},
              startedAt: Date.now(),
              danger: false,
              capturedTurnId: null,
            });
          } else {
            sessionDeps.notifyTierMismatch?.({
              sessionId: "bound",
              toolId: "git.push",
              tier: "external",
              targetTier: "system",
            });
          }

          expect(wc.send).not.toHaveBeenCalled();
        }
      );

      it("still notifies a revoked help session, whose origin the revoke already cleared", () => {
        // The caller snapshots ownership and the pin before revoking; a live
        // re-read here would hit the fail-closed `external` default and drop
        // the recovery banner a genuine help session needs.
        const deps = bindingDeps();
        const wc = { isDestroyed: () => false, send: vi.fn() };
        mockWebContentsById.set(42, wc);
        const lc = new HttpLifecycle(deps);

        // No origin entry at all — exactly the post-revocation state.
        sessionDepsFor(lc, "revoked").notifySessionRevoked?.({
          sessionId: "revoked",
          denialKind: "tierMismatch",
          pinnedWebContentsId: 42,
          rendererOwned: true,
        });

        expect(wc.send).toHaveBeenCalledTimes(1);
      });

      it("does not notify a revoked external session", () => {
        const deps = bindingDeps();
        const wc = { isDestroyed: () => false, send: vi.fn() };
        mockWebContentsById.set(42, wc);
        const lc = new HttpLifecycle(deps);

        sessionDepsFor(lc, "revoked").notifySessionRevoked?.({
          sessionId: "revoked",
          denialKind: "tierMismatch",
          pinnedWebContentsId: 42,
          rendererOwned: false,
        });

        expect(wc.send).not.toHaveBeenCalled();
      });

      it("still delivers notifications to a help session", () => {
        const deps = bindingDeps();
        (deps.sessionStore.httpSessions as Map<string, unknown>).set("help", {} as never);
        deps.sessionStore.sessionOriginMap.set("help", "help");
        deps.sessionStore.sessionWebContentsMap.set("help", 42);
        const wc = { isDestroyed: () => false, send: vi.fn() };
        mockWebContentsById.set(42, wc);
        const lc = new HttpLifecycle(deps);

        sessionDepsFor(lc, "help").notifyTierMismatch?.({
          sessionId: "help",
          toolId: "git.push",
          tier: "workbench",
          targetTier: "system",
        });

        expect(wc.send).toHaveBeenCalledTimes(1);
      });
    });
  });
});
