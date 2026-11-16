import { describe, expect, it, vi } from "vitest";
import type { HostModeStatus } from "../../../../shared/types/ipc/hostMode.js";
import type { HostMode, HostModeSettings } from "../HostModeService.js";
import { createLazyHostMode } from "../lazyHostMode.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function realStatus(): HostModeStatus {
  return {
    supported: true,
    enabled: true,
    startAtLogin: false,
    advertise: true,
    socketPath: "/run/host.sock",
    listening: true,
    attachedClients: [
      { clientId: "c1", clientName: "laptop", connectedAt: 1, drivingProjectIds: [] },
    ],
    rows: [{ id: "socket", state: "ok", detail: "Listening" }],
  };
}

function fakeService() {
  return {
    startListening: vi.fn(async () => {}),
    stopListening: vi.fn(async () => {}),
    refreshStartAtLogin: vi.fn(async () => {}),
    getAttachedClients: vi.fn(() => realStatus().attachedClients),
    getStatus: vi.fn(async () => realStatus()),
    setEnabled: vi.fn(async () => realStatus()),
    enableFromSetup: vi.fn(async () => realStatus()),
    runKeychainPreflight: vi.fn(async () => realStatus()),
    dispose: vi.fn(async () => {}),
  } satisfies HostMode;
}

function harness(settings: Partial<HostModeSettings> = {}) {
  const current: HostModeSettings = {
    enabled: false,
    startAtLogin: false,
    advertise: true,
    ...settings,
  };
  const service = fakeService();
  const create = vi.fn(() => service);
  const load = vi.fn<() => Promise<() => HostMode>>(async () => create);
  const hostMode = createLazyHostMode({
    readSettings: () => current,
    socketPath: "/run/host.sock",
    load,
  });
  return { hostMode, service, create, load, settings: current };
}

describe("createLazyHostMode", () => {
  it("answers status and attached machines from the settings alone while Host mode is off", async () => {
    const h = harness({ advertise: false });

    await expect(h.hostMode.getStatus()).resolves.toEqual({
      supported: true,
      enabled: false,
      startAtLogin: false,
      advertise: false,
      socketPath: "/run/host.sock",
      listening: false,
      attachedClients: [],
      rows: [],
    });
    expect(h.hostMode.getAttachedClients()).toEqual([]);
    await h.hostMode.stopListening();
    expect(h.load).not.toHaveBeenCalled();
  });

  it("loads the service for a status read once the setting says on", async () => {
    const h = harness({ enabled: true });
    await expect(h.hostMode.getStatus()).resolves.toEqual(realStatus());
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["startListening", (m: HostMode) => m.startListening()],
    ["setEnabled", (m: HostMode) => m.setEnabled({ enabled: false })],
    ["enableFromSetup", (m: HostMode) => m.enableFromSetup()],
    ["runKeychainPreflight", (m: HostMode) => m.runKeychainPreflight()],
    ["refreshStartAtLogin", (m: HostMode) => m.refreshStartAtLogin()],
  ] as const)("loads the service and hands %s to it", async (method, call) => {
    const h = harness();
    await call(h.hostMode);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.service[method]).toHaveBeenCalledTimes(1);
  });

  it("builds the service once for concurrent first calls, then answers from it", async () => {
    const h = harness();
    const gate = deferred<() => HostMode>();
    h.load.mockImplementationOnce(() => gate.promise);

    const listening = h.hostMode.startListening();
    const status = h.hostMode.getStatus();
    const enabled = h.hostMode.setEnabled({ enabled: true });
    gate.resolve(h.create);
    await Promise.all([listening, status, enabled]);

    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.service.getStatus).toHaveBeenCalledTimes(1);
    expect(h.hostMode.getAttachedClients()).toEqual(realStatus().attachedClients);
    await h.hostMode.stopListening();
    expect(h.service.stopListening).toHaveBeenCalledTimes(1);
  });

  it("tries the load again after one fails", async () => {
    const h = harness();
    h.load.mockRejectedValueOnce(new Error("chunk missing"));
    await expect(h.hostMode.startListening()).rejects.toThrow("chunk missing");
    expect(h.create).not.toHaveBeenCalled();

    await h.hostMode.startListening();
    expect(h.load).toHaveBeenCalledTimes(2);
    expect(h.service.startListening).toHaveBeenCalledTimes(1);
  });

  it("builds nothing when the quit lands while the module is loading", async () => {
    const h = harness();
    const gate = deferred<() => HostMode>();
    h.load.mockImplementationOnce(() => gate.promise);

    const listening = h.hostMode.startListening();
    await h.hostMode.dispose();
    gate.resolve(h.create);
    await listening;

    expect(h.create).not.toHaveBeenCalled();
    await expect(h.hostMode.setEnabled({ enabled: true })).resolves.toMatchObject({
      listening: false,
    });
    expect(h.load).toHaveBeenCalledTimes(1);
  });

  it("disposes the service it built", async () => {
    const h = harness();
    await h.hostMode.startListening();
    await h.hostMode.dispose();
    expect(h.service.dispose).toHaveBeenCalledTimes(1);
  });
});
