import { z } from "zod";

/**
 * Runtime shapes for the Boat v1 API (https://docs.boat.dev/openapi/boat-v1.yaml),
 * limited to the fields Daintree reads. Every object passes unknown fields
 * through untouched so a newer Boat never fails validation for adding one; the
 * fields that identity, lifecycle and access depend on are checked.
 */

const nullableString = z.string().nullable().optional();

export const BOAT_SANDBOX_ID = /^bx_[a-z0-9]{8,32}$/;

export const boatStopOperationSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    requestedAt: nullableString,
    lastAttemptAt: nullableString,
    error: nullableString,
    endedAt: nullableString,
    forced: z.boolean().optional(),
  })
  .loose();

export const boatSandboxSchema = z
  .object({
    id: z.string().regex(BOAT_SANDBOX_ID),
    name: z.string().optional().default(""),
    state: z.string(),
    error: nullableString,
    dataExpiredAt: nullableString,
    stoppedAt: nullableString,
    labels: z.record(z.string(), z.string()).optional(),
    type: z.string().optional(),
    vcpu: z.number().optional(),
    memoryGB: z.number().optional(),
    billingMultiplier: z.number().optional(),
    ip: nullableString,
    sshEndpoint: nullableString,
    createdAt: nullableString,
    updatedAt: nullableString,
    archiveAfter: nullableString,
    ttlSeconds: z.number().nullable().optional(),
    snapshots: z.boolean().optional(),
    snapshotAvailable: z.boolean().optional(),
    snapshotCompletedAt: nullableString,
    lastSnapshotStatus: nullableString,
    team: z.object({ id: z.string(), name: z.string() }).loose().nullable().optional(),
    access: z.string().optional(),
    environment: nullableString,
    setupStatus: nullableString,
    health: z.string().optional(),
    hydrated: z.boolean().optional(),
    stop: boatStopOperationSchema.nullable().optional(),
  })
  .loose();

export type BoatSandbox = z.infer<typeof boatSandboxSchema>;
export type BoatStopOperation = z.infer<typeof boatStopOperationSchema>;

export const boatMeSchema = z
  .object({
    user: z
      .object({
        id: z.string().optional(),
        login: z.string().optional(),
        email: z.string().nullable().optional(),
        displayName: z.string().optional(),
        accountStatus: z.string().optional(),
        suspended: z.boolean().optional(),
        closed: z.boolean().optional(),
      })
      .loose(),
  })
  .loose();

export type BoatMe = z.infer<typeof boatMeSchema>;

export const boatOrgSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["personal", "org"]),
    role: z.string().optional(),
    active: z.boolean().optional(),
  })
  .loose();

export const boatOrgListSchema = z.object({ orgs: z.array(boatOrgSchema) }).loose();

export type BoatOrg = z.infer<typeof boatOrgSchema>;

const boatStartWindowSchema = z
  .object({
    limit: z.number().nullable().optional(),
    used: z.number().optional(),
    remaining: z.number().nullable().optional(),
  })
  .loose();

export const boatLimitsSchema = z
  .object({
    canStart: z.boolean().optional(),
    activeSandboxes: z.number().optional(),
    maxActiveSandboxes: z.number().nullable().optional(),
    billingStatus: z.string().nullable().optional(),
    teamId: z.string().nullable().optional(),
    sandboxPlanDollars: z.number().nullable().optional(),
    starts: z
      .object({
        unlimited: z.boolean().optional(),
        minute: boatStartWindowSchema.optional(),
        hour: boatStartWindowSchema.optional(),
        day: boatStartWindowSchema.optional(),
      })
      .loose()
      .optional(),
    planIncluded: z
      .object({
        vmHours: z.number().nullable().optional(),
        vmHoursRemaining: z.number().nullable().optional(),
        periodEnd: nullableString,
      })
      .loose()
      .nullable()
      .optional(),
    overagePrices: z
      .object({
        vmHourDollars: z.number().nullable().optional(),
        savedSnapshotDayDollars: z.number().nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    machineTypes: z
      .array(
        z
          .object({
            type: z.string(),
            available: z.boolean(),
            reason: z.string().nullable().optional(),
          })
          .loose()
      )
      .optional(),
  })
  .loose();

export type BoatLimits = z.infer<typeof boatLimitsSchema>;

export const boatSandboxListSchema = z
  .object({
    sandboxes: z.array(z.unknown()),
    pageInfo: z
      .object({ nextCursor: z.string().nullable().optional(), hasMore: z.boolean().optional() })
      .loose()
      .optional(),
  })
  .loose();

export const boatSandboxInfoSchema = z.object({ sandbox: boatSandboxSchema }).loose();

export const boatCreateResponseSchema = z.object({ sandbox: boatSandboxSchema }).loose();

export const boatActionResponseSchema = z
  .object({
    id: z.string().optional(),
    status: z.string().optional(),
    sandbox: boatSandboxSchema.nullable().optional(),
    operation: boatStopOperationSchema.nullable().optional(),
  })
  .loose();

export type BoatActionResponse = z.infer<typeof boatActionResponseSchema>;

export const boatSshKeyResponseSchema = z
  .object({
    success: z.boolean().optional(),
    machineIp: z.string().nullable().optional(),
    sshUser: z.string().optional(),
    sshEndpoint: z.string().nullable().optional(),
    hostKey: z.string().optional(),
  })
  .loose();

export type BoatSshKeyResponse = z.infer<typeof boatSshKeyResponseSchema>;

export const boatErrorEnvelopeSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
    requestId: z.string().optional(),
    // An object on most routes; a bare code on some (`scoped_api_key_creation_disabled`).
    error: z
      .union([
        z.string(),
        z
          .object({
            code: z.string().optional(),
            message: z.string().optional(),
            details: z.record(z.string(), z.unknown()).optional(),
          })
          .loose(),
      ])
      .optional(),
  })
  .loose();

const scopeSetSchema = z.union([z.literal("*"), z.array(z.string())]);

/** What a key may do and reach, read on its own: one that doesn't read is no evidence of anything. */
export const boatApiKeyScopeSchema = z
  .object({
    actions: z.array(z.string()).optional(),
    sandboxes: scopeSetSchema.optional(),
    environments: scopeSetSchema.optional(),
  })
  .loose();

/**
 * An API key's metadata; Boat never returns a secret here. Its id and name
 * read whatever its scope says, so a key with a scope this build can't read
 * can still be found and revoked.
 */
export const boatApiKeySchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional().default(""),
    expiresAt: z.unknown().optional(),
    scope: z.unknown().optional(),
  })
  .loose();

export type BoatApiKey = z.infer<typeof boatApiKeySchema>;

/** A created key: its metadata and the secret, which Boat shows this once. */
export const boatScopedKeyResponseSchema = z
  .object({ apiKey: boatApiKeySchema, secret: z.string().min(8) })
  .loose();

export type BoatScopedKeyResponse = z.infer<typeof boatScopedKeyResponseSchema>;

export const boatApiKeyListSchema = z.object({ apiKeys: z.array(z.unknown()) }).loose();
