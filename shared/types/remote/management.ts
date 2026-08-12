import type { RemoteCapability, RemotePairedDevice, RemotePairingBootstrap } from "./identity.js";
import type { RemoteGatewayConfig } from "./gateway.js";

export type RemoteGatewayStatus =
  | { state: "disabled" }
  | { state: "starting" }
  | { state: "listening"; bindAddress: string; port: number }
  | { state: "error"; message: string };

export interface RemoteNetworkInterfaceOption {
  address: string;
  name: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

export interface RemoteManagedDevice extends RemotePairedDevice {
  activeSessions: number;
  activeSubscriptions: number;
}

export interface RemotePendingApproval {
  pairingId: string;
  deviceId: string;
  displayName: string;
  platform: "ios" | "android";
  verificationCode: string;
  reauthorization: boolean;
}

export interface RemoteActivityEvent {
  id: string;
  actorDeviceId: string | null;
  sessionId: string | null;
  operation: string;
  result: string;
  targetProjectId: string | null;
  targetWorktreeId: string | null;
  targetPanelId: string | null;
  characterCount: number | null;
  byteCount: number | null;
  occurredAt: number;
}

export interface RemoteAccessSnapshot {
  config: RemoteGatewayConfig;
  status: RemoteGatewayStatus;
  protocolVersion: number;
  secureStorage: "protected" | "unavailable";
  host: {
    hostId: string;
    fingerprint: string;
  } | null;
  endpoint: string | null;
  interfaces: RemoteNetworkInterfaceOption[];
  devices: RemoteManagedDevice[];
  pendingApprovals: RemotePendingApproval[];
  activeSessions: number;
  activeDevices: number;
  activeSubscriptions: number;
  recentActivity: RemoteActivityEvent[];
}

export interface RemoteAccessConfigPatch {
  enabled?: boolean;
  bindAddress?: string;
  discoveryEnabled?: boolean;
  displayName?: string;
}

export interface RemotePairingWindow {
  bootstrap: RemotePairingBootstrap;
  encodedPayload: string;
}

export interface RemoteDeviceCapabilityUpdate {
  deviceId: string;
  capabilities: RemoteCapability[];
}
