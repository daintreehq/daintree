import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-adoption-${Math.random().toString(36).slice(2)}`
);

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => testHomeDir),
    setPath: vi.fn(),
    getVersion: vi.fn(() => "0.0.0-test"),
    commandLine: { appendSwitch: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  ipcMain: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), handle: vi.fn() },
  webContents: { fromId: vi.fn(() => null), getAllWebContents: vi.fn(() => []) },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
}));

vi.mock("../../window/windowRef.js", () => ({
  getProjectViewManager: () => null,
  getWindowRegistry: () => null,
  setWindowRegistry: vi.fn(),
}));

vi.mock("../../window/webContentsRegistry.js", () => ({
  getWebContentsForProject: () => [],
  getProjectForWebContents: () => null,
}));

import { McpServerService, mcpServerService } from "../McpServerService.js";
import { helpOwnershipPrincipal, principalOwnerKey } from "../mcp-server/resourceOwnership.js";
import { getMcpServerServiceRef, setPtyClientRef } from "../../window/serviceRefs.js";
import { events } from "../events.js";
import type { PtyClient } from "../PtyClient.js";
import type { OrchestratorPaneIdentity } from "../McpPaneConfigService.js";
import { routeHostEvent, type PtyEventRouterDeps } from "../pty/PtyEventRouter.js";
import type { PtyHostSpawnOptions } from "../../../shared/types/pty-host.js";
import type { McpHttpSession } from "../mcp-server/shared.js";

const ORCHESTRATOR: OrchestratorPaneIdentity = {
  principalId: "principal-orch",
  tier: "core",
  workspaceId: "project-a",
};

// Hand-over decisions (#12490) are made in the service from main-side facts
// alone — the pane's bearer, the pty-host's spawn tracking and the ownership
// ledger — so this suite drives the service with those facts and nothing the
// renderer could forge.
describe("McpServerService terminal hand-over (#12490)", () => {
  const service = new McpServerService();
  const terminals = new Map<string, string | null>();
  const generations = new Map<string, number>();

  beforeEach(() => {
    terminals.clear();
    generations.clear();
    terminals.set("terminal-1", "project-a");
    terminals.set("pane-orch", "project-a");
    generations.set("terminal-1", 3);
    setPtyClientRef({
      hasTerminal: (id: string) => terminals.has(id),
      getTerminalProjectId: (id: string) => terminals.get(id) ?? null,
      getLaunchGeneration: (id: string) => generations.get(id) ?? null,
    } as unknown as PtyClient);
  });

  afterEach(() => {
    for (const adoption of service.listTerminalAdoptions()) {
      service.releaseTerminalAdoption(adoption.terminalId);
    }
    service._sessionStore.resourceOwnership.revokePrincipal(ORCHESTRATOR.principalId);
    setPtyClientRef(null);
  });

  afterAll(() => {
    service._sessionStore.drain();
    service._sessionStore.grantCache.dispose();
  });

  function adopt(overrides: Partial<Parameters<McpServerService["adoptTerminal"]>[0]> = {}) {
    return service.adoptTerminal({
      terminalId: "terminal-1",
      orchestratorPaneId: "pane-orch",
      orchestrator: ORCHESTRATOR,
      callerWorkspaceId: "project-a",
      ...overrides,
    });
  }

  it("hands a running terminal to a pane that can submit input", () => {
    const result = adopt();

    expect(result).toEqual({
      status: "handed-over",
      adoption: {
        terminalId: "terminal-1",
        orchestratorPaneId: "pane-orch",
        adoptedAt: expect.any(Number),
      },
    });
    expect(service.listTerminalAdoptions().map((a) => a.terminalId)).toEqual(["terminal-1"]);
  });

  it("refuses a pane with no bearer, and one whose tier cannot submit input", () => {
    expect(adopt({ orchestrator: null })).toEqual({
      status: "refused",
      reason: "not-orchestrator",
    });
    // Both tool sets carry `terminal.sendCommandOwned` for a pane bearer, so
    // `off` is the one tier left that could only read a handed-over terminal.
    expect(adopt({ orchestrator: { ...ORCHESTRATOR, tier: "off" } })).toEqual({
      status: "refused",
      reason: "not-orchestrator",
    });
    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("refuses the pane itself, a terminal that is gone, and a terminal in another project", () => {
    expect(adopt({ terminalId: "pane-orch" })).toMatchObject({ reason: "self" });
    expect(adopt({ terminalId: "terminal-gone" })).toMatchObject({ reason: "terminal-gone" });

    terminals.set("terminal-elsewhere", "project-b");
    expect(adopt({ terminalId: "terminal-elsewhere" })).toMatchObject({ reason: "other-project" });
    // The view the user acted in counts too: one project's view cannot hand
    // over a terminal that belongs to another.
    expect(adopt({ callerWorkspaceId: "project-b" })).toMatchObject({ reason: "other-project" });
    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("refuses a terminal another client launched, and says so when the pane launched it itself", () => {
    const ownership = service._sessionStore.resourceOwnership;
    ownership.record("s-api", [{ kind: "terminal", id: "terminal-1" }]);
    expect(adopt()).toMatchObject({ reason: "launched-by-another" });
    ownership.clearSession("s-api");

    ownership.bindPrincipal("s-orch", ORCHESTRATOR.principalId);
    ownership.record(ownership.ownerOf("s-orch"), [{ kind: "terminal", id: "terminal-1" }]);
    expect(adopt()).toMatchObject({ reason: "launched-by-orchestrator" });
    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("refuses a second pane and names the one already driving the terminal", () => {
    adopt();

    const second = adopt({
      orchestratorPaneId: "pane-other",
      orchestrator: { ...ORCHESTRATOR, principalId: "principal-other" },
    });

    expect(second).toEqual({
      status: "refused",
      reason: "already-handed",
      heldByPaneId: "pane-orch",
    });
  });

  it("ends when the orchestrator's bearer is revoked, as a relaunch does", () => {
    adopt();

    service.revokeOwnershipPrincipal(ORCHESTRATOR.principalId);

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("ends when the handed-over terminal is trashed", () => {
    adopt();

    events.emit("terminal:trashed", { id: "terminal-1", expiresAt: Date.now() + 60_000 });

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  const spawned = (launchGeneration: number) => ({ success: true, launchGeneration });
  const failed = (launchGeneration: number, code = "ENOENT") => ({
    success: false,
    launchGeneration,
    error: { code },
  });

  it("survives the spawn result of the launch it was made against, and earlier ones", () => {
    // A terminal can be handed over while its own spawn is still pending; the
    // confirmation of that very launch is not a new process.
    adopt();

    service.handleTerminalSpawnResult("terminal-1", spawned(3));
    service.handleTerminalSpawnResult("terminal-1", spawned(2));
    service.handleTerminalSpawnResult("terminal-1", failed(2));
    // A respawn refused because the process is still running leaves it running.
    service.handleTerminalSpawnResult("terminal-1", failed(4, "TERMINAL_ALREADY_LIVE"));

    expect(service.listTerminalAdoptions().map((a) => a.terminalId)).toEqual(["terminal-1"]);
  });

  it("ends when a later launch takes the id, or the handed-over launch never starts", () => {
    adopt();
    service.handleTerminalSpawnResult("terminal-1", spawned(4));
    expect(service.listTerminalAdoptions()).toEqual([]);

    adopt();
    service.handleTerminalSpawnResult("terminal-1", failed(3));
    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("ends when crash recovery fails to bring the process back", () => {
    // A pty-host crash reports no exit for the process it lost; the failed
    // respawn is the only word that it is gone.
    adopt();

    service.handleTerminalSpawnResult("terminal-1", failed(4));

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("ends on a spawn result it cannot place", () => {
    generations.delete("terminal-1");
    adopt();

    service.handleTerminalSpawnResult("terminal-1", spawned(3));

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("ends when the handed-over process exits", () => {
    adopt();
    // A natural exit or a kill leaves nothing tracked under the id.
    terminals.delete("terminal-1");
    generations.delete("terminal-1");

    service.handleTerminalExit("terminal-1");

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  /**
   * An exit is placed by what main still tracks under the id, which holds only
   * because of how the pty event router treats `pendingSpawns` on the way out.
   * These two cases drive the real router over the maps the fake PtyClient
   * reads, so the difference between a process that ended on its own and one
   * whose kill is still in flight is the router's, not this suite's.
   */
  function routerOver(state: {
    pendingSpawns: Map<string, PtyHostSpawnOptions>;
    pendingKillCount: Map<string, number>;
  }): PtyEventRouterDeps {
    const emitter = new EventEmitter();
    emitter.on("exit", (id: string) => {
      service.handleTerminalExit(id);
    });
    setPtyClientRef({
      hasTerminal: (id: string) => state.pendingSpawns.has(id),
      getTerminalProjectId: () => "project-a",
      getLaunchGeneration: (id: string) => state.pendingSpawns.get(id)?.launchGeneration ?? null,
    } as unknown as PtyClient);
    return {
      isDisposed: () => false,
      broker: { resolve: () => true },
      emitter,
      state: { ...state, terminalPids: new Map() },
      callbacks: {
        onReady: () => {},
        onPong: () => {},
        onTerminalRemovedFromTrash: () => {},
      },
      logWarn: () => {},
    };
  }

  const tracking = (launchGeneration: number) =>
    new Map<string, PtyHostSpawnOptions>([
      ["terminal-1", { id: "terminal-1", launchGeneration } as unknown as PtyHostSpawnOptions],
    ]);

  it("ends when the handed-over process exits on its own", () => {
    const deps = routerOver({ pendingSpawns: tracking(3), pendingKillCount: new Map() });
    adopt();

    routeHostEvent({ type: "exit", id: "terminal-1", exitCode: 0 }, deps);

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("outlives a predecessor's exit that the router routes as a queued kill", () => {
    // kill() dropped generation 3 and the respawn registered 4 under the id
    // before 3's exit landed, so the exit decrements the queued kill and
    // leaves the successor — the handed-over process — tracked.
    const deps = routerOver({
      pendingSpawns: tracking(4),
      pendingKillCount: new Map([["terminal-1", 1]]),
    });
    adopt();

    routeHostEvent({ type: "exit", id: "terminal-1", exitCode: 0 }, deps);

    expect(service.listTerminalAdoptions().map((a) => a.terminalId)).toEqual(["terminal-1"]);
  });

  it("outlives a killed predecessor's exit that lands after the successor was handed over", () => {
    // Kill generation 2, respawn as generation 3, hand 3 over, then 2's exit.
    adopt();

    service.handleTerminalExit("terminal-1");

    expect(service.listTerminalAdoptions().map((a) => a.terminalId)).toEqual(["terminal-1"]);
  });

  it("ends when a restart has already replaced the handed-over process", () => {
    adopt();
    generations.set("terminal-1", 4);

    service.handleTerminalExit("terminal-1");

    expect(service.listTerminalAdoptions()).toEqual([]);
  });

  it("tells subscribers the whole list on every change", () => {
    const listener = vi.fn();
    const off = service.onTerminalAdoptionsChange(listener);

    adopt();
    service.releaseTerminalAdoption("terminal-1");
    off();
    adopt();

    expect(listener.mock.calls.map(([adoptions]) => adoptions.length)).toEqual([1, 0]);
  });

  it("offers only panes that can submit input and are still tracked by the host", () => {
    terminals.set("pane-reader", "project-a");
    terminals.set("pane-full", "project-a");

    expect(
      service.filterOrchestratorPanes([
        { paneId: "pane-orch", ...ORCHESTRATOR },
        { paneId: "pane-full", ...ORCHESTRATOR, tier: "full" },
        { paneId: "pane-reader", ...ORCHESTRATOR, tier: "off" },
        { paneId: "pane-exited", ...ORCHESTRATOR },
      ])
    ).toEqual(["pane-orch", "pane-full"]);
  });
});

describe("McpServerService help-bearer revocation (#12993)", () => {
  const service = new McpServerService();

  it("revokes the help session's principal even when no transport is connected", () => {
    const ledger = service._sessionStore.resourceOwnership;
    const principal = helpOwnershipPrincipal("help-session-1");
    const other = helpOwnershipPrincipal("help-session-2");
    ledger.bindPrincipal("transport-1", principal);
    ledger.bindPrincipal("transport-2", other);
    ledger.record(ledger.ownerOf("transport-1"), [{ kind: "worktree", id: "/repo/wt-1" }]);
    ledger.record(ledger.ownerOf("transport-2"), [{ kind: "worktree", id: "/repo/wt-2" }]);
    // The help session's last transport already dropped: only the principal is left.
    ledger.clearAllSessions();

    service.disconnectHelpBearer("help-token-never-connected", "help-session-1");

    expect(ledger.creatorOf("worktree", "/repo/wt-1")).toBeUndefined();
    expect(ledger.creatorOf("worktree", "/repo/wt-2")).toBe(principalOwnerKey(other));
    ledger.revokePrincipal(other);
  });

  it("still tears the bearer's transports down when revoking the principal throws", () => {
    const lookup = vi
      .spyOn(
        (service as unknown as { httpLifecycle: { findHelpBearerHash(t: string): string | null } })
          .httpLifecycle,
        "findHelpBearerHash"
      )
      .mockReturnValue("hash-help");
    const teardown = vi
      .spyOn(service, "disconnectBearer")
      .mockReturnValue({ tokenHash: "hash-help", disconnected: true });
    const revoke = vi.spyOn(service, "revokeOwnershipPrincipal").mockImplementation(() => {
      throw new Error("ledger failed");
    });
    try {
      expect(() => service.disconnectHelpBearer("help-token", "help-session-3")).toThrow(
        "ledger failed"
      );
      expect(lookup).toHaveBeenCalledWith("help-token");
      expect(teardown).toHaveBeenCalledWith("hash-help");
    } finally {
      teardown.mockRestore();
      revoke.mockRestore();
      lookup.mockRestore();
    }
  });
});

function fakeHttpSession(): McpHttpSession {
  return {
    transport: {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpHttpSession["transport"],
    server: {} as McpHttpSession["server"],
    idleTimer: setTimeout(() => {}, 1_000_000),
  };
}

// The composition seam #11790 depends on spans three layers that are otherwise
// only ever tested in isolation: SessionStore's binding predicate, the bridge's
// lease registry, and the accessor ProjectViewManager reads through the
// callback main.ts injects. Every layer can be correct while the seam is wired
// backwards, so this suite exercises the seam itself.
describe("McpServerService.getWorkspaceViewActivity (#11790)", () => {
  // One service for the suite, reset between tests. Construction subscribes to
  // the global event bus and the sleep service, and `stop()` deliberately keeps
  // those (they must survive a server restart) — so a fresh instance per test
  // would leave every previous one subscribed and reachable.
  const service: McpServerService = new McpServerService();

  beforeEach(() => {
    service._sessionStore.drain();
    service._viewLeases.clear();
  });

  afterAll(() => {
    service._sessionStore.drain();
    service._sessionStore.grantCache.dispose();
  });

  /** Register a live, workspace-bound external session the way a handshake does. */
  function bindLiveSession(sessionId: string, workspaceId: string): void {
    service._sessionStore.httpSessions.set(sessionId, fakeHttpSession());
    service._sessionStore.sessionOriginMap.set(sessionId, "external");
    service._sessionStore.sessionWorkspaceMap.set(sessionId, workspaceId);
  }

  it("reports nothing protected when there are no sessions and no calls", () => {
    expect(service.getWorkspaceViewActivity("ws-a", 101)).toEqual({
      dispatchLease: false,
      liveBinding: false,
    });
  });

  it("surfaces a live binding, keyed by workspace id", () => {
    bindLiveSession("s1", "ws-a");

    expect(service.getWorkspaceViewActivity("ws-a", 101).liveBinding).toBe(true);
    // Keyed by workspace, so an unrelated workspace on the same view is unaffected.
    expect(service.getWorkspaceViewActivity("ws-b", 101).liveBinding).toBe(false);
  });

  it("surfaces a dispatch lease, keyed by WebContents id", () => {
    const release = service._viewLeases.acquire(101);

    // The two halves must not be crossed: the lease answers for the view, the
    // binding for the workspace.
    expect(service.getWorkspaceViewActivity("ws-a", 101).dispatchLease).toBe(true);
    expect(service.getWorkspaceViewActivity("ws-a", 202).dispatchLease).toBe(false);
    expect(service.getWorkspaceViewActivity("ws-a", 101).liveBinding).toBe(false);

    release();
    expect(service.getWorkspaceViewActivity("ws-a", 101).dispatchLease).toBe(false);
  });

  it("reports both halves independently for the same workspace and view", () => {
    bindLiveSession("s1", "ws-a");
    service._viewLeases.acquire(101);

    expect(service.getWorkspaceViewActivity("ws-a", 101)).toEqual({
      dispatchLease: true,
      liveBinding: true,
    });
  });

  it("drops the binding when the session is revoked, without touching leases", () => {
    bindLiveSession("s1", "ws-a");
    service._viewLeases.acquire(101);

    service._sessionStore.revokeSession("s1");

    expect(service.getWorkspaceViewActivity("ws-a", 101)).toEqual({
      dispatchLease: true,
      liveBinding: false,
    });
  });

  it("stop() drops leases so a view is not pinned for a renderer that will never answer", async () => {
    service._viewLeases.acquire(101);

    await service.stop();

    expect(service.getWorkspaceViewActivity("ws-a", 101).dispatchLease).toBe(false);
  });

  it("publishes the singleton to serviceRefs at module scope", () => {
    // main.ts reads the activity callback through this ref. If the publication
    // is dropped, every ProjectViewManager silently sees "not protected" and
    // both defects come back with the whole suite still green.
    expect(getMcpServerServiceRef()).toBe(mcpServerService);
  });
});

// A host's MCP server reaches the local view that drives its project through
// this machine's renderer bridge. The bridge's response listeners otherwise
// exist only while this machine's own server runs, so the passthrough has to
// bring them up itself, once.
describe("McpServerService host passthroughs", () => {
  const service = new McpServerService();

  afterAll(() => {
    service._sessionStore.drain();
    service._sessionStore.grantCache.dispose();
  });

  it("dispatches into the named view with the host's approval options, listening once", async () => {
    const bridge = service._bridge;
    const setupListeners = vi.spyOn(bridge, "setupListeners").mockImplementation(() => {});
    const envelope = { result: { ok: true as const, result: null } };
    const dispatch = vi
      .spyOn(bridge, "dispatchActionForWebContents")
      .mockResolvedValue(envelope as never);
    const manifest = vi.spyOn(bridge, "requestManifestForWebContents").mockResolvedValue([]);

    await expect(
      service.dispatchActionForHost(11, "terminal.new", { a: 1 }, true, undefined, "external", {
        approvalOnly: true,
      })
    ).resolves.toBe(envelope);
    await service.requestManifestForHost(11);

    expect(dispatch).toHaveBeenCalledWith(
      11,
      "terminal.new",
      { a: 1 },
      true,
      undefined,
      "external",
      {
        approvalOnly: true,
      }
    );
    expect(manifest).toHaveBeenCalledWith(11);
    expect(setupListeners).toHaveBeenCalledTimes(1);
  });
});
