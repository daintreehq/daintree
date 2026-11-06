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

// Only the pinned-view logger is observed; every other logger is the real one.
const { pinnedViewLogInfo } = vi.hoisted(() => ({ pinnedViewLogInfo: vi.fn() }));
vi.mock("../../../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../utils/logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      return name === "main:McpPinnedView" ? { ...logger, info: pinnedViewLogInfo } : logger;
    },
  };
});

import http from "node:http";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { HttpLifecycle, sendToPinnedView, sessionCredentialDigest } from "../httpLifecycle.js";
import { store } from "../../../store.js";
import {
  getEndpointRegistry,
  _resetEndpointRegistryForTesting,
} from "../../../ipc/endpointRegistry.js";
import type { HttpLifecycleDeps } from "../httpLifecycle.js";
import {
  MCP_SSE_HEARTBEAT_INTERVAL_MS,
  RESTART_BASE_DELAY_MS,
  RESTART_JITTER_MS,
  minimumPermittingTier,
} from "../shared.js";
import { NATIVE_GRANT_TOOL_IDS } from "../../../../shared/config/mcpGrants.js";
import { BUILT_IN_ACTION_IDS } from "../../../../shared/config/actionIds.js";
import { NATIVE_GRANT_USE_POLICY_OVERRIDES } from "../../../../shared/config/nativeGrantUsePolicies.js";
import type { SessionServerDeps } from "../sessionServer.js";
import { ResourceOwnershipLedger, helpOwnershipPrincipal } from "../resourceOwnership.js";
import { SessionBindingError, WorkspaceBindingError } from "../rendererBridge.js";
import { NO_VIEW_HANDLE } from "../../../ipc/endpoint.js";
import {
  _resetMcpDriveTargetResolverForTesting,
  setMcpDriveTargetResolver,
} from "../driveTarget.js";
import { AuditService, type McpAuditLogStore } from "../auditLog.js";

type BearerTestHandle = {
  touchBearer: (
    authHeader: string,
    userAgent: string,
    sessionId: string,
    tier: "core" | "full" | "external"
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
      sessionViewlessHelpMap: new Map(),
      sessionHelpIdMap: new Map(),
      resourceSubscriptions: new Map(),
      // Real behaviour, not a stub: these are authorization predicates, and a
      // fixture that always answered `true` would make every origin gate in
      // this suite vacuous (#11789).
      getOrigin(sessionId: string) {
        return this.sessionOriginMap.get(sessionId) ?? "external";
      },
      isRendererOwnedOrigin(sessionId: string) {
        return this.getOrigin(sessionId) === "help";
      },
      clearSessionBinding(sessionId: string) {
        this.sessionWebContentsMap.delete(sessionId);
        this.sessionContextMap.delete(sessionId);
        this.sessionOriginMap.delete(sessionId);
        this.sessionWorkspaceMap.delete(sessionId);
        this.sessionViewlessHelpMap.delete(sessionId);
        this.sessionCredentialMap.delete(sessionId);
        this.resourceOwnership.clearSession(sessionId);
      },
      // A real ledger, so the handshake's principal binding is observed as the
      // session server will read it (#12487).
      resourceOwnership: new ResourceOwnershipLedger(),
      // Real behaviour for the same reason as the origin predicates: a stub
      // that always matched would make every session-binding test vacuous.
      sessionCredentialMap: new Map<string, string>(),
      bindSessionCredential(sessionId: string, digest: string) {
        this.sessionCredentialMap.set(sessionId, digest);
      },
      isSessionCredential(sessionId: string, digest: string) {
        const bound = this.sessionCredentialMap.get(sessionId);
        return bound !== undefined && bound === digest;
      },
      drain: vi.fn(),
      getTier: vi.fn(() => "core" as const),
      createIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
      createHttpIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
      armIdleTimer: vi.fn(() => setTimeout(() => {}, 1_000_000)),
      resetIdleTimer: vi.fn(),
      resetHttpIdleTimer: vi.fn(),
      armTierElevationTimer: vi.fn(),
      clearElevationTimer: vi.fn(),
      revokeSession: vi.fn(() => false),
      registerClientMetadata: vi.fn(),
      // The real teardown's walk over this fake's surface, so the binding and
      // map assertions below observe a retirement. What the real store clears
      // on each route is proved against a real `SessionStore` in
      // `sessionRetirement.test.ts`.
      retireSession(sessionId: string, reason: "session-idle" | "session-ended") {
        for (const transports of [this.sessions, this.httpSessions]) {
          const session = transports.get(sessionId);
          if (session === undefined) continue;
          clearTimeout(session.idleTimer);
          transports.delete(sessionId);
        }
        this.clearElevationTimer(sessionId);
        this.sessionTierMap.delete(sessionId);
        this.grantCache.revokeSession(sessionId, reason);
        this.clearSessionBinding(sessionId);
        this.clearFigureCounter(sessionId);
        this.sessionHelpIdMap.delete(sessionId);
        this.clearDedupState(sessionId);
        this.clearClientMetadata(sessionId);
      },
      clearClientMetadata: vi.fn(),
      clearDedupState: vi.fn(),
      clearFigureCounter: vi.fn(),
      listExternalActiveClients: vi.fn(() => []),
      resolveLiveTransportForHelpSession: vi.fn(() => null),
      grantCache: {
        clearDenialCounts: vi.fn(),
        revokeSession: vi.fn<(sessionId: string, reason?: string) => number>(() => 0),
        revokeGrant: vi.fn(() => false),
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
    handleProjectRunCommand: vi.fn(),
    handleTerminalGetStatusViewless: vi
      .fn()
      .mockResolvedValue({ terminals: [], source: "pty", unavailableFields: [] }),
    handleTerminalReadLastMessageOwned: vi
      .fn()
      .mockResolvedValue({ status: "unavailable", reason: "no-message" }),
    isTerminalIdInUse: vi.fn(() => false),
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

  describe("listener holds (#15999)", () => {
    function serveMocks(): MockServer[] {
      const servers: MockServer[] = [];
      vi.spyOn(http, "createServer").mockImplementation(((...args: unknown[]) => {
        const handler = args.find((a) => typeof a === "function") as
          http.RequestListener | undefined;
        const s = mockServer();
        if (handler) s.on("request", handler);
        servers.push(s);
        return s;
      }) as unknown as typeof http.createServer);
      return servers;
    }

    function heldRoute() {
      return { path: "/mcp/feature", handle: vi.fn(async () => {}), close: vi.fn() };
    }

    function closeUnexpectedly(server: MockServer): void {
      server.listening = false;
      server.emit("close");
    }

    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    it("opens the listener for a hold with the server off, without the control surface", async () => {
      const servers = serveMocks();
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      lc.isEnabled = () => false;

      const hold = await lc.holdListener("feature", heldRoute());
      expect(servers).toHaveLength(1);
      expect(hold.port).toBe(45454);
      expect(lc.isListening).toBe(true);
      expect(lc.isRunning).toBe(false);
      expect(lc.currentPort).toBeNull();
      expect(deps.setupIpcListeners).not.toHaveBeenCalled();
      expect(deps.emitStatusChange).not.toHaveBeenCalled();
    });

    it("reopens a listener only a hold keeps after it closes unexpectedly", async () => {
      const servers = serveMocks();
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      lc.isEnabled = () => false;
      const route = heldRoute();
      const hold = await lc.holdListener("feature", route);

      closeUnexpectedly(servers[0]);
      expect(route.close).toHaveBeenCalledTimes(1);
      expect(lc.isListening).toBe(false);
      expect(hold.port).toBeNull();
      // Nothing that reports the server changed: it was never running.
      expect(deps.emitStatusChange).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(RESTART_BASE_DELAY_MS + RESTART_JITTER_MS);
      expect(servers).toHaveLength(2);
      expect(lc.isListening).toBe(true);
      expect(lc.isRunning).toBe(false);
      expect(hold.port).toBe(45454);

      await hold.release();
      expect(servers[1].close).toHaveBeenCalled();
      expect(lc.isListening).toBe(false);
    });

    it("drops a pending restart once the last hold goes with the server off", async () => {
      const servers = serveMocks();
      const lc = new HttpLifecycle(fakeDeps());
      lc.isEnabled = () => false;
      const hold = await lc.holdListener("feature", heldRoute());

      closeUnexpectedly(servers[0]);
      expect(vi.getTimerCount()).toBe(1);
      await hold.release();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(servers).toHaveLength(1);
      expect(lc.isListening).toBe(false);
    });

    it("drops a pending restart when shutdown joins a stop the holds survived", async () => {
      const servers = serveMocks();
      const lc = new HttpLifecycle(fakeDeps());
      lc.isEnabled = () => true;
      await lc.start({} as unknown as never);
      await lc.holdListener("feature", heldRoute());
      closeUnexpectedly(servers[0]);

      await Promise.all([lc.stop(), lc.shutdown()]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(servers).toHaveLength(1);
      expect(lc.isListening).toBe(false);
    });

    it("refuses a hold that shutdown ended while its listener was opening", async () => {
      const s = mockServer();
      let bind: (() => void) | undefined;
      s.listen.mockImplementation((_port: number, _host: string, cb?: () => void) => {
        bind = () => {
          s.listening = true;
          cb?.();
        };
        return s;
      });
      vi.spyOn(http, "createServer").mockReturnValue(s);
      const lc = new HttpLifecycle(fakeDeps());
      lc.isEnabled = () => false;

      const opening = lc.holdListener("feature", heldRoute());
      const quit = lc.shutdown();
      bind!();
      await expect(opening).rejects.toThrow("ended while it was being opened");
      await quit;
      expect(s.close).toHaveBeenCalled();
      expect(lc.isListening).toBe(false);
    });

    it("takes the hold back when the listener cannot bind", async () => {
      const s = mockServer();
      s.listen.mockImplementation(() => {
        s.emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
        return s;
      });
      vi.spyOn(http, "createServer").mockReturnValue(s);
      const lc = new HttpLifecycle(fakeDeps());
      lc.isEnabled = () => false;
      const route = heldRoute();

      await expect(lc.holdListener("feature", route)).rejects.toThrow("Failed to bind");
      expect(route.close).toHaveBeenCalledTimes(1);
      // Taken back, so the same id holds again rather than reading as held.
      await expect(lc.holdListener("feature", heldRoute())).rejects.toThrow("Failed to bind");
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
      deps.sessionStore.sessionTierMap.set("sess-1", "core");
      pinnedSession(deps, "sess-1", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-1", "full");

      expect(result).toEqual({ sessionId: "sess-1", tier: "full" });
      expect(deps.sessionStore.sessionTierMap.get("sess-1")).toBe("full");
      // The elevation must arm the decay timer with the pre-elevation tier
      // as the baseline (#8462) — otherwise the elevation is unbounded.
      expect(deps.sessionStore.armTierElevationTimer).toHaveBeenCalledWith(
        "sess-1",
        "full",
        "core"
      );
    });

    it("writes a tier.elevated audit record with from/to tier and the bounded window (#9151)", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-aud", "core");
      pinnedSession(deps, "sess-aud", 42);

      const lc = new HttpLifecycle(deps);
      lc.setSessionTier("sess-aud", "full");

      expect(deps.auditService.appendGrantRecord).toHaveBeenCalledTimes(1);
      const record = (deps.auditService.appendGrantRecord as ReturnType<typeof vi.fn>).mock
        .calls[0]![0];
      expect(record).toMatchObject({
        type: "tier.elevated",
        sessionId: "sess-aud",
        toolId: "*",
        tier: "full",
        previousTier: "core",
      });
      expect(record.ttlMs).toBeGreaterThan(0);
      expect(record.expiresAt).toBeGreaterThan(0);
    });

    it("does not audit a same-tier re-elevation (no actual privilege change, #9151)", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-same", "full");
      pinnedSession(deps, "sess-same", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-same", "full");

      expect(result.tier).toBe("full");
      // Same tier in → nothing elevated → no audit row (would be a misleading
      // full→full entry).
      expect(deps.auditService.appendGrantRecord).not.toHaveBeenCalled();
    });

    it("refuses downgrades silently and keeps current tier without auditing", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-2", "full");
      pinnedSession(deps, "sess-2", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-2", "core");

      expect(result.tier).toBe("full");
      expect(deps.sessionStore.sessionTierMap.get("sess-2")).toBe("full");
      // No mutation, no audit row — only accepted elevations are logged.
      expect(deps.auditService.appendGrantRecord).not.toHaveBeenCalled();
    });

    it("throws for unknown sessions", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("nonexistent", "full")).toThrow(/Unknown session/);
    });

    it("throws when caller WebContents id doesn't match the pinned id", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-pin", "core");
      pinnedSession(deps, "sess-pin", 42);

      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("sess-pin", "full", 99)).toThrow(/not the pinned renderer/);
      // Tier must remain unchanged on rejection.
      expect(deps.sessionStore.sessionTierMap.get("sess-pin")).toBe("core");
    });

    it("accepts caller WebContents id when it matches the pinned id", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-ok", "core");
      pinnedSession(deps, "sess-ok", 42);

      const lc = new HttpLifecycle(deps);
      const result = lc.setSessionTier("sess-ok", "full", 42);
      expect(result.tier).toBe("full");
    });

    it("throws when the session's transport has already closed (idle/torn down)", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-dead", "core");
      deps.sessionStore.sessionWebContentsMap.set("sess-dead", 42);
      // Don't add to sessions/httpSessions — transport is dead.

      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("sess-dead", "full")).toThrow(/no longer active/);
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
      expect(() => lc.setSessionTier("ext-1", "full")).toThrow(
        /not eligible for renderer tier elevation/
      );
    });

    it("throws for invalid tier values", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-3", "core");
      pinnedSession(deps, "sess-3", 42);

      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("sess-3", "external" as never)).toThrow(/Invalid tier/);
      expect(deps.sessionStore.sessionTierMap.get("sess-3")).toBe("core");
    });

    it("rejects the pre-split ladder names rather than normalizing a write", () => {
      // Legacy names are mapped only where stored settings are read. A live
      // elevation request carrying one comes from a stale renderer, and
      // guessing its rung would let it pick up `full` by asking for `system`.
      const deps = fakeDeps();
      deps.sessionStore.sessionTierMap.set("sess-legacy", "core");
      pinnedSession(deps, "sess-legacy", 42);

      const lc = new HttpLifecycle(deps);
      for (const legacy of ["workbench", "action", "system"]) {
        expect(() => lc.setSessionTier("sess-legacy", legacy as never, 42)).toThrow(/Invalid tier/);
      }
      expect(deps.sessionStore.sessionTierMap.get("sess-legacy")).toBe("core");
      expect(deps.sessionStore.armTierElevationTimer).not.toHaveBeenCalled();
    });

    it("throws for blank session ids", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      expect(() => lc.setSessionTier("", "full")).toThrow(/Invalid sessionId/);
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

  describe("revokeGrant (#14975)", () => {
    function grantCacheOf(deps: HttpLifecycleDeps) {
      return (
        deps.sessionStore as unknown as {
          grantCache: {
            revokeGrant: ReturnType<typeof vi.fn>;
            revokeSession: ReturnType<typeof vi.fn>;
          };
        }
      ).grantCache;
    }

    it("ends only the named tool's grant, never the whole session", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("sess-1", 42);
      grantCacheOf(deps).revokeGrant.mockReturnValue(true);
      const lc = new HttpLifecycle(deps);

      expect(lc.revokeGrant("sess-1", "terminal.kill", 42)).toEqual({
        sessionId: "sess-1",
        toolId: "terminal.kill",
        revoked: true,
      });
      expect(grantCacheOf(deps).revokeGrant).toHaveBeenCalledWith(
        "sess-1",
        "terminal.kill",
        "user"
      );
      expect(grantCacheOf(deps).revokeSession).not.toHaveBeenCalled();
    });

    it("refuses a caller that isn't the session's pinned renderer before touching the cache", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("sess-pin", 42);
      const lc = new HttpLifecycle(deps);

      expect(() => lc.revokeGrant("sess-pin", "terminal.kill", 99)).toThrow(
        /not the pinned renderer/
      );
      expect(grantCacheOf(deps).revokeGrant).not.toHaveBeenCalled();
    });

    it("passes through the cache's revoked: false for a live, correctly pinned session", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("sess-1", 42);
      grantCacheOf(deps).revokeGrant.mockReturnValue(false);
      const lc = new HttpLifecycle(deps);

      expect(lc.revokeGrant("sess-1", "terminal.kill", 42)).toEqual({
        sessionId: "sess-1",
        toolId: "terminal.kill",
        revoked: false,
      });
      expect(grantCacheOf(deps).revokeGrant).toHaveBeenCalledWith(
        "sess-1",
        "terminal.kill",
        "user"
      );
    });

    it("reports revoked: false for a drained session instead of throwing", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);

      expect(lc.revokeGrant("sess-gone", "terminal.kill", 99)).toEqual({
        sessionId: "sess-gone",
        toolId: "terminal.kill",
        revoked: false,
      });
    });

    it("throws for blank ids", () => {
      const lc = new HttpLifecycle(fakeDeps());
      expect(() => lc.revokeGrant("", "terminal.kill")).toThrow(/Invalid sessionId/);
      expect(() => lc.revokeGrant("sess-1", "")).toThrow(/Invalid toolId/);
    });
  });

  // The single-tool "Approve once" path must enforce the same floor as
  // issueNativeGrant: a grant may only name a tool some non-external help tier
  // already permits. The call gate honours a grant OVER failed tier membership,
  // so without this check a pinned renderer could mint a grant for an id in no
  // tier at all and the authorization contract would rest on the UI never
  // offering the button rather than on main refusing it (#11585).
  describe("helpLaneFor (#14995)", () => {
    function wired(terminalId: string | null, projectId: string | null) {
      const deps = fakeDeps();
      deps.sessionStore.sessionHelpIdMap.set("sess-1", "help-1");
      const lc = new HttpLifecycle(deps);
      lc.setHelpSessionTerminalResolver((id) => (id === "help-1" ? terminalId : null));
      lc.setAssistantControl({
        control: {} as never,
        sessionProject: (id) => (id === "help-1" ? projectId : null),
      });
      return lc;
    }

    it("names the help session, its terminal now, and its project", () => {
      expect(wired("term-1", "proj-1").helpLaneFor("sess-1")).toEqual({
        helpSessionId: "help-1",
        terminalId: "term-1",
        projectId: "proj-1",
      });
    });

    it("has no lane for a session no help session is bound to", () => {
      expect(wired("term-1", "proj-1").helpLaneFor("sess-other")).toBeNull();
    });

    it("has no lane without a terminal or a project to type into", () => {
      expect(wired(null, "proj-1").helpLaneFor("sess-1")).toBeNull();
      expect(wired("term-1", null).helpLaneFor("sess-1")).toBeNull();
    });

    it("has no lane while the help service isn't wired", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionHelpIdMap.set("sess-1", "help-1");
      expect(new HttpLifecycle(deps).helpLaneFor("sess-1")).toBeNull();
    });
  });

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

      // Ground truth: project.runCheck is genuinely reachable in the full tool
      // set, so the rejections below are a real boundary rather than an
      // unknown string.
      expect(minimumPermittingTier("project.runCheck")).not.toBeNull();
      expect(lc.issueGrant("sess-1", "project.runCheck", 42).toolId).toBe("project.runCheck");
      expect(grantCacheOf(deps).issueGrant).toHaveBeenCalledWith("sess-1", "project.runCheck");
    });

    it.each([
      // In no tier allowlist at all — the case the new hidden marking documents.
      "actions.persistedStores",
      "totally.notatool",
      // A real tool that left MCP with the core/full split: a grant must not be
      // a way back onto the surface for it.
      "git.commit",
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
      grantCacheOf(deps).issueNativeGrant.mockReturnValue(mintEntry(["project.runCheck"], 5));
      const lc = new HttpLifecycle(deps);

      const result = lc.issueNativeGrant(
        "help-1",
        { allowedTools: ["project.runCheck"], maxUses: 5 },
        42
      );

      expect(resolverOf(deps)).toHaveBeenCalledWith("help-1", 42);
      expect(grantCacheOf(deps).issueNativeGrant).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "transport-1",
          actorId: "help-1",
          actorType: "help-session",
          allowedTools: ["project.runCheck"],
          maxUses: 5,
        })
      );
      expect(result.grantId).toBe("grant-uuid");
    });

    it("requires a caller WebContents id (fails closed)", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      expect(() => lc.issueNativeGrant("help-1", { allowedTools: ["project.runCheck"] })).toThrow(
        /Caller WebContents id is required/
      );
    });

    it("throws when no live pinned session backs the help id", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue(null);
      const lc = new HttpLifecycle(deps);
      expect(() =>
        lc.issueNativeGrant("help-gone", { allowedTools: ["project.runCheck"] }, 42)
      ).toThrow(/No live pinned session/);
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
      const toolId = "terminal.closeAll";
      // A real, tier-reachable tool — so it is the fan-out policy refusing it
      // here, not the unknown-tool check above.
      expect(minimumPermittingTier(toolId)).not.toBe(null);
      // Names the offender AND the reason: `/cannot cover/` alone would also
      // pass if the tool had merely fallen out of every tier allowlist.
      expect(() => lc.issueNativeGrant("help-1", { allowedTools: [toolId] }, 42)).toThrow(
        /cannot cover terminal\.closeAll\b.*every target it finds/
      );
      expect(grantCacheOf(deps).issueNativeGrant).not.toHaveBeenCalled();
    });

    it("refuses a fan-out tool that left MCP as non-grantable before weighing its fan-out", () => {
      // `terminal.killAll` is on neither tool set since the core/full split, so
      // the grant fails on the tool itself — a grant never names a tool the
      // session could not otherwise reach, whatever its use policy.
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      const lc = new HttpLifecycle(deps);
      expect(minimumPermittingTier("terminal.killAll")).toBeNull();
      expect(() =>
        lc.issueNativeGrant("help-1", { allowedTools: ["terminal.killAll"] }, 42)
      ).toThrow(/non-grantable tool\(s\): terminal\.killAll$/);
      expect(grantCacheOf(deps).issueNativeGrant).not.toHaveBeenCalled();
    });

    it("rejects a mixed scope rather than silently narrowing it (#12121)", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      const lc = new HttpLifecycle(deps);
      // The minted scope must be exactly the scope the user approved: dropping
      // the offender would hand back a grant card that reads as approved-in-full.
      // `terminal.closeAll` is the only fan-out tool left on either tool set,
      // so the offender list has one entry and the message is singular.
      const attempt = () =>
        lc.issueNativeGrant(
          "help-1",
          { allowedTools: ["project.runCheck", "terminal.closeAll"] },
          42
        );
      expect(attempt).toThrow(/cannot cover terminal\.closeAll:/);
      expect(attempt).toThrow(/Remove it\b/);
      expect(grantCacheOf(deps).issueNativeGrant).not.toHaveBeenCalled();
    });

    // The Settings form offers exactly `NATIVE_GRANT_TOOL_IDS` (#14982), so the
    // list has to agree with this method in both directions: every offered tool
    // mints, and every candidate left off it is one this method refuses.
    it("accepts every tool the Settings form offers and refuses every one it leaves out", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      grantCacheOf(deps).issueNativeGrant.mockImplementation((params: { allowedTools: string[] }) =>
        mintEntry(params.allowedTools, 1)
      );
      const lc = new HttpLifecycle(deps);
      expect(NATIVE_GRANT_TOOL_IDS.length).toBeGreaterThan(0);

      for (const toolId of NATIVE_GRANT_TOOL_IDS) {
        const result = lc.issueNativeGrant("help-1", { allowedTools: [toolId], maxUses: 1 }, 42);
        expect(grantCacheOf(deps).issueNativeGrant).toHaveBeenLastCalledWith(
          expect.objectContaining({ allowedTools: [toolId] })
        );
        expect(result.allowedTools).toEqual([toolId]);
      }

      // Every built-in action, not just the help tiers, so a future widening of
      // what main accepts fails here instead of going missing from the picker.
      const offered = new Set(NATIVE_GRANT_TOOL_IDS);
      const leftOut = [
        ...BUILT_IN_ACTION_IDS,
        ...Object.keys(NATIVE_GRANT_USE_POLICY_OVERRIDES),
        "totally.notatool",
      ].filter((toolId) => !offered.has(toolId));
      expect(leftOut).toContain("terminal.closeAll");
      for (const toolId of leftOut) {
        expect(() =>
          lc.issueNativeGrant("help-1", { allowedTools: [toolId], maxUses: 1 }, 42)
        ).toThrow();
      }
      expect(grantCacheOf(deps).issueNativeGrant).toHaveBeenCalledTimes(
        NATIVE_GRANT_TOOL_IDS.length
      );
    });

    it("rejects an out-of-range maxUses", () => {
      const deps = fakeDeps();
      resolverOf(deps).mockReturnValue("transport-1");
      const lc = new HttpLifecycle(deps);
      expect(() =>
        lc.issueNativeGrant("help-1", { allowedTools: ["project.runCheck"], maxUses: 0 }, 42)
      ).toThrow(/maxUses/);
      expect(() =>
        lc.issueNativeGrant("help-1", { allowedTools: ["project.runCheck"], maxUses: 9999 }, 42)
      ).toThrow(/maxUses/);
    });

    it("revokeNativeGrant enforces caller-pin against the grant's session", () => {
      const deps = fakeDeps();
      deps.sessionStore.sessionWebContentsMap.set("transport-1", 42);
      grantCacheOf(deps).getNativeGrant.mockReturnValue(mintEntry(["project.runCheck"], 5));
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
      grantCacheOf(deps).getNativeGrant.mockReturnValue(mintEntry(["project.runCheck"], 5));
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

  describe("buildSessionServerDeps — the assistant's pinned-view read scope (#12883)", () => {
    type ScopeDeps = { isTerminalInPinnedWorkspace?: (terminalId: string) => Promise<boolean> };
    const buildDeps = (lc: HttpLifecycle, sessionId: string): ScopeDeps =>
      (
        lc as unknown as { buildSessionServerDeps: (id: string) => ScopeDeps }
      ).buildSessionServerDeps(sessionId);

    const PIN = 404;
    let view: { isDestroyed: () => boolean; send: () => void };
    let workspaceOfView: string | null;
    let panes: Map<string, string>;

    function setup(options: { pinned?: boolean; registry?: unknown } = {}) {
      const deps = fakeDeps();
      const isAgentPaneInWorkspace = vi.fn(
        async (id: string, workspaceId: string) => panes.get(id) === workspaceId
      );
      deps.isAgentPaneInWorkspace = isAgentPaneInWorkspace;
      if (options.pinned !== false) deps.sessionStore.sessionWebContentsMap.set("session-1", PIN);
      const lc = new HttpLifecycle(deps);
      const getWorkspaceRefForWebContents = vi.fn((id: number) =>
        id === PIN && workspaceOfView !== null
          ? { kind: "project", workspaceId: workspaceOfView, workspacePath: "/p" }
          : null
      );
      (lc as unknown as { registry: unknown }).registry =
        "registry" in options
          ? options.registry
          : {
              getByWebContentsId: (id: number) =>
                id === PIN
                  ? { services: { projectViewManager: { getWorkspaceRefForWebContents } } }
                  : undefined,
            };
      return { deps, lc, getWorkspaceRefForWebContents, isAgentPaneInWorkspace };
    }

    beforeEach(() => {
      view = { isDestroyed: () => false, send: () => undefined };
      mockWebContentsById.set(PIN, view);
      workspaceOfView = "ws-a";
      panes = new Map([
        ["mine", "ws-a"],
        ["theirs", "ws-b"],
      ]);
    });

    afterEach(() => {
      mockWebContentsById.delete(PIN);
    });

    it("admits a pane of the pinned view's workspace and nothing else", async () => {
      const { lc, getWorkspaceRefForWebContents, isAgentPaneInWorkspace } = setup();
      const inView = buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!;

      expect(await inView("mine")).toBe(true);
      expect(await inView("theirs")).toBe(false);
      expect(await inView("untracked")).toBe(false);
      expect(getWorkspaceRefForWebContents).toHaveBeenCalledWith(PIN);
      expect(isAgentPaneInWorkspace).toHaveBeenCalledWith("mine", "ws-a");
    });

    it("refuses an unpinned session without looking the terminal up", async () => {
      const { lc, isAgentPaneInWorkspace } = setup({ pinned: false });
      expect(await buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!("mine")).toBe(false);
      expect(isAgentPaneInWorkspace).not.toHaveBeenCalled();
    });

    it("rechecks on every call, so a pin dropped after build refuses", async () => {
      const { deps, lc } = setup();
      const inView = buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!;
      expect(await inView("mine")).toBe(true);

      deps.sessionStore.sessionWebContentsMap.delete("session-1");

      expect(await inView("mine")).toBe(false);
    });

    it("refuses when the view goes while the record lookup is out", async () => {
      const { lc, isAgentPaneInWorkspace } = setup();
      isAgentPaneInWorkspace.mockImplementationOnce(async () => {
        view.isDestroyed = () => true;
        return true;
      });

      expect(await buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!("mine")).toBe(false);
    });

    it("refuses when the view is repointed while the record lookup is out", async () => {
      const { lc, isAgentPaneInWorkspace } = setup();
      isAgentPaneInWorkspace.mockImplementationOnce(async () => {
        workspaceOfView = "ws-b";
        return true;
      });

      expect(await buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!("mine")).toBe(false);
    });

    it("refuses once the pinned view is destroyed", async () => {
      const { lc } = setup();
      const inView = buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!;

      view.isDestroyed = () => true;

      expect(await inView("mine")).toBe(false);
    });

    it("refuses a recycled webContents id, even one showing the same workspace", async () => {
      const { lc } = setup();
      const inView = buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!;

      mockWebContentsById.set(PIN, { isDestroyed: () => false, send: () => undefined });

      expect(await inView("mine")).toBe(false);
    });

    it("refuses when the view's workspace is unknown", async () => {
      workspaceOfView = null;
      const { lc, isAgentPaneInWorkspace } = setup();

      expect(await buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!("mine")).toBe(false);
      expect(isAgentPaneInWorkspace).not.toHaveBeenCalled();
    });

    it("refuses without a registry, and when a lookup throws", async () => {
      const noRegistry = setup({ registry: null });
      expect(await buildDeps(noRegistry.lc, "session-1").isTerminalInPinnedWorkspace!("mine")).toBe(
        false
      );

      const throwing = setup({
        registry: {
          getByWebContentsId: () => {
            throw new Error("window torn down");
          },
        },
      });
      expect(await buildDeps(throwing.lc, "session-1").isTerminalInPinnedWorkspace!("mine")).toBe(
        false
      );

      const rejecting = setup();
      rejecting.isAgentPaneInWorkspace.mockRejectedValueOnce(new Error("pty host gone"));
      expect(await buildDeps(rejecting.lc, "session-1").isTerminalInPinnedWorkspace!("mine")).toBe(
        false
      );
    });

    it("refuses when main cannot look terminals up at all", async () => {
      const { deps, lc } = setup();
      delete deps.isAgentPaneInWorkspace;

      expect(await buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!("mine")).toBe(false);
    });

    // The assistant's refusal reads the same whichever side failed, so only
    // the log can say which one did (#13439).
    it("logs which side refused, and nothing on admission", async () => {
      pinnedViewLogInfo.mockClear();
      const { deps, lc, isAgentPaneInWorkspace } = setup();
      const inView = buildDeps(lc, "session-1").isTerminalInPinnedWorkspace!;

      expect(await inView("mine")).toBe(true);
      expect(pinnedViewLogInfo).not.toHaveBeenCalled();

      expect(await inView("theirs")).toBe(false);
      isAgentPaneInWorkspace.mockRejectedValueOnce(new Error("pty host gone"));
      expect(await inView("mine")).toBe(false);
      isAgentPaneInWorkspace.mockImplementationOnce(async () => {
        workspaceOfView = "ws-b";
        return true;
      });
      expect(await inView("mine")).toBe(false);
      workspaceOfView = null;
      expect(await inView("mine")).toBe(false);
      workspaceOfView = "ws-a";
      delete deps.isAgentPaneInWorkspace;
      expect(await inView("mine")).toBe(false);

      const logged = pinnedViewLogInfo.mock.calls.map(
        ([, context]) => context as { sessionId: string; terminalId: string; reason: string }
      );
      expect(logged.map((context) => context.reason)).toEqual([
        "not-in-workspace",
        "lookup-failed",
        "view-changed",
        "no-view-workspace",
        "unwired",
      ]);
      expect(logged[0]).toEqual({
        sessionId: "session-1",
        terminalId: "theirs",
        reason: "not-in-workspace",
      });
    });
  });

  describe("buildSessionServerDeps — skills visibility (#13831)", () => {
    type SkillDeps = {
      handleSkillsSearch: (rawArgs: unknown) => unknown;
      handleSkillsLoad: (rawArgs: unknown) => unknown;
    };
    const buildDeps = (
      lc: HttpLifecycle,
      sessionId: string,
      workspaceBinding?: { workspaceId: string }
    ): SkillDeps =>
      (
        lc as unknown as {
          buildSessionServerDeps: (id: string, binding?: { workspaceId: string }) => SkillDeps;
        }
      ).buildSessionServerDeps(sessionId, workspaceBinding);

    const PROJECT = "c".repeat(64);
    const SCRATCH = "0b9a4c1e-6f2d-4a8b-9c3d-5e7f1a2b3c4d";
    const PIN = 505;

    function setup() {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      return { deps, lc };
    }

    const projectSeenBy = (deps: ReturnType<typeof fakeDeps>, skills: SkillDeps) => {
      skills.handleSkillsSearch({ query: "tdd" });
      skills.handleSkillsLoad({ id: "x" });
      const search = vi.mocked(deps.handleSkillsSearch).mock.calls.at(-1);
      const load = vi.mocked(deps.handleSkillsLoad).mock.calls.at(-1);
      expect(search?.[0]).toEqual({ query: "tdd" });
      expect(load?.[1]).toEqual(search?.[1]);
      return (search?.[1] as { projectId: string | null } | undefined)?.projectId;
    };

    afterEach(() => {
      mockWebContentsById.delete(PIN);
    });

    it("reads a workspace-bound session's own project", () => {
      const { deps, lc } = setup();
      expect(projectSeenBy(deps, buildDeps(lc, "s", { workspaceId: PROJECT }))).toBe(PROJECT);
    });

    it("gives an unbound session no project, never the focused one", () => {
      const { deps, lc } = setup();
      expect(projectSeenBy(deps, buildDeps(lc, "s"))).toBeNull();
    });

    it("gives a session bound to a scratch no project", () => {
      const { deps, lc } = setup();
      expect(projectSeenBy(deps, buildDeps(lc, "s", { workspaceId: SCRATCH }))).toBeNull();
    });

    it("reads a viewless help session's project, and loses it at teardown", () => {
      const { deps, lc } = setup();
      deps.sessionStore.sessionViewlessHelpMap.set("s", PROJECT);
      const skills = buildDeps(lc, "s");
      expect(projectSeenBy(deps, skills)).toBe(PROJECT);
      deps.sessionStore.sessionViewlessHelpMap.delete("s");
      expect(projectSeenBy(deps, skills)).toBeNull();
    });

    it("reads a pinned help session's view, and loses it with the pin", () => {
      const { deps, lc } = setup();
      mockWebContentsById.set(PIN, { isDestroyed: () => false, send: () => undefined });
      deps.sessionStore.sessionWebContentsMap.set("s", PIN);
      (lc as unknown as { registry: unknown }).registry = {
        getByWebContentsId: (id: number) =>
          id === PIN
            ? {
                services: {
                  projectViewManager: {
                    getWorkspaceRefForWebContents: () => ({
                      kind: "project",
                      workspaceId: PROJECT,
                      workspacePath: "/p",
                    }),
                  },
                },
              }
            : undefined,
      };
      const skills = buildDeps(lc, "s");
      expect(projectSeenBy(deps, skills)).toBe(PROJECT);
      deps.sessionStore.sessionWebContentsMap.delete("s");
      expect(projectSeenBy(deps, skills)).toBeNull();
    });

    it("reads a remote view's help session from its own lane while the pin stands", () => {
      const { deps, lc } = setup();
      const REMOTE_PIN = -7;
      deps.sessionStore.sessionWebContentsMap.set("s", REMOTE_PIN);
      deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
      const sessionProject = vi.fn((helpSessionId: string) =>
        helpSessionId === "help-1" ? PROJECT : null
      );
      lc.setAssistantControl({
        control: {} as never,
        sessionProject,
      });
      const skills = buildDeps(lc, "s");
      expect(projectSeenBy(deps, skills)).toBe(PROJECT);
      expect(sessionProject).toHaveBeenCalledWith("help-1");
      // A moved or closed remote view revokes the session, which drops the pin.
      deps.sessionStore.sessionWebContentsMap.delete("s");
      expect(projectSeenBy(deps, skills)).toBeNull();
    });

    it("gives a remote pin no project while the help service is not wired", () => {
      const { deps, lc } = setup();
      deps.sessionStore.sessionWebContentsMap.set("s", -7);
      deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
      expect(projectSeenBy(deps, buildDeps(lc, "s"))).toBeNull();
    });
  });

  describe("buildSessionServerDeps — assistant confirmations follow the agent (#14141)", () => {
    const readSkipped = (lc: HttpLifecycle, sessionId: string) =>
      (
        lc as unknown as {
          buildSessionServerDeps: (id: string) => SessionServerDeps;
        }
      ).buildSessionServerDeps(sessionId).readAssistantConfirmationsSkipped!();

    const storeWith = (
      helpAssistant: Record<string, unknown>,
      agentSettings: Record<string, unknown>
    ) => {
      vi.mocked(store.get).mockImplementation(((key: string) =>
        key === "helpAssistant"
          ? helpAssistant
          : key === "agentSettings"
            ? agentSettings
            : undefined) as never);
    };

    afterEach(() => {
      vi.mocked(store.get).mockReset();
      vi.mocked(store.get).mockReturnValue({
        enabled: true,
        port: 45454,
        apiKey: "test-api-key",
      } as never);
    });

    it("skips under the default when the session's agent is set to skip", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      deps.sessionStore.sessionHelpIdMap.set("s", "help-1");
      lc.setAssistantControl({
        control: {} as never,
        sessionProject: () => null,
        sessionAgent: (id) => (id === "help-1" ? "claude" : null),
      });
      storeWith(
        { agentId: "codex" },
        { agents: { claude: { dangerousMode: "on" } }, globalSkipPermissions: false }
      );
      expect(readSkipped(lc, "s")).toBe(true);
    });

    it("falls back to the assistant's chosen agent when the session is unknown", () => {
      const lc = new HttpLifecycle(fakeDeps());
      storeWith(
        { agentId: "codex" },
        { agents: { codex: { dangerousMode: "off" } }, globalSkipPermissions: true }
      );
      expect(readSkipped(lc, "s")).toBe(false);
      storeWith(
        { agentId: "codex" },
        { agents: { codex: { dangerousMode: "on" } }, globalSkipPermissions: false }
      );
      expect(readSkipped(lc, "s")).toBe(true);
    });

    it("reads the agent's setting and the preference live on every call", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const read = (
        lc as unknown as { buildSessionServerDeps: (id: string) => SessionServerDeps }
      ).buildSessionServerDeps("s").readAssistantConfirmationsSkipped!;
      storeWith({ agentId: "claude" }, { agents: { claude: { dangerousMode: "on" } } });
      expect(read()).toBe(true);
      storeWith({ agentId: "claude" }, { agents: { claude: { dangerousMode: "off" } } });
      expect(read()).toBe(false);
      storeWith(
        { agentId: "claude", daintreeConfirmations: "never-ask" },
        { agents: { claude: { dangerousMode: "off" } } }
      );
      expect(read()).toBe(true);
    });

    it("still asks under always ask whatever the agent says", () => {
      const lc = new HttpLifecycle(fakeDeps());
      storeWith(
        { agentId: "claude", daintreeConfirmations: "always-ask" },
        { agents: { claude: { dangerousMode: "on" } } }
      );
      expect(readSkipped(lc, "s")).toBe(false);
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
        toolId: "agent.launch",
        sessionId: "session-1",
        tier: "core",
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
        toolId: "agent.launch",
        sessionId: "session-1",
        tier: "core",
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
        toolId: "agent.launch",
        sessionId: "session-1",
        tier: "core",
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
        toolId: "agent.launch",
        sessionId: "session-external",
        tier: "core",
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
        toolId: "agent.launch",
        sessionId: "session-1",
        tier: "core",
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
        toolId: "agent.launch",
        sessionId: "session-rl",
        tier: "core",
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
          toolId: "agent.launch",
          sessionId: "session-gate",
          tier: "core",
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
        toolId: "agent.launch",
        sessionId: "session-ok",
        tier: "core",
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

  // The audit ring is persisted and exportable, and the generic summarizer's
  // redaction is built for secrets, not for an agent's prose or its questions.
  // Driven end to end — through the lifecycle's own summary and into a real
  // audit service's stored and persisted records — because a projection that
  // exists but is not on the path proves nothing (#12479).
  describe("buildSessionServerDeps — last-message reads reach the audit log as shape only", () => {
    it("records status, provider, length and tool names, never the text or a question", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const deps_ = (
        lc as unknown as {
          buildSessionServerDeps: (sessionId: string) => {
            appendAuditRecord: (input: Record<string, unknown>) => void;
          };
        }
      ).buildSessionServerDeps("session-read");
      const prose = "PROSE-SENTINEL ".repeat(200);
      deps_.appendAuditRecord({
        toolId: "terminal.readLastMessageOwned",
        sessionId: "session-read",
        tier: "external",
        args: { terminalId: "term-1" },
        durationMs: 3,
        outcome: {
          kind: "result",
          value: {
            ok: true,
            result: {
              status: "ok",
              provider: "claude",
              message: {
                id: "msg_1",
                text: prose,
                truncated: false,
                recordedAt: 1,
                stopReason: "end_turn",
              },
              unansweredToolUses: [
                {
                  id: "toolu_q",
                  name: "AskUserQuestion",
                  input: { questions: [{ question: "QUESTION-SENTINEL?" }] },
                },
              ],
              newerRecordsFollow: false,
              fileUpdatedAt: 1,
            },
          },
        },
      });

      const call = (deps.auditService.appendRecord as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(JSON.parse(call.resultSummary)).toEqual({
        status: "ok",
        provider: "claude",
        messageChars: prose.length,
        unansweredToolNames: ["AskUserQuestion"],
      });

      let persisted: unknown[] = [];
      const store: McpAuditLogStore = {
        read: () => persisted,
        write: (records: unknown[]) => {
          persisted = records;
        },
      };
      const service = new AuditService(
        () => {},
        () => ({ auditEnabled: true, auditMaxRecords: 500 }),
        store
      );
      service.appendRecord(call);
      service.flushNow();

      for (const written of [service.getRecords(), persisted]) {
        const text = JSON.stringify(written);
        expect(text).toContain("AskUserQuestion");
        expect(text).not.toContain("SENTINEL");
      }
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
      handle.touchBearer(authA, "Help/1", "sess-help", "core");
      handle.touchBearer(authB, "Pane/1", "sess-pane", "full");
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
      handle.touchBearer(authA, "Daintree Assistant/1", "sess-help-1", "core");
      handle.touchBearer(authA, "Daintree Assistant/1", "sess-help-2", "core");
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

    it("listHelpSessionBearers covers every non-external tier, not just the help chat (#10036)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      // In-panel agent (pane) tokens are non-external too — they belong in the
      // Internal connections row alongside the help-chat assistant.
      handle.touchBearer(authA, "Help/1", "sess-help", "core");
      handle.touchBearer(authB, "Pane/1", "sess-pane", "full");
      handle.touchBearer("Bearer external-cccc", "Claude/1", "sess-ext", "external");

      const help = lc.listHelpSessionBearers();
      expect(help).toHaveLength(2);
      expect(help.map((h) => h.userAgent).sort()).toEqual(["Help/1", "Pane/1"]);
    });

    it("pushes a runtime-state change on help-session connect and disconnect (#10036)", () => {
      const deps = fakeDeps();
      const lc = new HttpLifecycle(deps);
      const handle = lc as unknown as BearerTestHandle;
      handle.touchBearer(authA, "Daintree Assistant/1", "sess-help", "core");
      expect(deps.emitRuntimeStateChange).toHaveBeenCalledTimes(1);
      handle.detachBearerSession("sess-help");
      expect(deps.emitRuntimeStateChange).toHaveBeenCalledTimes(2);
      expect(lc.listHelpSessionBearers()).toHaveLength(0);
    });

    it("findHelpBearerHash resolves a help token to its register key, ignoring external bearers (#9151)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      // Raw tokens are the part after "Bearer ".
      handle.touchBearer("Bearer help-token-xyz", "Help/1", "sess-help", "core");
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
      handle.touchBearer("Bearer help-token-xyz", "Help/1", "sess-help", "core");
      handle.detachBearerSession("sess-help");
      expect(lc.findHelpBearerHash("help-token-xyz")).toBeNull();
    });

    it("findHelpBearerHash returns null after clearBearer evicts the entry (server stop/restart, #9151)", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const handle = lc as unknown as BearerTestHandle;
      const auth = "Bearer help-token-xyz";
      handle.touchBearer(auth, "Help/1", "sess-help", "core");
      lc.clearBearer(hashOf(auth));
      expect(lc.findHelpBearerHash("help-token-xyz")).toBeNull();
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

    it("getBearerSessionIds returns a snapshot or null", () => {
      const lc = new HttpLifecycle(fakeDeps());
      (lc as unknown as BearerTestHandle).touchBearer(authA, "Client/1", "sess-1", "external");
      expect(lc.getBearerSessionIds(hashOf(authA))).toEqual(["sess-1"]);
      expect(lc.getBearerSessionIds("nonexistent")).toBeNull();
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
      handle.touchBearer("Bearer help-token-9999", "Help/1", "sess-help", "core");

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

    it.each(["help", "external"] as const)(
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

    it("fails a pinned session's call closed once its binding is torn down mid-flight", async () => {
      const deps = pinnedOriginDeps();
      const revealOwnedRun = vi.fn();
      deps.revealOwnedRun = revealOwnedRun as unknown as HttpLifecycleDeps["revealOwnedRun"];
      const lc = new HttpLifecycle(deps);
      deps.sessionStore.sessionOriginMap.set("sess-teardown", "help");
      deps.sessionStore.sessionWebContentsMap.set("sess-teardown", 7);

      const sessionDeps = (lc as unknown as OriginHandle).buildSessionServerDeps("sess-teardown");

      // `clearSessionBinding` runs on teardown — an idle reap, a revoke, or a
      // take-over retiring the assistant's transports (#13360) — while a call
      // can still be in flight. With the pin gone, falling through to the
      // unpinned route would run the assistant's action in whatever window has
      // focus; a session pinned at build stays pinned, and fails closed.
      deps.sessionStore.clearSessionBinding("sess-teardown");

      await expect(sessionDeps.dispatchAction("agent.launch", {}, false)).rejects.toBeInstanceOf(
        SessionBindingError
      );
      await expect(sessionDeps.requestManifest()).rejects.toBeInstanceOf(SessionBindingError);
      // Nor may a reveal raise whichever window shows the run's workspace.
      await expect(
        sessionDeps.revealOwnedRun?.("ws-a", "terminal.revealOwned", {}, false)
      ).rejects.toBeInstanceOf(SessionBindingError);
      expect(revealOwnedRun).not.toHaveBeenCalled();
      expect(deps.dispatchAction).not.toHaveBeenCalled();
      expect(deps.dispatchActionForWebContents).not.toHaveBeenCalled();
      expect(deps.requestManifest).not.toHaveBeenCalled();
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

  describe("help-session pinning resolvers (#7002, #8317)", () => {
    function pinResolver(lc: HttpLifecycle) {
      return (
        lc as unknown as {
          resolveSessionPin: (
            h: string
          ) => { origin: "help" | "external"; webContentsId: number } | null;
        }
      ).resolveSessionPin.bind(lc);
    }
    function ctxResolver(lc: HttpLifecycle) {
      return (
        lc as unknown as { resolveActionContext: (h: string) => unknown }
      ).resolveActionContext.bind(lc);
    }

    it("pins a help bearer to the renderer that minted it, with the help origin", () => {
      const lc = new HttpLifecycle(fakeDeps());
      lc.setHelpSessionWebContentsResolver((token) => (token === "help-tok" ? 11 : null));

      const resolve = pinResolver(lc);
      expect(resolve("Bearer help-tok")).toEqual({ origin: "help", webContentsId: 11 });
      expect(resolve("Bearer unknown-tok")).toBeNull();
    });

    it("replays the launch-time ActionContext for a help bearer", () => {
      const lc = new HttpLifecycle(fakeDeps());
      const ctx = { projectId: "p1", activeWorktreeId: "wt-3" };
      lc.setHelpSessionActionContextResolver((token) => (token === "help-tok" ? ctx : null));

      const resolve = ctxResolver(lc);
      expect(resolve("Bearer help-tok")).toEqual(ctx);
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

    describe("plugin route", () => {
      function pluginReq(headers: Record<string, string> = {}): http.IncomingMessage {
        return {
          method: "POST",
          url: "/mcp/plugin/acme.ledger/data",
          headers: { host: "127.0.0.1:45454", authorization: "Bearer test-api-key", ...headers },
        } as unknown as http.IncomingMessage;
      }
      const invoke = (lc: HttpLifecycle, req: http.IncomingMessage, res: http.ServerResponse) =>
        (
          lc as unknown as {
            handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
          }
        ).handleRequest(req, res);

      it("hands plugin paths to the plugin handler without consulting orchestration auth", async () => {
        const deps = fakeDeps();
        const lc = new HttpLifecycle(deps);
        lc.setApiKey("test-api-key");
        (lc as unknown as { port: number }).port = 45454;
        const handler = { handle: vi.fn(async () => {}), closeAllSessions: vi.fn() };
        lc.setPluginRouteHandler(handler);
        const req = pluginReq();
        const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as http.ServerResponse;

        await invoke(lc, req, res);

        expect(handler.handle).toHaveBeenCalledWith(req, res, expect.any(URL), 45454);
        expect(res.writeHead).not.toHaveBeenCalled();
        expect(deps.auditService.recordAuth401).not.toHaveBeenCalled();
      });

      it("answers 404 when no plugin handler is mounted, even for a valid orchestration bearer", async () => {
        const deps = fakeDeps();
        const lc = new HttpLifecycle(deps);
        lc.setApiKey("test-api-key");
        (lc as unknown as { port: number }).port = 45454;
        const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as http.ServerResponse;

        await invoke(lc, pluginReq(), res);

        expect(res.writeHead).toHaveBeenCalledWith(404, expect.anything());
      });

      it("still applies the Host check before the plugin handler", async () => {
        const deps = fakeDeps();
        const lc = new HttpLifecycle(deps);
        (lc as unknown as { port: number }).port = 45454;
        const handler = { handle: vi.fn(async () => {}), closeAllSessions: vi.fn() };
        lc.setPluginRouteHandler(handler);
        const res = { writeHead: vi.fn(), end: vi.fn() } as unknown as http.ServerResponse;

        await invoke(lc, pluginReq({ host: "evil.example:45454" }), res);

        expect(res.writeHead).toHaveBeenCalledWith(403, expect.anything());
        expect(handler.handle).not.toHaveBeenCalled();
      });
    });

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

  describe("session credential binding", () => {
    // A bearer above `external` stands in for a pane or assistant token: what
    // matters to the gate is that a session id minted for it is worth more
    // than the api key presenting it.
    const API_KEY_AUTH = "Bearer test-api-key";
    const ELEVATED_AUTH = "Bearer elevated-tok";

    type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

    function lifecycle(deps: HttpLifecycleDeps): { lc: HttpLifecycle; handle: RequestHandler } {
      const lc = new HttpLifecycle(deps);
      lc.setApiKey("test-api-key");
      lc.setHelpTokenValidator((token) => (token === "elevated-tok" ? "full" : false));
      (lc as unknown as { port: number }).port = 45454;
      const handle = (lc as unknown as { handleRequest: RequestHandler }).handleRequest.bind(lc);
      return { lc, handle };
    }

    function request(
      method: string,
      url: string,
      headers: Record<string, string>
    ): http.IncomingMessage {
      return {
        method,
        url,
        headers: { host: "127.0.0.1:45454", ...headers },
      } as unknown as http.IncomingMessage;
    }

    function recordingRes() {
      const res = new EventEmitter() as EventEmitter & {
        writeHead: ReturnType<typeof vi.fn>;
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
        headersSent: boolean;
      };
      res.writeHead = vi.fn();
      res.write = vi.fn(() => true);
      res.end = vi.fn();
      res.headersSent = false;
      return res;
    }

    /** What the client saw: every status/header write and body, in order. */
    function observed(res: ReturnType<typeof recordingRes>) {
      return { head: res.writeHead.mock.calls, body: res.end.mock.calls };
    }

    /**
     * Open a real SSE session through `handleRequest`, so the binding under
     * test is the one the production handshake writes, not one the fixture
     * planted.
     */
    async function openSseSession(deps: HttpLifecycleDeps, handle: RequestHandler, auth: string) {
      const streamRes = recordingRes();
      await handle(
        request("GET", "/sse", { authorization: auth }),
        streamRes as unknown as http.ServerResponse
      );
      const [sessionId] = Array.from(deps.sessionStore.sessions.keys());
      const session = deps.sessionStore.sessions.get(sessionId!)!;
      const handlePostMessage = vi
        .spyOn(session.transport, "handlePostMessage")
        .mockImplementation(async (_req, res) => {
          res.writeHead(202);
          res.end("Accepted");
        });
      return { sessionId: sessionId!, streamRes, handlePostMessage };
    }

    function liveHttpSession(deps: HttpLifecycleDeps, sessionId: string, auth: string | null) {
      const handleRequest = vi.fn().mockResolvedValue(undefined);
      (deps.sessionStore.httpSessions as Map<string, unknown>).set(sessionId, {
        transport: { handleRequest },
        idleTimer: setTimeout(() => {}, 1_000_000),
      } as never);
      deps.sessionStore.sessionTierMap.set(sessionId, "full");
      if (auth !== null) {
        deps.sessionStore.bindSessionCredential(sessionId, sessionCredentialDigest(auth));
      }
      return handleRequest;
    }

    describe("SSE heartbeat (#12994)", () => {
      const KEEPALIVE = ": keepalive\n\n";

      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      function keepalives(res: ReturnType<typeof recordingRes>): number {
        return res.write.mock.calls.filter(([chunk]) => chunk === KEEPALIVE).length;
      }

      it("writes a comment line on the idle stream at every interval", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { streamRes } = await openSseSession(deps, handle, ELEVATED_AUTH);

        expect(streamRes.write.mock.calls[0]?.[0]).toMatch(/^event: endpoint\n/);
        expect(keepalives(streamRes)).toBe(0);

        vi.advanceTimersByTime(MCP_SSE_HEARTBEAT_INTERVAL_MS);
        expect(keepalives(streamRes)).toBe(1);

        vi.advanceTimersByTime(MCP_SSE_HEARTBEAT_INTERVAL_MS * 20);
        expect(keepalives(streamRes)).toBe(21);
      });

      it("keeps the session alive past undici's 300 s body timeout without touching its idle timer", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const resetIdleTimer = vi.spyOn(deps.sessionStore, "resetIdleTimer");
        const UNDICI_BODY_TIMEOUT_MS = 300_000;
        const { sessionId, streamRes } = await openSseSession(deps, handle, ELEVATED_AUTH);
        const { idleTimer } = deps.sessionStore.sessions.get(sessionId)!;
        const byteTimes = [Date.now()];
        streamRes.write.mockImplementation(() => {
          byteTimes.push(Date.now());
          return true;
        });

        vi.advanceTimersByTime(3 * UNDICI_BODY_TIMEOUT_MS);

        const gaps = byteTimes.slice(1).map((t, i) => t - byteTimes[i]!);
        expect(gaps.length).toBeGreaterThan(0);
        expect(Math.max(...gaps)).toBeLessThan(UNDICI_BODY_TIMEOUT_MS);
        expect(Date.now() - byteTimes.at(-1)!).toBeLessThan(UNDICI_BODY_TIMEOUT_MS);
        expect(resetIdleTimer).not.toHaveBeenCalled();
        expect(deps.sessionStore.sessions.get(sessionId)?.idleTimer).toBe(idleTimer);
      });

      it("stops when the client drops the stream", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { sessionId, streamRes } = await openSseSession(deps, handle, ELEVATED_AUTH);

        streamRes.emit("close");
        expect(deps.sessionStore.sessions.has(sessionId)).toBe(false);

        vi.advanceTimersByTime(MCP_SSE_HEARTBEAT_INTERVAL_MS * 4);
        expect(keepalives(streamRes)).toBe(0);
      });

      it("stops when the server closes the transport", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { sessionId, streamRes } = await openSseSession(deps, handle, ELEVATED_AUTH);

        await deps.sessionStore.sessions.get(sessionId)!.transport.close();

        vi.advanceTimersByTime(MCP_SSE_HEARTBEAT_INTERVAL_MS * 4);
        expect(keepalives(streamRes)).toBe(0);
      });

      it("stops quietly when a write throws", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { streamRes } = await openSseSession(deps, handle, ELEVATED_AUTH);
        streamRes.write.mockImplementation(() => {
          throw new Error("write after end");
        });

        expect(() => vi.advanceTimersByTime(MCP_SSE_HEARTBEAT_INTERVAL_MS)).not.toThrow();
        const attempts = streamRes.write.mock.calls.length;

        vi.advanceTimersByTime(MCP_SSE_HEARTBEAT_INTERVAL_MS * 4);
        expect(streamRes.write.mock.calls.length).toBe(attempts);
      });

      it("never writes to a response that has already ended", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { streamRes } = await openSseSession(deps, handle, ELEVATED_AUTH);

        (streamRes as unknown as { writableEnded: boolean }).writableEnded = true;

        vi.advanceTimersByTime(MCP_SSE_HEARTBEAT_INTERVAL_MS * 4);
        expect(keepalives(streamRes)).toBe(0);
      });
    });

    describe("SSE /messages", () => {
      it("binds the session to its creator at handshake", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);

        const { sessionId } = await openSseSession(deps, handle, ELEVATED_AUTH);

        expect(
          deps.sessionStore.isSessionCredential(sessionId, sessionCredentialDigest(ELEVATED_AUTH))
        ).toBe(true);
        expect(
          deps.sessionStore.isSessionCredential(sessionId, sessionCredentialDigest(API_KEY_AUTH))
        ).toBe(false);
      });

      it("refuses an api-key bearer posting into an elevated session and leaves it untouched", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { sessionId, handlePostMessage } = await openSseSession(deps, handle, ELEVATED_AUTH);
        const res = recordingRes();

        await handle(
          request("POST", `/messages?sessionId=${sessionId}`, { authorization: API_KEY_AUTH }),
          res as unknown as http.ServerResponse
        );

        expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "text/plain" });
        expect(res.end).toHaveBeenCalledWith("Session not found");
        expect(handlePostMessage).not.toHaveBeenCalled();
        expect(deps.sessionStore.resetIdleTimer).not.toHaveBeenCalled();
        expect(deps.sessionStore.sessions.has(sessionId)).toBe(true);
        expect(deps.sessionStore.sessionTierMap.get(sessionId)).toBe("full");
        expect(
          deps.sessionStore.isSessionCredential(sessionId, sessionCredentialDigest(ELEVATED_AUTH))
        ).toBe(true);
      });

      it("answers a foreign bearer exactly as it answers an unknown session id", async () => {
        // No oracle: a caller holding a leaked id must not be able to tell
        // "live but not yours" from "does not exist".
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { sessionId } = await openSseSession(deps, handle, ELEVATED_AUTH);
        const foreign = recordingRes();
        const unknown = recordingRes();

        await handle(
          request("POST", `/messages?sessionId=${sessionId}`, { authorization: API_KEY_AUTH }),
          foreign as unknown as http.ServerResponse
        );
        await handle(
          request("POST", "/messages?sessionId=never-issued", { authorization: API_KEY_AUTH }),
          unknown as unknown as http.ServerResponse
        );

        expect(observed(foreign)).toEqual(observed(unknown));
      });

      it("admits the creator when it varies the scheme casing and whitespace", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { sessionId, handlePostMessage } = await openSseSession(deps, handle, ELEVATED_AUTH);
        const res = recordingRes();

        await handle(
          request("POST", `/messages?sessionId=${sessionId}`, {
            authorization: "bearer \t elevated-tok  ",
          }),
          res as unknown as http.ServerResponse
        );

        expect(handlePostMessage).toHaveBeenCalledOnce();
        expect(res.writeHead).toHaveBeenCalledWith(202);
      });

      it("refuses a live session whose binding row is missing, even for its creator", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { sessionId, handlePostMessage } = await openSseSession(deps, handle, ELEVATED_AUTH);
        deps.sessionStore.sessionCredentialMap.delete(sessionId);
        const res = recordingRes();

        await handle(
          request("POST", `/messages?sessionId=${sessionId}`, { authorization: ELEVATED_AUTH }),
          res as unknown as http.ServerResponse
        );

        expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "text/plain" });
        expect(handlePostMessage).not.toHaveBeenCalled();
      });

      it("drops the binding when the stream closes", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const { sessionId, streamRes } = await openSseSession(deps, handle, ELEVATED_AUTH);

        streamRes.emit("close");

        expect(deps.sessionStore.sessions.has(sessionId)).toBe(false);
        expect(deps.sessionStore.sessionCredentialMap.has(sessionId)).toBe(false);
      });

      it("drops the binding when the session server fails to connect", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const streamRes = recordingRes();
        // `SSEServerTransport.start` opens the stream with `writeHead`; failing
        // it fails `server.connect` after the handshake has already bound.
        streamRes.writeHead.mockImplementationOnce(() => {
          throw new Error("socket gone");
        });

        await expect(
          handle(
            request("GET", "/sse", { authorization: ELEVATED_AUTH }),
            streamRes as unknown as http.ServerResponse
          )
        ).rejects.toThrow("socket gone");

        expect(deps.sessionStore.sessions.size).toBe(0);
        expect(deps.sessionStore.sessionCredentialMap.size).toBe(0);
      });
    });

    describe("Streamable /mcp", () => {
      it.each(["POST", "GET", "DELETE"])(
        "refuses an api-key bearer's %s on an elevated session with the unknown-session 404",
        async (method) => {
          const deps = fakeDeps();
          const { handle } = lifecycle(deps);
          const handleRequest = liveHttpSession(deps, "elevated", ELEVATED_AUTH);
          const foreign = recordingRes();
          const unknown = recordingRes();

          await handle(
            request(method, "/mcp", { authorization: API_KEY_AUTH, "mcp-session-id": "elevated" }),
            foreign as unknown as http.ServerResponse
          );
          await handle(
            request(method, "/mcp", {
              authorization: API_KEY_AUTH,
              "mcp-session-id": "never-issued",
            }),
            unknown as unknown as http.ServerResponse
          );

          expect(foreign.writeHead).toHaveBeenCalledWith(404, {
            "Content-Type": "application/json",
          });
          expect(observed(foreign)).toEqual(observed(unknown));
          expect(handleRequest).not.toHaveBeenCalled();
          expect(deps.sessionStore.resetHttpIdleTimer).not.toHaveBeenCalled();
          expect(deps.sessionStore.httpSessions.has("elevated")).toBe(true);
          expect(deps.sessionStore.sessionTierMap.get("elevated")).toBe("full");
        }
      );

      it("checks ownership before the workspace selector, so a mismatch cannot probe liveness", async () => {
        // The selector checks answer 400 for a live session and would
        // otherwise distinguish it from an unknown id.
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const handleRequest = liveHttpSession(deps, "bound", API_KEY_AUTH);
        deps.sessionStore.sessionWorkspaceMap.set("bound", WS_A);
        const res = recordingRes();

        await handle(
          request("POST", "/mcp", {
            authorization: ELEVATED_AUTH,
            "mcp-session-id": "bound",
            "daintree-workspace-id": WS_B,
          }),
          res as unknown as http.ServerResponse
        );

        expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json" });
        expect(handleRequest).not.toHaveBeenCalled();
      });

      it("admits the creator when it varies the scheme casing and whitespace", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const handleRequest = liveHttpSession(deps, "elevated", ELEVATED_AUTH);
        const res = recordingRes();

        await handle(
          request("POST", "/mcp", {
            authorization: "BEARER   elevated-tok\t",
            "mcp-session-id": "elevated",
          }),
          res as unknown as http.ServerResponse
        );

        expect(handleRequest).toHaveBeenCalledOnce();
        expect(res.writeHead).not.toHaveBeenCalled();
      });

      it("refuses a live session whose binding row is missing, even for its creator", async () => {
        const deps = fakeDeps();
        const { handle } = lifecycle(deps);
        const handleRequest = liveHttpSession(deps, "unbound", null);
        const res = recordingRes();

        await handle(
          request("DELETE", "/mcp", { authorization: ELEVATED_AUTH, "mcp-session-id": "unbound" }),
          res as unknown as http.ServerResponse
        );

        expect(res.writeHead).toHaveBeenCalledWith(404, { "Content-Type": "application/json" });
        expect(handleRequest).not.toHaveBeenCalled();
      });
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
        expect(code).not.toBe(-32001);
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

        expect(deps.requestManifestForWorkspace).toHaveBeenCalledWith(WS_MISSING, undefined);
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
        // These requests carry no Authorization header, so the session is
        // owned by the empty credential — the loopback no-key path.
        deps.sessionStore.bindSessionCredential(sessionId, sessionCredentialDigest(""));
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

        // No launch view to prefer: only an agent pane's binding carries one.
        expect(deps.requestManifestForWorkspace).toHaveBeenCalledWith(WS_A, undefined);
        // Only external sessions may bind a workspace — a selector from a
        // pinned bearer is refused at handshake — so the origin threaded here
        // is always "external" (#11808).
        // Nothing beyond the route: no replayed context, preferred view, or
        // caller identity — those are an agent pane's (#12486).
        expect(deps.dispatchActionForWorkspace).toHaveBeenCalledWith(
          WS_A,
          "terminal.list",
          {},
          false,
          "external",
          undefined
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
        expect(deps.getCachedManifestForWorkspace).toHaveBeenCalledWith(WS_A, undefined);
        expect(deps.getCachedManifest).not.toHaveBeenCalled();
      });
    });

    describe("agent-pane launch binding (#12486)", () => {
      const PANE_TOKEN = "pane-token-9f3a";
      const PANE_AUTH = `Bearer ${PANE_TOKEN}`;
      const LAUNCH_CONTEXT = { projectId: WS_A, activeWorktreeId: "wt-7" };

      /**
       * A lifecycle that authenticates PANE_TOKEN at a ladder tier, as the
       * composite validator does for every pane bearer, and binds it to WS_A.
       */
      function paneLifecycle(
        deps: HttpLifecycleDeps,
        binding: import("../shared.js").PaneWorkspaceBinding | null = {
          workspaceId: WS_A,
          launchWebContentsId: 42,
          actionContext: LAUNCH_CONTEXT,
        }
      ) {
        const lc = new HttpLifecycle(deps);
        lc.setApiKey("test-api-key");
        lc.setHelpTokenValidator((token) => (token === PANE_TOKEN ? "core" : false));
        const paneResolver = vi.fn((token: string) => (token === PANE_TOKEN ? binding : null));
        lc.setPaneWorkspaceBindingResolver(paneResolver);
        (lc as unknown as { port: number }).port = 45454;
        return { lc, paneResolver };
      }

      /** Open a real SSE session — the transport Claude panes connect over. */
      async function openSse(lc: HttpLifecycle, deps: HttpLifecycleDeps, auth: string) {
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        res.writeHead = vi.fn();
        res.write = vi.fn(() => true);
        res.end = vi.fn();
        res.headersSent = false;
        await (
          lc as unknown as {
            handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
          }
        ).handleRequest(
          {
            method: "GET",
            url: "/sse",
            headers: { host: "127.0.0.1:45454", authorization: auth },
          } as unknown as http.IncomingMessage,
          res as unknown as http.ServerResponse
        );
        const [sessionId] = Array.from(deps.sessionStore.sessions.keys());
        return sessionId!;
      }

      /**
       * The session deps the production handshake itself built, not a rebuilt
       * copy: a handshake that stopped passing the pane binding through would
       * leave a rebuilt copy routing correctly while the real session followed
       * focus.
       */
      async function openSseWithDeps(lc: HttpLifecycle, deps: HttpLifecycleDeps, auth: string) {
        const build = vi.spyOn(
          lc as unknown as {
            buildSessionServerDeps: (
              ...a: unknown[]
            ) => import("../sessionServer.js").SessionServerDeps;
          },
          "buildSessionServerDeps"
        );
        const sessionId = await openSse(lc, deps, auth);
        const sessionDeps = build.mock.results[0]!
          .value as import("../sessionServer.js").SessionServerDeps;
        build.mockRestore();
        return { sessionId, sessionDeps };
      }

      it("binds a pane's /sse session to its launch workspace, as a non-renderer-owned origin", async () => {
        const deps = bindingDeps();
        const { lc } = paneLifecycle(deps);

        const sessionId = await openSse(lc, deps, PANE_AUTH);

        expect(deps.sessionStore.sessionWorkspaceMap.get(sessionId)).toBe(WS_A);
        expect(deps.sessionStore.sessionContextMap.get(sessionId)).toEqual(LAUNCH_CONTEXT);
        // Routing only. The session is still an external-origin bearer at the
        // tier it was minted with, so nothing it may call has changed (#12407).
        expect(deps.sessionStore.getOrigin(sessionId)).toBe("external");
        expect(deps.sessionStore.isRendererOwnedOrigin(sessionId)).toBe(false);
        expect(deps.sessionStore.sessionTierMap.get(sessionId)).toBe("core");
        // Not a WebContents pin: that route dies with the view for good.
        expect(deps.sessionStore.sessionWebContentsMap.has(sessionId)).toBe(false);
      });

      it("routes the pane's calls to its workspace with its launch context and view, never focus", async () => {
        const deps = bindingDeps({
          requestManifestForWorkspace: vi.fn().mockResolvedValue([]),
          dispatchActionForWorkspace: vi.fn().mockResolvedValue({ result: { ok: true } }),
          getCachedManifestForWorkspace: vi.fn(() => []),
        });
        const { lc } = paneLifecycle(deps);
        const { sessionDeps } = await openSseWithDeps(lc, deps, PANE_AUTH);

        await sessionDeps.requestManifest();
        await sessionDeps.dispatchAction("worktree.getCurrent", {}, false);
        sessionDeps.getCachedManifest();

        expect(deps.requestManifestForWorkspace).toHaveBeenCalledWith(WS_A, 42);
        expect(deps.dispatchActionForWorkspace).toHaveBeenCalledWith(
          WS_A,
          "worktree.getCurrent",
          {},
          false,
          "external",
          {
            contextOverride: LAUNCH_CONTEXT,
            preferredWebContentsId: 42,
            offerSessionApproval: true,
          }
        );
        expect(deps.getCachedManifestForWorkspace).toHaveBeenCalledWith(WS_A, 42);
        expect(deps.dispatchAction).not.toHaveBeenCalled();
        expect(deps.requestManifest).not.toHaveBeenCalled();
        expect(deps.getCachedManifest).not.toHaveBeenCalled();
        // The binding the client can read back names the pane's workspace.
        expect(sessionDeps.workspaceBinding?.workspaceId).toBe(WS_A);
        expect(sessionDeps.preferredWebContentsId).toBe(42);
      });

      it("keeps the launch context on a call that outlives its session's teardown", async () => {
        // A call awaiting its manifest can resume after the transport closed and
        // `clearSessionBinding` ran. It must still act on the pane's worktree,
        // not drop the context and act on the view's current selection.
        const deps = bindingDeps({
          dispatchActionForWorkspace: vi.fn().mockResolvedValue({ result: { ok: true } }),
        });
        const { lc } = paneLifecycle(deps);
        const { sessionId, sessionDeps } = await openSseWithDeps(lc, deps, PANE_AUTH);

        deps.sessionStore.clearSessionBinding(sessionId);
        await sessionDeps.dispatchAction("worktree.resource.provision", {}, false);

        expect(deps.dispatchActionForWorkspace).toHaveBeenCalledWith(
          WS_A,
          "worktree.resource.provision",
          {},
          false,
          "external",
          {
            contextOverride: LAUNCH_CONTEXT,
            preferredWebContentsId: 42,
            offerSessionApproval: true,
          }
        );
      });

      it("passes the launch view to a reveal, so it switches the window the pane's runs are in", async () => {
        const revealOwnedRun = vi.fn().mockResolvedValue({
          envelope: { result: { ok: true, result: null } },
          raised: true,
        });
        const deps = bindingDeps({ revealOwnedRun });
        const { lc } = paneLifecycle(deps);
        const { sessionDeps } = await openSseWithDeps(lc, deps, PANE_AUTH);

        await sessionDeps.revealOwnedRun!(WS_A, "pilot.openRun", { runId: "t1" }, false);

        expect(revealOwnedRun).toHaveBeenCalledWith(
          WS_A,
          "pilot.openRun",
          { runId: "t1" },
          false,
          "external",
          42
        );
      });

      // #12692: a pane's tier is where auto-approval stops, not a ceiling. The
      // ask for an above-tier call rides the pane's own route — same workspace,
      // same launch context and view — flagged so the renderer only asks.
      it("hands a pane an approval route that asks in its own view without dispatching", async () => {
        const deps = bindingDeps({
          dispatchActionForWorkspace: vi.fn().mockResolvedValue({
            result: { ok: true, result: null },
            confirmationDecision: "approved",
          }),
        });
        const { lc } = paneLifecycle(deps);
        const { sessionDeps } = await openSseWithDeps(lc, deps, PANE_AUTH);

        expect(sessionDeps.requestApproval).toBeTypeOf("function");
        await sessionDeps.requestApproval!("project.runCheck", { runnerId: "test" });

        expect(deps.dispatchActionForWorkspace).toHaveBeenCalledWith(
          WS_A,
          "project.runCheck",
          { runnerId: "test" },
          false,
          "external",
          {
            contextOverride: LAUNCH_CONTEXT,
            preferredWebContentsId: 42,
            offerSessionApproval: true,
            approvalOnly: true,
          }
        );
      });

      it("gives a bound external session no approval route, so its tier stays a ceiling", async () => {
        const deps = bindingDeps();
        const lc = new HttpLifecycle(deps);

        expect(sessionDepsFor(lc, "bound", { workspaceId: WS_A }).requestApproval).toBeUndefined();
        expect(sessionDepsFor(lc, "unbound").requestApproval).toBeUndefined();
      });

      it("binds identity-only when the launch workspace has no live view at handshake", async () => {
        // An evicted launch view is a route that comes back, not a reason to
        // refuse the pane — or to let it follow focus meanwhile.
        const deps = bindingDeps();
        const { lc } = paneLifecycle(deps, { workspaceId: WS_MISSING });

        const sessionId = await openSse(lc, deps, PANE_AUTH);

        expect(deps.sessionStore.sessionWorkspaceMap.get(sessionId)).toBe(WS_MISSING);
        expect(deps.sessionStore.sessionContextMap.has(sessionId)).toBe(false);
      });

      it("binds the /mcp handshake the same way", async () => {
        const deps = bindingDeps();
        const { lc } = paneLifecycle(deps);
        // The SDK rejects the stub request and the sweep reclaims the session,
        // so observe the production writes as they happen.
        const writes: Record<string, unknown[]> = { workspace: [], origin: [], context: [] };
        const watch = <V>(map: Map<string, V>, key: string) => {
          const realSet = map.set.bind(map);
          map.set = (id: string, value: V) => {
            writes[key]!.push(value);
            return realSet(id, value);
          };
        };
        watch(deps.sessionStore.sessionWorkspaceMap, "workspace");
        watch(deps.sessionStore.sessionOriginMap, "origin");
        watch(deps.sessionStore.sessionContextMap, "context");

        await handshakeHandler(lc)(
          fakeReq({ authorization: PANE_AUTH }),
          fakeRes(),
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(writes).toEqual({
          workspace: [WS_A],
          origin: ["external"],
          context: [LAUNCH_CONTEXT],
        });
      });

      it("refuses a workspace selector from a pane — its target is not the client's to choose", async () => {
        const deps = bindingDeps();
        const { lc, paneResolver } = paneLifecycle(deps);
        const res = fakeRes();

        await handshakeHandler(lc)(
          fakeReq({ authorization: PANE_AUTH, "daintree-workspace-id": WS_B }),
          res,
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(parseRejection(res).error.data.code).toBe("WORKSPACE_SELECTOR_NOT_ALLOWED");
        expect(paneResolver).not.toHaveBeenCalled();
        expect(deps.sessionStore.sessionWorkspaceMap.size).toBe(0);
      });

      it("never consults the pane binding for a bearer the help resolver pins", async () => {
        // Pin precedence keeps the two binding models disjoint: a help bearer
        // routes by its WebContents, with its own renderer-owned origin.
        const deps = bindingDeps();
        const { lc, paneResolver } = paneLifecycle(deps);
        lc.setHelpSessionWebContentsResolver((token) => (token === PANE_TOKEN ? 77 : null));

        const sessionId = await openSse(lc, deps, PANE_AUTH);

        expect(paneResolver).not.toHaveBeenCalled();
        expect(deps.sessionStore.getOrigin(sessionId)).toBe("help");
        expect(deps.sessionStore.sessionWebContentsMap.get(sessionId)).toBe(77);
        expect(deps.sessionStore.sessionWorkspaceMap.has(sessionId)).toBe(false);
      });

      it("leaves an api-key session with no selector following focus", async () => {
        const deps = bindingDeps();
        const { lc } = paneLifecycle(deps);

        const sessionId = await openSse(lc, deps, "Bearer test-api-key");

        expect(deps.sessionStore.sessionWorkspaceMap.has(sessionId)).toBe(false);
        expect(deps.sessionStore.sessionContextMap.has(sessionId)).toBe(false);
        expect(deps.sessionStore.getOrigin(sessionId)).toBe("external");
      });
    });

    describe("pane-bearer ownership principal (#12487)", () => {
      const PANE_TOKEN = "pane-token-5c1e";
      const PANE_AUTH = `Bearer ${PANE_TOKEN}`;

      function principalLifecycle(
        deps: HttpLifecycleDeps,
        principal: string | null = "principal-p"
      ) {
        const lc = new HttpLifecycle(deps);
        lc.setApiKey("test-api-key");
        lc.setHelpTokenValidator((token) => (token === PANE_TOKEN ? "core" : false));
        const resolver = vi.fn((token: string) => (token === PANE_TOKEN ? principal : null));
        lc.setPaneOwnershipPrincipalResolver(resolver);
        (lc as unknown as { port: number }).port = 45454;
        return { lc, resolver };
      }

      async function openSse(lc: HttpLifecycle, deps: HttpLifecycleDeps, auth: string) {
        const before = new Set(deps.sessionStore.sessions.keys());
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        res.writeHead = vi.fn();
        res.write = vi.fn(() => true);
        res.end = vi.fn();
        res.headersSent = false;
        await (
          lc as unknown as {
            handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
          }
        ).handleRequest(
          {
            method: "GET",
            url: "/sse",
            headers: { host: "127.0.0.1:45454", authorization: auth },
          } as unknown as http.IncomingMessage,
          res as unknown as http.ServerResponse
        );
        const sessionId = Array.from(deps.sessionStore.sessions.keys()).find(
          (id) => !before.has(id)
        );
        return sessionId!;
      }

      it("binds a pane's /sse session to the principal its bearer resolves to", async () => {
        const deps = bindingDeps();
        const { lc, resolver } = principalLifecycle(deps);

        const sessionId = await openSse(lc, deps, PANE_AUTH);

        const ledger = deps.sessionStore.resourceOwnership;
        expect(resolver).toHaveBeenCalledWith(PANE_TOKEN);
        expect(ledger.isPrincipalOwner(ledger.ownerOf(sessionId))).toBe(true);
      });

      it("gives a session that replaces a torn-down one on the same bearer its records", async () => {
        const deps = bindingDeps();
        const { lc } = principalLifecycle(deps);
        const ledger = deps.sessionStore.resourceOwnership;
        const first = await openSse(lc, deps, PANE_AUTH);
        ledger.record(ledger.ownerOf(first), [{ kind: "terminal", id: "terminal-1" }]);

        deps.sessionStore.sessions.get(first)!.transport.onclose?.();
        const second = await openSse(lc, deps, PANE_AUTH);

        expect(second).not.toBe(first);
        expect(ledger.ownerOf(first)).toBe(first);
        expect(ledger.owns(ledger.ownerOf(second), "terminal", "terminal-1")).toBe(true);
      });

      it("binds the /mcp handshake to the principal the same way", async () => {
        const deps = bindingDeps();
        const { lc } = principalLifecycle(deps);
        // The SDK rejects the stub request and the sweep reclaims the session,
        // so observe the production write as it happens.
        const bind = vi.spyOn(deps.sessionStore.resourceOwnership, "bindPrincipal");

        await handshakeHandler(lc)(
          fakeReq({ authorization: PANE_AUTH }),
          fakeRes(),
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(bind).toHaveBeenCalledExactlyOnceWith(expect.any(String), "principal-p");
      });

      it("leaves an api-key session owning its records itself", async () => {
        const deps = bindingDeps();
        const { lc, resolver } = principalLifecycle(deps);

        const sessionId = await openSse(lc, deps, "Bearer test-api-key");

        expect(resolver).toHaveBeenCalledWith("test-api-key");
        expect(deps.sessionStore.resourceOwnership.ownerOf(sessionId)).toBe(sessionId);
      });

      it("writes no session state when the principal resolver throws", async () => {
        // Resolved ahead of every map write, like the workspace binding, so a
        // failing lookup leaves nothing for the reaper to miss.
        const deps = bindingDeps();
        const { lc } = principalLifecycle(deps);
        lc.setPaneOwnershipPrincipalResolver(() => {
          throw new Error("resolver failed");
        });

        await expect(openSse(lc, deps, PANE_AUTH)).rejects.toThrow("resolver failed");

        expect(deps.sessionStore.sessions.size).toBe(0);
        expect(deps.sessionStore.sessionTierMap.size).toBe(0);
        expect(deps.sessionStore.sessionOriginMap.size).toBe(0);
        expect(deps.sessionStore.sessionCredentialMap.size).toBe(0);
      });

      it("keeps a bearer that resolves to no principal session-scoped", async () => {
        // A pane token revoked between the auth gate and the handshake resolves
        // to nothing, and the session falls back to the api-key behaviour.
        const deps = bindingDeps();
        const { lc } = principalLifecycle(deps, null);

        const sessionId = await openSse(lc, deps, PANE_AUTH);

        expect(deps.sessionStore.resourceOwnership.ownerOf(sessionId)).toBe(sessionId);
      });
    });

    describe("help-bearer ownership principal (#12993)", () => {
      const HELP_TOKEN = "help-token-9a2f";
      const HELP_AUTH = `Bearer ${HELP_TOKEN}`;
      const OTHER_HELP_TOKEN = "help-token-7b31";

      function helpLifecycle(deps: HttpLifecycleDeps) {
        const lc = new HttpLifecycle(deps);
        lc.setApiKey("test-api-key");
        lc.setHelpTokenValidator((token) =>
          token === HELP_TOKEN || token === OTHER_HELP_TOKEN ? "core" : false
        );
        const helpSessions = new Map<string, string>([
          [HELP_TOKEN, "help-session-1"],
          [OTHER_HELP_TOKEN, "help-session-2"],
        ]);
        lc.setHelpSessionIdResolver((token) => helpSessions.get(token) ?? null);
        (lc as unknown as { port: number }).port = 45454;
        return { lc, helpSessions };
      }

      async function openSse(lc: HttpLifecycle, deps: HttpLifecycleDeps, auth: string) {
        const before = new Set(deps.sessionStore.sessions.keys());
        const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
        res.writeHead = vi.fn();
        res.write = vi.fn(() => true);
        res.end = vi.fn();
        res.headersSent = false;
        await (
          lc as unknown as {
            handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
          }
        ).handleRequest(
          {
            method: "GET",
            url: "/sse",
            headers: { host: "127.0.0.1:45454", authorization: auth },
          } as unknown as http.IncomingMessage,
          res as unknown as http.ServerResponse
        );
        const sessionId = Array.from(deps.sessionStore.sessions.keys()).find(
          (id) => !before.has(id)
        );
        if (sessionId === undefined) throw new Error("the /sse handshake opened no session");
        return sessionId;
      }

      it("keeps a help session's records across a transport reconnect", async () => {
        const deps = bindingDeps();
        const { lc } = helpLifecycle(deps);
        const ledger = deps.sessionStore.resourceOwnership;
        const first = await openSse(lc, deps, HELP_AUTH);
        expect(ledger.isPrincipalOwner(ledger.ownerOf(first))).toBe(true);
        ledger.record(ledger.ownerOf(first), [{ kind: "worktree", id: "/repo/wt-1" }]);

        deps.sessionStore.sessions.get(first)!.transport.onclose?.();
        const second = await openSse(lc, deps, HELP_AUTH);

        expect(second).not.toBe(first);
        expect(ledger.owns(ledger.ownerOf(second), "worktree", "/repo/wt-1")).toBe(true);
      });

      it("keeps them across a server drain, and drops them when the principal is revoked", async () => {
        const deps = bindingDeps();
        const { lc } = helpLifecycle(deps);
        const ledger = deps.sessionStore.resourceOwnership;
        const first = await openSse(lc, deps, HELP_AUTH);
        ledger.record(ledger.ownerOf(first), [{ kind: "worktree", id: "/repo/wt-1" }]);

        ledger.clearAllSessions();
        const second = await openSse(lc, deps, HELP_AUTH);
        expect(ledger.owns(ledger.ownerOf(second), "worktree", "/repo/wt-1")).toBe(true);

        ledger.revokePrincipal(helpOwnershipPrincipal("help-session-1"));
        expect(ledger.owns(ledger.ownerOf(second), "worktree", "/repo/wt-1")).toBe(false);
      });

      it("gives a different help session none of another's records", async () => {
        const deps = bindingDeps();
        const { lc } = helpLifecycle(deps);
        const ledger = deps.sessionStore.resourceOwnership;
        const mine = await openSse(lc, deps, HELP_AUTH);
        ledger.record(ledger.ownerOf(mine), [{ kind: "worktree", id: "/repo/wt-1" }]);

        const theirs = await openSse(lc, deps, `Bearer ${OTHER_HELP_TOKEN}`);

        expect(ledger.ownerOf(theirs)).not.toBe(ledger.ownerOf(mine));
        expect(ledger.owns(ledger.ownerOf(theirs), "worktree", "/repo/wt-1")).toBe(false);
      });

      it("binds the /mcp handshake to the help principal the same way", async () => {
        const deps = bindingDeps();
        const { lc } = helpLifecycle(deps);
        const bind = vi.spyOn(deps.sessionStore.resourceOwnership, "bindPrincipal");

        await handshakeHandler(lc)(
          fakeReq({ authorization: HELP_AUTH }),
          fakeRes(),
          new URL("http://127.0.0.1:45454/mcp")
        );

        expect(bind).toHaveBeenCalledExactlyOnceWith(
          expect.any(String),
          helpOwnershipPrincipal("help-session-1")
        );
      });

      it("prefers a pane principal when the bearer is a pane token", async () => {
        const deps = bindingDeps();
        const { lc } = helpLifecycle(deps);
        lc.setPaneOwnershipPrincipalResolver((token) => (token === HELP_TOKEN ? "pane-p" : null));
        const bind = vi.spyOn(deps.sessionStore.resourceOwnership, "bindPrincipal");

        await openSse(lc, deps, HELP_AUTH);

        expect(bind).toHaveBeenCalledExactlyOnceWith(expect.any(String), "pane-p");
      });

      it("keeps a revoked help bearer and an api-key session session-scoped", async () => {
        const deps = bindingDeps();
        const { lc, helpSessions } = helpLifecycle(deps);
        const ledger = deps.sessionStore.resourceOwnership;

        const apiKeySession = await openSse(lc, deps, "Bearer test-api-key");
        expect(ledger.ownerOf(apiKeySession)).toBe(apiKeySession);

        // Revoked between the auth gate and the handshake: the resolver no
        // longer knows the token, so nothing binds.
        helpSessions.delete(HELP_TOKEN);
        const revoked = await openSse(lc, deps, HELP_AUTH);
        expect(ledger.ownerOf(revoked)).toBe(revoked);
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

        expect(() => lc.issueGrant("bound", "project.runCheck", 42)).toThrow(/not eligible/);
      });

      it("refuses setSessionTier for a bound external session", () => {
        const deps = bindingDeps();
        boundExternal(deps, "bound", 42);
        const lc = new HttpLifecycle(deps);

        expect(() => lc.setSessionTier("bound", "full", 42)).toThrow(/not eligible/);
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
              asks: false,
              capturedTurnId: null,
            });
          } else {
            sessionDeps.notifyTierMismatch?.({
              sessionId: "bound",
              toolId: "project.runCheck",
              tier: "external",
              targetTier: "full",
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
          toolId: "project.runCheck",
          tier: "core",
          targetTier: "full",
        });

        expect(wc.send).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe("sendToPinnedView", () => {
  beforeEach(() => {
    mockWebContentsById.clear();
    _resetEndpointRegistryForTesting();
  });

  it("sends to a live local view by its WebContents id", () => {
    const wc = { isDestroyed: () => false, send: vi.fn() };
    mockWebContentsById.set(7, wc);

    expect(sendToPinnedView(7, "mcp:x", () => ({ a: 1 }), "x")).toBe(true);
    expect(wc.send).toHaveBeenCalledWith("mcp:x", { a: 1 });
  });

  it("reports a dead or missing local view as not sent", () => {
    mockWebContentsById.set(7, { isDestroyed: () => true, send: vi.fn() });

    expect(sendToPinnedView(7, "mcp:x", () => ({}), "x")).toBe(false);
    expect(sendToPinnedView(8, "mcp:x", () => ({}), "x")).toBe(false);
  });

  // A refusal points at the banner only when it was sent (#14995).
  it("reports a send that threw as not sent", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockWebContentsById.set(7, {
      isDestroyed: () => false,
      send: vi.fn(() => {
        throw new Error("render frame disposed");
      }),
    });
    expect(sendToPinnedView(7, "mcp:x", () => ({}), "x")).toBe(false);
    errorSpy.mockRestore();
  });

  it("reaches a view attached over a link through its endpoint", () => {
    const send = vi.fn();
    getEndpointRegistry().add({
      endpointId: "remote:-4",
      clientId: "client-b",
      projectId: "proj-1",
      kind: "remote-view",
      handle: -4,
      send,
      request: vi.fn(),
      onClose: () => ({ dispose: () => undefined }),
      isClosed: () => false,
    });

    expect(sendToPinnedView(-4, "mcp:x", () => ({ a: 1 }), "x")).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: "event", channel: "mcp:x", args: [{ a: 1 }] });
    expect(sendToPinnedView(-5, "mcp:x", () => ({}), "x")).toBe(false);
  });
});

describe("HttpLifecycle — a help session with no view (#13511)", () => {
  const TOKEN = "help-tok-noview";
  const AUTH = `Bearer ${TOKEN}`;
  const PROJECT = "proj-1";

  type NoViewDeps = Pick<
    SessionServerDeps,
    "dispatchAction" | "requestManifest" | "getCachedManifest" | "refuseWrite"
  >;
  const buildDeps = (lc: HttpLifecycle, sessionId: string): NoViewDeps =>
    (
      lc as unknown as { buildSessionServerDeps: (id: string) => NoViewDeps }
    ).buildSessionServerDeps(sessionId);

  function noViewLifecycle(deps: HttpLifecycleDeps, project: string | null = PROJECT) {
    const lc = new HttpLifecycle(deps);
    lc.setApiKey("test-api-key");
    lc.setHelpTokenValidator((token) => (token === TOKEN ? "core" : false));
    lc.setHelpSessionWebContentsResolver((token) => (token === TOKEN ? NO_VIEW_HANDLE : null));
    lc.setHelpSessionViewlessProjectResolver((token) => (token === TOKEN ? project : null));
    (lc as unknown as { port: number }).port = 45454;
    return lc;
  }

  afterEach(() => {
    _resetMcpDriveTargetResolverForTesting();
  });

  it("binds the handshake to its project, a help session still, with no view to pin", async () => {
    const deps = fakeDeps();
    const lc = noViewLifecycle(deps);
    const res = new EventEmitter() as EventEmitter & Record<string, unknown>;
    res.writeHead = vi.fn();
    res.write = vi.fn(() => true);
    res.end = vi.fn();
    res.headersSent = false;
    await (
      lc as unknown as {
        handleRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
      }
    ).handleRequest(
      {
        method: "GET",
        url: "/sse",
        headers: { host: "127.0.0.1:45454", authorization: AUTH },
      } as unknown as http.IncomingMessage,
      res as unknown as http.ServerResponse
    );
    const [sessionId] = Array.from(deps.sessionStore.sessions.keys());

    expect(deps.sessionStore.getOrigin(sessionId!)).toBe("help");
    expect(deps.sessionStore.sessionViewlessHelpMap.get(sessionId!)).toBe(PROJECT);
    expect(deps.sessionStore.sessionWebContentsMap.has(sessionId!)).toBe(false);
    expect(deps.sessionStore.sessionWorkspaceMap.has(sessionId!)).toBe(false);
  });

  it("keeps a bare pin, which no view answers, when its project can't be read", () => {
    const lc = noViewLifecycle(fakeDeps(), null);
    const resolve = (
      lc as unknown as { resolveSessionPin: (h: string) => unknown }
    ).resolveSessionPin.bind(lc);
    expect(resolve(AUTH)).toEqual({ origin: "help", webContentsId: NO_VIEW_HANDLE });
  });

  it("runs its calls through the host's own route, with its launch context, never focus", async () => {
    const withoutView = vi.fn().mockResolvedValue({ result: { ok: true, result: null } });
    const deps = fakeDeps({ dispatchActionWithoutView: withoutView });
    deps.sessionStore.sessionViewlessHelpMap.set("s1", PROJECT);
    deps.sessionStore.sessionOriginMap.set("s1", "help");
    deps.sessionStore.sessionContextMap.set("s1", { projectId: PROJECT, activeWorktreeId: "wt" });
    const lc = noViewLifecycle(deps);
    const sessionDeps = buildDeps(lc, "s1");

    await sessionDeps.dispatchAction("worktree.create", { branch: "x" }, true, "skip-preference");

    expect(withoutView).toHaveBeenCalledWith(
      PROJECT,
      "worktree.create",
      { branch: "x" },
      true,
      "help",
      {
        contextOverride: { projectId: PROJECT, activeWorktreeId: "wt" },
        authorization: "skip-preference",
      }
    );
    expect(deps.dispatchAction).not.toHaveBeenCalled();
    const listed = await sessionDeps.requestManifest();
    expect(listed.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["terminal.list", "worktree.create", "agent.launch"])
    );
    expect(sessionDeps.getCachedManifest()).not.toBeNull();
    expect(deps.requestManifest).not.toHaveBeenCalled();
  });

  it("fails closed once torn down, rather than following focus", async () => {
    const withoutView = vi.fn();
    const deps = fakeDeps({ dispatchActionWithoutView: withoutView });
    deps.sessionStore.sessionViewlessHelpMap.set("s1", PROJECT);
    const sessionDeps = buildDeps(noViewLifecycle(deps), "s1");
    deps.sessionStore.sessionViewlessHelpMap.delete("s1");

    await expect(sessionDeps.dispatchAction("terminal.list", {})).rejects.toBeInstanceOf(
      SessionBindingError
    );
    await expect(sessionDeps.requestManifest()).rejects.toBeInstanceOf(SessionBindingError);
    expect(withoutView).not.toHaveBeenCalled();
    expect(deps.dispatchAction).not.toHaveBeenCalled();
  });

  it("runs a project's command only in its own project, while nobody drives it", () => {
    const deps = fakeDeps();
    deps.sessionStore.sessionViewlessHelpMap.set("s1", PROJECT);
    const { refuseWrite } = buildDeps(noViewLifecycle(deps), "s1");
    if (!refuseWrite) throw new Error("expected a write check");

    setMcpDriveTargetResolver(() => ({ state: "vacant" }));
    expect(refuseWrite(PROJECT)).toBeNull();
    expect(refuseWrite("proj-2")).toMatchObject({ code: "VALIDATION_ERROR" });
    setMcpDriveTargetResolver(() => ({
      state: "live",
      endpoint: { linkSessionId: "link-a", isClosed: () => false } as never,
      holderName: "studio-02",
    }));
    expect(refuseWrite(PROJECT)).toEqual({
      code: "DRIVEN_ELSEWHERE",
      message: expect.stringContaining("studio-02 has control"),
    });
  });
});
