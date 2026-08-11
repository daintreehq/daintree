import type { RemoteCapability, RemotePairedDevice } from "../../../shared/types/remote/index.js";
import { RemoteCapabilitiesSchema } from "../../../shared/types/remote/index.js";
import type { RemoteIdentityStore } from "./RemoteIdentityStore.js";
import type { RemoteIdentityService } from "./RemoteIdentityService.js";
import type { RemoteAuditService } from "./RemoteAuditService.js";

export interface RemoteSessionPolicySink {
  closeDeviceSessions(deviceId: string, reason: "device-revoked"): void;
  deviceCapabilitiesChanged(deviceId: string, capabilities: RemoteCapability[]): void;
}

export type RemoteAuthorizationResult =
  | { allowed: true; device: RemotePairedDevice }
  | { allowed: false; reason: "not-found" | "wrong-host" | "revoked" | "capability-denied" };

export class RemoteCapabilityService {
  private audit: RemoteAuditService | null = null;

  constructor(
    private readonly store: RemoteIdentityStore,
    private readonly identity: RemoteIdentityService,
    private readonly sessions: RemoteSessionPolicySink,
    private readonly now: () => number = Date.now
  ) {}

  setAuditService(audit: RemoteAuditService): void {
    this.audit = audit;
  }

  authorize(deviceId: string, capability: RemoteCapability): RemoteAuthorizationResult {
    const device = this.store.getDevice(deviceId);
    if (!device) return { allowed: false, reason: "not-found" };
    if (device.hostId !== this.identity.publicIdentity().hostId) {
      return { allowed: false, reason: "wrong-host" };
    }
    if (device.revokedAt !== null) return { allowed: false, reason: "revoked" };
    if (!device.capabilities.includes(capability)) {
      return { allowed: false, reason: "capability-denied" };
    }
    return { allowed: true, device };
  }

  setCapabilities(deviceId: string, capabilities: RemoteCapability[]): RemotePairedDevice {
    const parsed = RemoteCapabilitiesSchema.parse(capabilities);
    if (parsed.includes("administer-host")) {
      throw new Error("Host administration cannot be granted remotely");
    }
    const device = this.requireOwnedActiveDevice(deviceId);
    const updated = { ...device, capabilities: [...new Set(parsed)] };
    this.store.saveDevice(updated);
    this.sessions.deviceCapabilitiesChanged(deviceId, updated.capabilities);
    this.audit?.record({
      actorDeviceId: deviceId,
      operation: "capability.change",
      result: "committed",
    });
    return updated;
  }

  revoke(deviceId: string, reason: string): RemotePairedDevice {
    const device = this.requireOwnedActiveDevice(deviceId);
    this.sessions.closeDeviceSessions(deviceId, "device-revoked");
    const revoked = { ...device, revokedAt: this.now(), revocationReason: reason };
    this.store.saveDevice(revoked);
    this.audit?.record({
      actorDeviceId: deviceId,
      operation: "device.revoke",
      result: "revoked",
    });
    return revoked;
  }

  listDevices(): RemotePairedDevice[] {
    const hostId = this.identity.publicIdentity().hostId;
    return this.store.listDevices().filter((device) => device.hostId === hostId);
  }

  private requireOwnedActiveDevice(deviceId: string): RemotePairedDevice {
    const device = this.store.getDevice(deviceId);
    if (!device) throw new Error("Paired device not found");
    if (device.hostId !== this.identity.publicIdentity().hostId) {
      throw new Error("Paired device belongs to a different host");
    }
    if (device.revokedAt !== null) throw new Error("Paired device is revoked");
    return device;
  }
}
