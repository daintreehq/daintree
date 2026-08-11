import { z } from "zod";

export const REMOTE_GATEWAY_LIMITS = {
  maxConcurrentConnections: 10,
  maxConcurrentDevices: 5,
  maxSessionsPerDevice: 2,
  maxConsoleSubscriptionsPerSession: 2,
  maxPromptBytes: 64 * 1024,
  maxConsoleSnapshotBytes: 5 * 1024 * 1024,
  maxFrameBytes: 256 * 1024,
  maxQueuedBytes: 1024 * 1024,
  maxRequestsPerMinute: 120,
  maxLaunchesPerMinute: 10,
} as const;

export const RemoteGatewayConfigSchema = z.strictObject({
  enabled: z.boolean(),
  bindAddress: z.string().min(1).max(255),
  port: z.number().int().min(0).max(65_535),
  discoveryEnabled: z.boolean().optional(),
  displayName: z.string().trim().min(1).max(63).optional(),
});

export type RemoteGatewayConfig = z.infer<typeof RemoteGatewayConfigSchema>;

export const DEFAULT_REMOTE_GATEWAY_CONFIG: RemoteGatewayConfig = {
  enabled: false,
  bindAddress: "127.0.0.1",
  port: 45_123,
  discoveryEnabled: true,
};

export const REMOTE_DISCOVERY_SERVICE_TYPE = "_daintree-portal._tcp" as const;

export const RemoteDiscoveryAdvertisementSchema = z.strictObject({
  serviceType: z.literal(REMOTE_DISCOVERY_SERVICE_TYPE),
  displayName: z.string().trim().min(1).max(63),
  hostId: z.string().min(1).max(128),
  protocolMin: z.number().int().positive(),
  protocolMax: z.number().int().positive(),
  appVersion: z.string().min(1).max(64),
  platform: z.enum(["macos", "windows", "linux"]),
  port: z.number().int().positive().max(65_535),
  fingerprintPrefix: z.string().min(8).max(32),
});

export type RemoteDiscoveryAdvertisement = z.infer<typeof RemoteDiscoveryAdvertisementSchema>;
