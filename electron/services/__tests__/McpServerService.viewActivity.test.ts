import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The composition seam #11790 depends on spans three layers that are otherwise
// only ever tested in isolation: SessionStore's binding predicate, the bridge's
// lease registry, and the accessor ProjectViewManager reads through the
// callback main.ts injects. Every layer can be correct while the seam is wired
// backwards, so this suite exercises the seam itself.

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-activity-${Math.random().toString(36).slice(2)}`
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
import { getMcpServerServiceRef } from "../../window/serviceRefs.js";
import type { McpHttpSession } from "../mcp-server/shared.js";

function fakeHttpSession(): McpHttpSession {
  return {
    transport: {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as McpHttpSession["transport"],
    server: {} as McpHttpSession["server"],
    idleTimer: setTimeout(() => {}, 1_000_000),
  };
}

describe("McpServerService.getWorkspaceViewActivity (#11790)", () => {
  let service: McpServerService;

  beforeEach(() => {
    service = new McpServerService();
  });

  afterEach(() => {
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
