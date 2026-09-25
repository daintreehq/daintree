import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => {
  const ptyClient = { waitForReady: vi.fn(async () => undefined) };
  const workspaceClient = { id: "workspace" };
  return {
    ptyClient,
    workspaceClient,
    registeredDeps: null as Record<string, unknown> | null,
  };
});

vi.mock("../../window/globalServicesInit.js", () => ({
  ensureGlobalServicesInitialized: vi.fn(async () => {
    calls.push("global-init");
    return "ok";
  }),
  startMcpServerOnce: vi.fn(async () => {
    calls.push("mcp");
  }),
  startPluginHostOnce: vi.fn(async () => {
    calls.push("plugin-host");
  }),
}));

vi.mock("../../window/perWindowInit.js", () => ({
  ensureCriticalServices: vi.fn(() => {
    calls.push("critical-services");
    return mocks.ptyClient;
  }),
}));

vi.mock("../../window/windowServices.js", () => ({
  ensureIpcHandlersRegistered: vi.fn((deps: Record<string, unknown>) => {
    calls.push("ipc");
    mocks.registeredDeps = deps;
    return deps;
  }),
  ensureErrorHandlersRegistered: vi.fn(() => {
    calls.push("error-handlers");
  }),
}));

vi.mock("../../window/deferredInitQueue.js", () => ({
  finalizeDeferredRegistration: vi.fn(() => {
    calls.push("deferred-finalize");
  }),
  signalFirstInteractive: vi.fn(() => {
    calls.push("deferred-drain");
  }),
}));

vi.mock("../../window/serviceRefs.js", () => ({
  getAgentUpdateHandler: () => null,
  getAgentVersionService: () => null,
  getCliAvailabilityServiceRef: () => null,
  getPtyClient: () => mocks.ptyClient,
  getWorktreePortBrokerRef: () => ({ id: "broker" }),
}));

vi.mock("../hostServices.js", () => ({
  ensurePtyHostStarted: vi.fn(async () => {
    calls.push("pty-host");
  }),
  ensureWorkspaceClient: vi.fn(async () => {
    calls.push("workspace-hosts");
    return mocks.workspaceClient;
  }),
  markHostRuntimeActive: vi.fn(() => {
    calls.push("host-active");
  }),
}));

vi.mock("../../services/connectivity/index.js", () => ({
  getServiceConnectivityRegistry: () => ({
    start: () => calls.push("connectivity"),
  }),
}));

vi.mock("../../services/AgentAvailabilityStore.js", () => ({
  initializeAgentAvailabilityStore: vi.fn(() => calls.push("agent-availability")),
}));

vi.mock("../../services/PowerSaveBlockerService.js", () => ({
  initializePowerSaveBlockerService: vi.fn(() => calls.push("power-policy")),
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: {
    initialize: vi.fn(async () => {
      calls.push("project-store");
    }),
  },
}));

vi.mock("../../services/ScratchStore.js", () => ({
  scratchStore: { initialize: vi.fn(async () => undefined) },
}));

vi.mock("../../setup/environment.js", () => ({ isDemoMode: false }));

import { isHostRuntimeStarted, startHostRuntime } from "../hostBootstrap.js";
import { ensurePtyHostStarted } from "../hostServices.js";
import { initializePowerSaveBlockerService } from "../../services/PowerSaveBlockerService.js";
import { startMcpServerOnce } from "../../window/globalServicesInit.js";

describe("startHostRuntime", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("brings the backend up with no window in the documented order, once", async () => {
    const windowRegistry = { all: () => [], size: 0 } as never;

    expect(await startHostRuntime({ windowRegistry })).toBe("ok");
    expect(isHostRuntimeStarted()).toBe(true);

    const index = (step: string) => calls.indexOf(step);
    expect(index("global-init")).toBe(1);
    expect(index("critical-services")).toBeLessThan(index("pty-host"));
    expect(index("ipc")).toBeLessThan(index("pty-host"));
    expect(index("pty-host")).toBeLessThan(index("workspace-hosts"));
    expect(index("workspace-hosts")).toBeLessThan(index("connectivity"));
    expect(index("connectivity")).toBeLessThan(index("mcp"));
    expect(index("mcp")).toBeLessThan(index("plugin-host"));
    expect(index("plugin-host")).toBeLessThan(index("power-policy"));
    expect(index("power-policy")).toBeLessThan(index("deferred-drain"));
    expect(index("deferred-finalize")).toBeLessThan(index("deferred-drain"));
    // The Host claims the deferred queue before its first await.
    expect(index("host-active")).toBe(0);

    expect(ensurePtyHostStarted).toHaveBeenCalledWith({
      windowRegistry,
      deferInitialPoolWarm: false,
    });
    expect(mocks.ptyClient.waitForReady).toHaveBeenCalled();
    expect(startMcpServerOnce).toHaveBeenCalledWith(windowRegistry);
    expect(initializePowerSaveBlockerService).toHaveBeenCalledWith(mocks.ptyClient);

    // IPC is registered with no window; the workspace pool is filled in later.
    expect(mocks.registeredDeps?.mainWindow).toBeUndefined();
    expect(mocks.registeredDeps?.worktreeService).toBe(mocks.workspaceClient);
    expect(mocks.registeredDeps?.windowRegistry).toBe(windowRegistry);

    calls.length = 0;
    expect(await startHostRuntime({ windowRegistry })).toBe("ok");
    expect(calls).toEqual([]);
  });
});
