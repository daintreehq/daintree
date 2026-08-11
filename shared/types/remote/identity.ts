import { z } from "zod";

export const REMOTE_CAPABILITIES = [
  "observe-projects",
  "launch-agents",
  "prompt-agents",
  "view-session-history",
  "administer-host",
] as const;

export const REMOTE_COMPANION_CAPABILITIES = [
  "observe-projects",
  "launch-agents",
  "prompt-agents",
] as const satisfies readonly (typeof REMOTE_CAPABILITIES)[number][];

export const RemoteCapabilitySchema = z.enum(REMOTE_CAPABILITIES);
export const RemoteCapabilitiesSchema = z
  .array(RemoteCapabilitySchema)
  .max(REMOTE_CAPABILITIES.length);

export const RemoteProtocolRangeSchema = z
  .strictObject({
    min: z.number().int().positive(),
    max: z.number().int().positive(),
  })
  .refine(({ min, max }) => min <= max, { message: "Protocol minimum must not exceed maximum" });

export const RemoteSessionHelloSchema = z.strictObject({
  supportedProtocol: RemoteProtocolRangeSchema,
  appVersion: z.string().min(1).max(64),
  deviceId: z.string().min(1).max(128),
  challenge: z.string().min(16).max(1024),
  signature: z.string().min(16).max(2048),
  resumeSessionId: z.string().min(1).max(128).optional(),
});

export const RemoteSessionWelcomeSchema = z.strictObject({
  protocolVersion: z.number().int().positive(),
  sessionId: z.string().min(1).max(128),
  challenge: z.string().min(16).max(1024),
  signature: z.string().min(16).max(2048),
  capabilities: RemoteCapabilitiesSchema,
  appVersion: z.string().min(1).max(64),
  resumeAccepted: z.boolean(),
});

export const RemoteSessionReadySchema = z.strictObject({
  ready: z.literal(true),
});

export const RemotePairBeginRequestSchema = z.strictObject({
  pairingId: z.string().min(1).max(128),
  oneTimeSecret: z.string().min(32).max(256),
  deviceId: z.string().min(1).max(128),
  deviceName: z.string().min(1).max(128),
  platform: z.enum(["ios", "android"]),
  devicePublicKey: z.string().min(32).max(4096),
});

export const RemotePairVerifySchema = z.strictObject({
  pairingId: z.string().min(1).max(128),
  verificationProof: z.string().min(6).max(2048),
});

export const RemotePairVerificationResponseSchema = z.strictObject({
  pairingId: z.string().min(1).max(128),
  verificationCode: z.string().regex(/^\d{6}$/),
  state: z.enum(["match-required", "awaiting-approval"]),
});

export const RemotePairCompleteSchema = z.strictObject({
  pairingId: z.string().min(1).max(128),
  deviceId: z.string().min(1).max(128),
  capabilities: RemoteCapabilitiesSchema,
});

export const RemoteSessionRevokedSchema = z.strictObject({
  reason: z.enum(["device-revoked", "session-replaced", "host-disabled", "policy-changed"]),
});

export const RemoteHostPublicIdentitySchema = z.strictObject({
  hostId: z.string().min(1).max(128),
  publicKey: z.string().min(32).max(4096),
  fingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  createdAt: z.number().int().nonnegative(),
});

export const RemotePairingBootstrapSchema = z.strictObject({
  pairingId: z.string().min(1).max(128),
  oneTimeSecret: z.string().min(32).max(256),
  expiresAt: z.number().int().positive(),
  host: RemoteHostPublicIdentitySchema,
  tlsCertificateFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/),
  endpointHints: z.array(z.string().min(1).max(512)).max(8),
  protocol: RemoteProtocolRangeSchema,
  verificationCode: z.string().regex(/^\d{6}$/),
});

export const RemotePairedDeviceSchema = z.strictObject({
  id: z.string().min(1).max(128),
  hostId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  platform: z.enum(["ios", "android"]),
  publicKey: z.string().min(32).max(4096),
  capabilities: RemoteCapabilitiesSchema,
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
  revokedAt: z.number().int().nonnegative().nullable(),
  revocationReason: z.string().min(1).max(256).nullable(),
});

export type RemoteCapability = z.infer<typeof RemoteCapabilitySchema>;
export type RemoteProtocolRange = z.infer<typeof RemoteProtocolRangeSchema>;
export type RemoteSessionHello = z.infer<typeof RemoteSessionHelloSchema>;
export type RemoteSessionWelcome = z.infer<typeof RemoteSessionWelcomeSchema>;
export type RemoteHostPublicIdentity = z.infer<typeof RemoteHostPublicIdentitySchema>;
export type RemotePairingBootstrap = z.infer<typeof RemotePairingBootstrapSchema>;
export type RemotePairedDevice = z.infer<typeof RemotePairedDeviceSchema>;
export type RemotePairComplete = z.infer<typeof RemotePairCompleteSchema>;
