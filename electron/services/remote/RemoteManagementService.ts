import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import {
  REMOTE_PROTOCOL_VERSION,
  RemoteGatewayConfigSchema,
  type RemoteAccessConfigPatch,
  type RemoteAccessSnapshot,
  type RemoteCapability,
  type RemoteGatewayConfig,
  type RemotePairingWindow,
} from "../../../shared/types/remote/index.js";
import type { SecretCipher } from "../plugin/secretCipher.js";
import type { RemoteAuditService } from "./RemoteAuditService.js";
import type { RemoteCapabilityService } from "./RemoteCapabilityService.js";
import type { RemoteGatewayService } from "./RemoteGatewayService.js";
import type { RemoteIdentityStore } from "./RemoteIdentityStore.js";
import type { RemotePairingService } from "./RemotePairingService.js";
import type { RemoteSessionRegistry } from "./RemoteSessionRegistry.js";
import { isAllowedRemoteBindAddress } from "./RemoteListener.js";

interface RemoteConfigStore {
  get(): RemoteGatewayConfig;
  set(config: RemoteGatewayConfig): void;
}

function formatEndpoint(address: string, port: number): string {
  return `wss://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

export class RemoteManagementService {
  constructor(
    private readonly identityStore: RemoteIdentityStore,
    private readonly cipher: SecretCipher,
    private readonly gateway: RemoteGatewayService,
    private readonly pairing: RemotePairingService,
    private readonly capabilities: RemoteCapabilityService,
    private readonly sessions: RemoteSessionRegistry,
    private readonly audit: RemoteAuditService,
    private readonly configStore: RemoteConfigStore,
    private readonly applyRuntimeConfig: (config: RemoteGatewayConfig) => Promise<void>
  ) {}

  snapshot(): RemoteAccessSnapshot {
    const config = this.configStore.get();
    const status = this.gateway.status();
    const storedHost = this.identityStore.getHostIdentity();
    const hostId = storedHost?.hostId ?? null;
    const sessionSummaries = new Map(
      this.sessions.deviceSummaries().map((summary) => [summary.deviceId, summary])
    );
    const devices = this.identityStore
      .listDevices()
      .filter((device) => hostId !== null && device.hostId === hostId)
      .map((device) => ({
        ...device,
        activeSessions: sessionSummaries.get(device.id)?.activeSessions ?? 0,
        activeSubscriptions: sessionSummaries.get(device.id)?.activeSubscriptions ?? 0,
      }))
      .sort((a, b) => (b.lastSeenAt ?? b.createdAt) - (a.lastSeenAt ?? a.createdAt));
    const activeDevices = devices.filter((device) => device.activeSessions > 0).length;
    const activeSubscriptions = devices.reduce(
      (total, device) => total + device.activeSubscriptions,
      0
    );

    return {
      config,
      status,
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      secureStorage: this.cipher.tier() === "keychain" ? "protected" : "unavailable",
      host: storedHost ? { hostId: storedHost.hostId, fingerprint: storedHost.fingerprint } : null,
      endpoint:
        status.state === "listening" ? formatEndpoint(status.bindAddress, status.port) : null,
      interfaces: this.networkInterfaceOptions(),
      devices,
      pendingApprovals: this.pairing.pendingApprovals().map((candidate) => ({
        pairingId: candidate.pairingId,
        deviceId: candidate.deviceId,
        displayName: candidate.displayName,
        platform: candidate.platform,
        verificationCode: candidate.verificationCode,
      })),
      activeSessions: devices.reduce((total, device) => total + device.activeSessions, 0),
      activeDevices,
      activeSubscriptions,
      recentActivity: this.audit.listRecent(),
    };
  }

  async updateConfig(patch: RemoteAccessConfigPatch): Promise<RemoteAccessSnapshot> {
    const current = this.configStore.get();
    const config = RemoteGatewayConfigSchema.parse({ ...current, ...patch });
    await this.applyRuntimeConfig(config);
    this.configStore.set(config);
    return this.snapshot();
  }

  openPairingWindow(): RemotePairingWindow {
    const status = this.gateway.status();
    if (status.state !== "listening") {
      throw new Error("Enable Remote access before pairing a device");
    }
    const bootstrap = this.pairing.beginPairing({
      endpointHints: [formatEndpoint(status.bindAddress, status.port)],
    });
    return { bootstrap, encodedPayload: JSON.stringify(bootstrap) };
  }

  approvePairing(pairingId: string, capabilities: RemoteCapability[]): RemoteAccessSnapshot {
    this.pairing.approvePairing(pairingId, capabilities);
    return this.snapshot();
  }

  rejectPairing(pairingId: string): RemoteAccessSnapshot {
    this.pairing.rejectPairing(pairingId);
    return this.snapshot();
  }

  setDeviceCapabilities(deviceId: string, capabilities: RemoteCapability[]): RemoteAccessSnapshot {
    this.capabilities.setCapabilities(deviceId, capabilities);
    return this.snapshot();
  }

  disconnectDevice(deviceId: string): RemoteAccessSnapshot {
    this.sessions.disconnectDeviceSessions(deviceId);
    return this.snapshot();
  }

  disconnectAllDevices(): RemoteAccessSnapshot {
    this.sessions.disconnectAllDevices();
    return this.snapshot();
  }

  revokeDevice(deviceId: string, reason: string): RemoteAccessSnapshot {
    this.capabilities.revoke(deviceId, reason);
    return this.snapshot();
  }

  private networkInterfaceOptions(): RemoteAccessSnapshot["interfaces"] {
    const options: RemoteAccessSnapshot["interfaces"] = [
      { address: "127.0.0.1", name: "This device only", family: "IPv4", internal: true },
    ];
    for (const [name, entries] of Object.entries(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.internal || !isAllowedRemoteBindAddress(entry.address)) continue;
        options.push({
          address: entry.address,
          name,
          family: entry.family,
          internal: false,
        });
      }
    }
    return options;
  }
}
