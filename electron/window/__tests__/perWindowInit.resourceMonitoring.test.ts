import { beforeEach, describe, expect, it, vi } from "vitest";

const { savedTerminalConfig, constructed } = vi.hoisted(() => ({
  savedTerminalConfig: { current: undefined as Record<string, unknown> | undefined },
  constructed: [] as Array<{ setResourceMonitoring: ReturnType<typeof vi.fn> }>,
}));

vi.mock("../../store.js", () => ({
  store: {
    get: vi.fn((key: string) =>
      key === "terminalConfig" ? savedTerminalConfig.current : undefined
    ),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));
// Every method a stub, so construction wiring beyond the one under test runs.
vi.mock("../../services/PtyClient.js", () => ({
  PtyClient: vi.fn(function PtyClient() {
    const methods: Record<string | symbol, unknown> = {};
    const client = new Proxy(methods, {
      get: (target, key) => (target[key] ??= vi.fn()),
    });
    constructed.push(client as never);
    return client;
  }),
}));
vi.mock("../../services/pty/TerminalLifecycleObserver.js", () => ({
  startTerminalLifecycleObserver: vi.fn(),
}));
vi.mock("../../setup/environment.js", () => ({
  refreshPath: vi.fn().mockResolvedValue(undefined),
  expandWindowsEnvVars: (s: string) => s,
  isDemoMode: false,
}));
vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: { getFocusedWindow: vi.fn(() => null) },
  session: { defaultSession: { clearCache: vi.fn(async () => {}) } },
}));
vi.mock("../../ipc/handlers.js", () => ({ sendToRenderer: vi.fn() }));
vi.mock("../../ipc/errorHandlers.js", () => ({ notifyError: vi.fn() }));
vi.mock("../../services/TelemetryService.js", () => ({ trackEvent: vi.fn() }));
vi.mock("../webContentsRegistry.js", () => ({
  clearPortHolderWebContentsIfCurrent: vi.fn(),
  getAppWebContents: vi.fn(),
  setFallbackEligibleProjectsListener: vi.fn(),
}));
vi.mock("../portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
  releaseAllTerminalWorkerPorts: vi.fn(),
}));
vi.mock("../skeletonCss.js", () => ({ resolveInitialCanvasBackgroundColor: () => "#000000" }));
vi.mock("../../services/CliAvailabilityService.js", () => ({
  CliAvailabilityService: vi.fn(function CliAvailabilityService() {}),
}));
vi.mock("../../services/AgentVersionService.js", () => ({ AgentVersionService: vi.fn() }));
vi.mock("../../services/AgentModelCatalogService.js", () => ({
  AgentModelCatalogService: vi.fn(function AgentModelCatalogService(this: {
    getCatalog: () => Promise<void>;
  }) {
    this.getCatalog = async () => {};
  }),
}));
vi.mock("../../services/AgentUpdateHandler.js", () => ({ AgentUpdateHandler: vi.fn() }));
vi.mock("../../services/PortalManager.js", () => ({
  PortalManager: vi.fn(function PortalManager() {}),
}));
vi.mock("../../services/EventBuffer.js", () => ({
  EventBuffer: vi.fn(function EventBuffer() {}),
}));
vi.mock("../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: vi.fn(function ProjectSwitchService() {}),
}));
vi.mock("../../menu.js", () => ({
  createApplicationMenu: vi.fn(),
  rebuildApplicationMenuIfPluginVisibilityChanged: vi.fn(),
}));
vi.mock("../../services/NotificationService.js", () => ({
  notificationService: { initialize: vi.fn(), detachWindowListeners: vi.fn() },
}));
vi.mock("../../services/ProjectStore.js", () => ({ projectStore: { getProjectById: vi.fn() } }));
vi.mock("../../services/PluginService.js", () => ({
  pluginService: { waitForCatalog: () => Promise.resolve() },
}));

import { ensureCriticalServices } from "../perWindowInit.js";
import { setPtyClientRef } from "../serviceRefs.js";
import type { PtyClient } from "../../services/PtyClient.js";

// Shards replay the client's cached flag on their first ready, so seeding it
// at construction is what turns monitoring on at boot; no view writes it
// from its boot snapshot any more (#14699).
describe("ensureCriticalServices resource monitoring", () => {
  beforeEach(() => {
    constructed.length = 0;
    setPtyClientRef(null as unknown as PtyClient);
  });

  it.each([
    [{ resourceMonitoringEnabled: true }, true],
    [{ resourceMonitoringEnabled: false }, false],
    [undefined, false],
  ])("seeds the new pty client from the saved setting (%j)", (saved, expected) => {
    savedTerminalConfig.current = saved;

    ensureCriticalServices(undefined);

    expect(constructed).toHaveLength(1);
    expect(constructed[0].setResourceMonitoring.mock.calls).toEqual([[expected]]);
  });

  it("leaves an existing client alone", () => {
    savedTerminalConfig.current = { resourceMonitoringEnabled: true };
    const existing = { setResourceMonitoring: vi.fn() };
    setPtyClientRef(existing as unknown as PtyClient);

    expect(ensureCriticalServices(undefined)).toBe(existing);
    expect(constructed).toHaveLength(0);
    expect(existing.setResourceMonitoring).not.toHaveBeenCalled();
  });
});
