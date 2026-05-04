import { afterEach, describe, expect, it } from "vitest";
import {
  getPtyClient,
  setPtyClientRef,
  getMainProcessWatchdogClientRef,
  setMainProcessWatchdogClientRef,
  getWorkspaceClientRef,
  setWorkspaceClientRef,
  getWorktreePortBrokerRef,
  setWorktreePortBrokerRef,
  getCliAvailabilityServiceRef,
  setCliAvailabilityServiceRef,
  getCleanupIpcHandlers,
  setCleanupIpcHandlers,
  getCleanupErrorHandlers,
  setCleanupErrorHandlers,
  getStopEventLoopLagMonitor,
  setStopEventLoopLagMonitor,
  getStopProcessMemoryMonitor,
  setStopProcessMemoryMonitor,
  getStopAppMetricsMonitor,
  setStopAppMetricsMonitor,
  getStopDiskSpaceMonitor,
  setStopDiskSpaceMonitor,
  getResourceProfileService,
  setResourceProfileService,
  getCcrConfigService,
  setCcrConfigService,
  getAutoUpdaterServiceRef,
  setAutoUpdaterServiceRef,
  getAgentNotificationServiceRef,
  setAgentNotificationServiceRef,
  getAgentVersionService,
  setAgentVersionService,
  getAgentUpdateHandler,
  setAgentUpdateHandler,
  getProcessArgvCliHandled,
  setProcessArgvCliHandled,
  getIpcHandlersRegistered,
  setIpcHandlersRegistered,
  getGlobalServicesInitialized,
  setGlobalServicesInitialized,
} from "../serviceRefs.js";

describe("serviceRefs", () => {
  // Reset every ref to its initial null/false state after each case so
  // module-level let bindings don't bleed between tests.
  afterEach(() => {
    setPtyClientRef(null);
    setMainProcessWatchdogClientRef(null);
    setWorkspaceClientRef(null);
    setWorktreePortBrokerRef(null);
    setCliAvailabilityServiceRef(null);
    setCleanupIpcHandlers(null);
    setCleanupErrorHandlers(null);
    setStopEventLoopLagMonitor(null);
    setStopProcessMemoryMonitor(null);
    setStopAppMetricsMonitor(null);
    setStopDiskSpaceMonitor(null);
    setResourceProfileService(null);
    setCcrConfigService(null);
    setAutoUpdaterServiceRef(null);
    setAgentNotificationServiceRef(null);
    setAgentVersionService(null);
    setAgentUpdateHandler(null);
    setProcessArgvCliHandled(false);
    setIpcHandlersRegistered(false);
    setGlobalServicesInitialized(false);
  });

  it("returns null for service refs by default", () => {
    expect(getPtyClient()).toBeNull();
    expect(getMainProcessWatchdogClientRef()).toBeNull();
    expect(getWorkspaceClientRef()).toBeNull();
    expect(getWorktreePortBrokerRef()).toBeNull();
    expect(getCliAvailabilityServiceRef()).toBeNull();
    expect(getCleanupIpcHandlers()).toBeNull();
    expect(getCleanupErrorHandlers()).toBeNull();
    expect(getStopEventLoopLagMonitor()).toBeNull();
    expect(getStopProcessMemoryMonitor()).toBeNull();
    expect(getStopAppMetricsMonitor()).toBeNull();
    expect(getStopDiskSpaceMonitor()).toBeNull();
    expect(getResourceProfileService()).toBeNull();
    expect(getCcrConfigService()).toBeNull();
    expect(getAutoUpdaterServiceRef()).toBeNull();
    expect(getAgentNotificationServiceRef()).toBeNull();
    expect(getAgentVersionService()).toBeNull();
    expect(getAgentUpdateHandler()).toBeNull();
  });

  it("returns false for guard flags by default", () => {
    expect(getProcessArgvCliHandled()).toBe(false);
    expect(getIpcHandlersRegistered()).toBe(false);
    expect(getGlobalServicesInitialized()).toBe(false);
  });

  it("round-trips function-typed setters", () => {
    const cleanup = (): void => {};
    setCleanupIpcHandlers(cleanup);
    expect(getCleanupIpcHandlers()).toBe(cleanup);
    setCleanupIpcHandlers(null);
    expect(getCleanupIpcHandlers()).toBeNull();

    const stop = (): void => {};
    setStopEventLoopLagMonitor(stop);
    expect(getStopEventLoopLagMonitor()).toBe(stop);
  });

  it("round-trips guard flags through their setters", () => {
    setIpcHandlersRegistered(true);
    expect(getIpcHandlersRegistered()).toBe(true);
    setIpcHandlersRegistered(false);
    expect(getIpcHandlersRegistered()).toBe(false);

    setGlobalServicesInitialized(true);
    expect(getGlobalServicesInitialized()).toBe(true);
    setGlobalServicesInitialized(false);
    expect(getGlobalServicesInitialized()).toBe(false);

    setProcessArgvCliHandled(true);
    expect(getProcessArgvCliHandled()).toBe(true);
  });

  it("round-trips object refs (PtyClient, WorkspaceClient stand-ins)", () => {
    const ptyStub = { id: "pty" } as unknown as Parameters<typeof setPtyClientRef>[0];
    setPtyClientRef(ptyStub);
    expect(getPtyClient()).toBe(ptyStub);

    const wsStub = { id: "workspace" } as unknown as Parameters<typeof setWorkspaceClientRef>[0];
    setWorkspaceClientRef(wsStub);
    expect(getWorkspaceClientRef()).toBe(wsStub);

    setPtyClientRef(null);
    setWorkspaceClientRef(null);
    expect(getPtyClient()).toBeNull();
    expect(getWorkspaceClientRef()).toBeNull();
  });

  it("isolates each ref — setting one does not affect another", () => {
    const ptyStub = {} as unknown as Parameters<typeof setPtyClientRef>[0];
    setPtyClientRef(ptyStub);
    expect(getWorkspaceClientRef()).toBeNull();
    expect(getCliAvailabilityServiceRef()).toBeNull();
    expect(getCcrConfigService()).toBeNull();
  });
});
