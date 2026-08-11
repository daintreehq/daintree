import { describe, expect, it, vi } from "vitest";
import type {
  RemoteGatewayConfig,
  RemoteGatewayStatus,
  RemotePairedDevice,
} from "../../../../shared/types/remote/index.js";
import type {
  RemoteIdentityStore,
  StoredRemoteHostIdentity,
  StoredRemoteTlsIdentity,
} from "../RemoteIdentityStore.js";
import { RemoteManagementService } from "../RemoteManagementService.js";

class MemoryIdentityStore implements RemoteIdentityStore {
  host: StoredRemoteHostIdentity | null = null;
  devices: RemotePairedDevice[] = [];

  getHostIdentity() {
    return this.host;
  }
  saveHostIdentity(identity: StoredRemoteHostIdentity) {
    this.host = identity;
  }
  getTlsIdentity(_hostId: string): StoredRemoteTlsIdentity | null {
    return null;
  }
  saveTlsIdentity(_identity: StoredRemoteTlsIdentity) {}
  getDevice(deviceId: string) {
    return this.devices.find((device) => device.id === deviceId) ?? null;
  }
  listDevices() {
    return [...this.devices];
  }
  saveDevice(device: RemotePairedDevice) {
    this.devices = [...this.devices.filter((item) => item.id !== device.id), device];
  }
}

const defaultConfig: RemoteGatewayConfig = {
  enabled: false,
  bindAddress: "127.0.0.1",
  port: 45_123,
  discoveryEnabled: true,
};

function createHarness(overrides: { protectedStorage?: boolean } = {}) {
  const identityStore = new MemoryIdentityStore();
  let config = defaultConfig;
  const set = vi.fn((next: RemoteGatewayConfig) => {
    config = next;
  });
  const applyRuntimeConfig = vi.fn(async () => undefined);
  const gateway = { status: vi.fn<() => RemoteGatewayStatus>(() => ({ state: "disabled" })) };
  const pairing = {
    pendingApprovals: vi.fn(() => []),
    beginPairing: vi.fn(),
    approvePairing: vi.fn(),
    rejectPairing: vi.fn(),
  };
  const capabilities = {
    setCapabilities: vi.fn(),
    revoke: vi.fn(),
  };
  const sessions = {
    deviceSummaries: vi.fn(() => []),
    disconnectDeviceSessions: vi.fn(),
    disconnectAllDevices: vi.fn(),
  };
  const audit = { listRecent: vi.fn(() => []) };
  const service = new RemoteManagementService(
    identityStore,
    { tier: () => (overrides.protectedStorage === false ? "plaintext" : "keychain") } as never,
    gateway as never,
    pairing as never,
    capabilities as never,
    sessions as never,
    audit as never,
    { get: () => config, set },
    applyRuntimeConfig
  );
  return {
    service,
    identityStore,
    gateway,
    pairing,
    capabilities,
    sessions,
    set,
    applyRuntimeConfig,
  };
}

describe("RemoteManagementService", () => {
  it("projects disabled safe defaults without generating host identity", () => {
    const { service, identityStore } = createHarness({ protectedStorage: false });

    expect(service.snapshot()).toMatchObject({
      config: defaultConfig,
      status: { state: "disabled" },
      secureStorage: "unavailable",
      host: null,
      endpoint: null,
      activeSessions: 0,
      activeDevices: 0,
    });
    expect(identityStore.host).toBeNull();
  });

  it("persists configuration only after the runtime accepts it", async () => {
    const failed = createHarness();
    failed.applyRuntimeConfig.mockRejectedValueOnce(new Error("keychain locked"));

    await expect(failed.service.updateConfig({ enabled: true })).rejects.toThrow("keychain locked");
    expect(failed.set).not.toHaveBeenCalled();
    expect(failed.service.snapshot().config.enabled).toBe(false);

    const passing = createHarness();
    await passing.service.updateConfig({ enabled: true, displayName: "Studio host" });
    expect(passing.applyRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, displayName: "Studio host" })
    );
    expect(passing.service.snapshot().config.enabled).toBe(true);
  });

  it("opens pairing only on a listening gateway and delegates grants and revocation", () => {
    const harness = createHarness();
    expect(() => harness.service.openPairingWindow()).toThrow(
      "Enable Remote access before pairing a device"
    );

    harness.gateway.status.mockReturnValue({
      state: "listening",
      bindAddress: "192.168.1.20",
      port: 45_123,
    });
    harness.pairing.beginPairing.mockReturnValue({ pairingId: "pair-1" });
    const pairing = harness.service.openPairingWindow();
    expect(harness.pairing.beginPairing).toHaveBeenCalledWith({
      endpointHints: ["wss://192.168.1.20:45123"],
    });
    expect(pairing.encodedPayload).toBe('{"pairingId":"pair-1"}');

    harness.service.approvePairing("pair-1", ["observe-projects"]);
    expect(harness.pairing.approvePairing).toHaveBeenCalledWith("pair-1", ["observe-projects"]);

    harness.service.setDeviceCapabilities("device-1", ["observe-projects", "prompt-agents"]);
    expect(harness.capabilities.setCapabilities).toHaveBeenCalledWith("device-1", [
      "observe-projects",
      "prompt-agents",
    ]);

    harness.service.disconnectDevice("device-1");
    expect(harness.sessions.disconnectDeviceSessions).toHaveBeenCalledWith("device-1");

    harness.service.revokeDevice("device-1", "Revoked by the desktop user");
    expect(harness.capabilities.revoke).toHaveBeenCalledWith(
      "device-1",
      "Revoked by the desktop user"
    );
  });
});
