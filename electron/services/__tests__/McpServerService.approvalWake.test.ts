import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testHomeDir = vi.hoisted(
  () => `${process.cwd()}/.vitest-mcp-approval-${Math.random().toString(36).slice(2)}`
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

import { McpServerService } from "../McpServerService.js";
import type { McpHttpSession } from "../mcp-server/shared.js";

const SESSION = "sess-1";
const PIN = 42;
const LANE = { helpSessionId: "help-1", terminalId: "term-1", projectId: "proj-1" };

// What the banner's two approvals tell the assistant (#14995): the service is
// the one place both IPC paths pass, so the line is queued here or nowhere.
describe("McpServerService approval line (#14995)", () => {
  const service = new McpServerService();
  const store = service._sessionStore;
  let queued: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store.httpSessions.set(SESSION, {
      transport: { close: vi.fn().mockResolvedValue(undefined) },
      idleTimer: setTimeout(() => {}, 1_000_000),
    } as unknown as McpHttpSession);
    store.sessionWebContentsMap.set(SESSION, PIN);
    store.sessionOriginMap.set(SESSION, "help");
    store.sessionHelpIdMap.set(SESSION, LANE.helpSessionId);
    store.sessionTierMap.set(SESSION, "core");
    service.setHelpSessionTerminalResolver((id) =>
      id === LANE.helpSessionId ? LANE.terminalId : null
    );
    service.setAssistantControl({
      control: {} as never,
      sessionProject: (id) => (id === LANE.helpSessionId ? LANE.projectId : null),
    });
    queued = vi.spyOn(service, "queueLaneWake").mockImplementation(() => {});
  });

  afterEach(() => {
    queued.mockRestore();
    store.grantCache.revokeSession(SESSION);
    clearTimeout(store.httpSessions.get(SESSION)?.idleTimer);
    store.httpSessions.delete(SESSION);
    store.sessionWebContentsMap.delete(SESSION);
    store.sessionOriginMap.delete(SESSION);
    store.sessionHelpIdMap.delete(SESSION);
    store.sessionTierMap.delete(SESSION);
    store.clearElevationTimer(SESSION);
    service.setHelpSessionTerminalResolver(null);
    service.setAssistantControl(null);
  });

  afterAll(() => {
    store.drain();
    store.grantCache.dispose();
  });

  it("queues the allowed tool on the lane's notice line", () => {
    const result = service.issueGrant(SESSION, "project.runCheck", PIN);

    expect(result).toMatchObject({ sessionId: SESSION, toolId: "project.runCheck" });
    expect(queued).toHaveBeenCalledTimes(1);
    const [lane, wake] = queued.mock.calls[0];
    expect(lane).toEqual(LANE);
    expect(wake).toMatchObject({
      kind: "approval",
      approval: { kind: "tool", toolId: "project.runCheck" },
    });
    expect(wake.recheck()).toEqual({ kind: "ready" });
  });

  it("queues a raised tool set, and nothing when the tier didn't move", () => {
    service.setSessionTier(SESSION, "full", PIN);
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued.mock.calls[0][1]).toMatchObject({
      kind: "approval",
      approval: { kind: "tier", tier: "full" },
    });

    // Already there, and a refused downgrade: neither raised anything.
    service.setSessionTier(SESSION, "full", PIN);
    service.setSessionTier(SESSION, "core", PIN);
    expect(queued).toHaveBeenCalledTimes(1);
  });

  it("queues nothing for an approval the main process refused", () => {
    expect(() => service.issueGrant(SESSION, "project.runCheck", PIN + 1)).toThrow(
      /not the pinned renderer/
    );
    expect(() => service.issueGrant(SESSION, "actions.persistedStores", PIN)).toThrow(
      /non-grantable/
    );
    expect(() => service.setSessionTier(SESSION, "full", PIN + 1)).toThrow(
      /not the pinned renderer/
    );
    expect(queued).not.toHaveBeenCalled();
  });

  it("still grants when the lane has no terminal to type into", () => {
    service.setHelpSessionTerminalResolver(() => null);
    const result = service.issueGrant(SESSION, "project.runCheck", PIN);
    expect(result.toolId).toBe("project.runCheck");
    expect(queued).not.toHaveBeenCalled();
  });

  it("still grants when queueing the line throws", () => {
    queued.mockImplementation(() => {
      throw new Error("notices off");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = service.issueGrant(SESSION, "project.runCheck", PIN);
    expect(result.toolId).toBe("project.runCheck");
    expect(store.grantCache.check(SESSION, "project.runCheck").granted).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
