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

export const akashProjectEnvelopeSchema = z.object({ data: akashProjectSchema }).loose();

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
    location: nullableString,
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
