import { z } from "zod";

/**
 * Runtime shapes for the Akash Console API
 * (https://console-api.akash.network/v1/doc), limited to the fields Daintree
 * reads. Unknown fields pass through so a newer API never fails validation
 * for adding one; the fields scopes and availability depend on are checked.
 */

const nullableString = z.string().nullable().optional();

/** A Console organization or project id. */
export const AKASH_CONSOLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Console's error bodies: `{ statusCode, message }`, and `{ error, message, code, type }` where a route names why. */
export const akashErrorSchema = z
  .object({
    message: z.string().optional(),
    code: z.string().optional(),
    error: z.string().optional(),
  })
  .loose();

export const akashOrganizationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    role: nullableString,
    /** Whether the request ran in this organization: an API key's own. */
    isActive: z.boolean(),
  })
  .loose();

export type AkashOrganization = z.infer<typeof akashOrganizationSchema>;

export const akashOrganizationListSchema = z.object({ data: z.array(z.unknown()) }).loose();

export const akashProjectSchema = z
  .object({
    id: z.string().regex(AKASH_CONSOLE_UUID),
    name: z.string(),
    isDefault: z.boolean(),
    access: z.object({ canDeploy: z.boolean() }).loose(),
  })
  .loose();

export type AkashProject = z.infer<typeof akashProjectSchema>;

export const akashProjectListSchema = z.object({ data: z.array(z.unknown()) }).loose();

export const akashUserSchema = z
  .object({
    data: z
      .object({
        username: nullableString,
        email: nullableString,
      })
      .loose(),
  })
  .loose();

export type AkashUser = z.infer<typeof akashUserSchema>["data"];

export const akashPlacementOptionsSchema = z
  .object({
    regions: z.array(z.string()),
    regionProviderCounts: z.record(z.string(), z.number().int().nonnegative()),
  })
  .loose();

export type AkashPlacementOptions = z.infer<typeof akashPlacementOptionsSchema>;

export const akashScreenedProviderSchema = z
  .object({
    owner: z.string(),
    isAudited: z.boolean(),
    // Always present: null is the Console saying the region is unknown, never a field left out.
    location: z.string().nullable(),
  })
  .loose();

export type AkashScreenedProvider = z.infer<typeof akashScreenedProviderSchema>;

export const akashScreeningSchema = z.object({ providers: z.array(z.unknown()) }).loose();

/** One resource unit of a screening request, as the chain's group spec spells it. */
export interface AkashScreeningRequest {
  requirements: {
    signedBy: { allOf: string[]; anyOf: string[] };
    attributes: Array<{ key: string; value: string }>;
  };
  resources: Array<{
    resource: {
      id: number;
      /** Millicores, as decimal text. */
      cpu: { units: { val: string } };
      /** Bytes, as decimal text. */
      memory: { quantity: { val: string } };
      gpu: { units: { val: string } };
      storage: Array<{ name: string; quantity: { val: string } }>;
      endpoints: [];
    };
    count: number;
    price: { denom: string; amount: string };
  }>;
  timezone: string;
}

/** A deployment sequence number, as the chain writes it: decimal, never zero. */
export const AKASH_DSEQ = /^0*[1-9]\d{0,19}$/;

/** A DecCoin: an amount in the denom's smallest unit, as decimal text that may carry a fraction. */
export const akashCoinSchema = z
  .object({ denom: z.string(), amount: z.string().regex(/^\d+(\.\d+)?$/) })
  .loose();

export type AkashCoin = z.infer<typeof akashCoinSchema>;

const akashDeploymentIdSchema = z
  .object({ owner: z.string().min(1), dseq: z.string().regex(AKASH_DSEQ) })
  .loose();

const akashLeaseIdSchema = z
  .object({
    owner: z.string().min(1),
    dseq: z.string().regex(AKASH_DSEQ),
    gseq: z.number().int().nonnegative(),
    oseq: z.number().int().nonnegative(),
    provider: z.string().min(1),
  })
  .loose();

/** Where a service's port is reached from outside: the provider's host, and the port it forwards there. */
export const akashForwardedPortSchema = z
  .object({
    port: z.number(),
    externalPort: z.number(),
    host: z.string().nullable().optional(),
  })
  .loose();

export const akashLeaseSchema = z
  .object({
    id: akashLeaseIdSchema,
    state: z.string(),
    price: akashCoinSchema,
    /** A block height, not a time. */
    created_at: z.string().optional(),
    /** The provider's own report, read only by a deployment's own route; null when it couldn't be asked. */
    status: z
      .object({
        forwarded_ports: z.record(z.string(), z.array(z.unknown())).nullable().optional(),
      })
      .loose()
      .nullable()
      .optional(),
  })
  .loose();

export type AkashLease = z.infer<typeof akashLeaseSchema>;

export const akashGroupSchema = z
  .object({
    id: z.object({ gseq: z.number().int().nonnegative() }).loose(),
    state: z.string(),
  })
  .loose();

export type AkashGroup = z.infer<typeof akashGroupSchema>;

/** One deployment, as the list and a deployment's own route both spell it. */
export const akashDeploymentSchema = z
  .object({
    deployment: z
      .object({
        id: akashDeploymentIdSchema,
        state: z.string(),
        /** A block height, not a time. */
        created_at: z.string().optional(),
      })
      .loose(),
    leases: z.array(z.unknown()),
    groups: z.array(z.unknown()).optional(),
    name: z.string().nullable().optional(),
  })
  .loose();

export type AkashDeployment = z.infer<typeof akashDeploymentSchema>;

export const akashDeploymentPageSchema = z
  .object({
    data: z
      .object({
        deployments: z.array(z.unknown()),
        pagination: z.object({ hasMore: z.boolean() }).loose(),
      })
      .loose(),
  })
  .loose();

export const akashDeploymentEnvelopeSchema = z.object({ data: z.unknown() }).loose();

export const akashCreatedDeploymentSchema = z
  .object({ data: z.object({ dseq: z.string().regex(AKASH_DSEQ) }).loose() })
  .loose();

export const akashBidSchema = z
  .object({
    bid: z
      .object({
        id: akashLeaseIdSchema.extend({ bseq: z.number().int().nonnegative().optional() }),
        state: z.string(),
        price: akashCoinSchema,
      })
      .loose(),
  })
  .loose();

export type AkashBid = z.infer<typeof akashBidSchema>["bid"];

export const akashBidListSchema = z.object({ data: z.array(z.unknown()) }).loose();

export const akashLeasesCreatedSchema = z
  .object({
    data: z.object({ leases: z.array(z.unknown()) }).loose(),
  })
  .loose();

export const akashAnySchema = z.unknown();
