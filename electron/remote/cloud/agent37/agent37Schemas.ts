import { z } from "zod";

/**
 * Runtime shapes for Agent 37's Sandbox API (https://www.agent37.com/docs/agents-api),
 * limited to the fields Daintree reads. Unknown fields pass through so a newer
 * Agent 37 never fails validation for adding one; the fields that identity,
 * lifecycle and access depend on are checked.
 */

/** A bare 10-character lowercase alphanumeric id; it is also the instance's DNS label. */
export const AGENT37_INSTANCE_ID = /^[a-z0-9]{10}$/;

const nullableNumber = z.number().nullable().optional();

export const agent37StatusReasonSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
    operation: z.string().optional(),
  })
  .loose();

export const agent37InstanceSchema = z
  .object({
    id: z.string().regex(AGENT37_INSTANCE_ID),
    status: z.string(),
    status_reason: agent37StatusReasonSchema.nullable().optional(),
    template: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    mount_path: z.string().nullable().optional(),
    resources: z
      .object({ cpu: nullableNumber, memory: nullableNumber, disk: nullableNumber })
      .loose()
      .nullable()
      .optional(),
    url: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    // Stored, never interpreted by Agent 37; only string values can be Daintree's labels.
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    auto_sleep: z.boolean().optional(),
    idle_timeout_seconds: nullableNumber,
    slept_at: nullableNumber,
    past_due: z.boolean().optional(),
    created: nullableNumber,
  })
  .loose();

export type Agent37Instance = z.infer<typeof agent37InstanceSchema>;

/** `{ "data": [...] }`; items are checked one by one so one odd instance never hides the rest. */
export const agent37InstanceListSchema = z.object({ data: z.array(z.unknown()) }).loose();

/** What start and stop answer: the id and where it is now, not the whole instance. */
export const agent37ActionSchema = z.object({ id: z.string(), status: z.string() }).loose();

export type Agent37Action = z.infer<typeof agent37ActionSchema>;

export const agent37BillingSchema = z
  .object({
    balance_usd: z.number().optional(),
    tier: z.number().optional(),
    memory_limit_gb: z.number().optional(),
    past_due: z.boolean().optional(),
  })
  .loose();

export type Agent37Billing = z.infer<typeof agent37BillingSchema>;

export const agent37SshKeySchema = z
  .object({
    id: z.string(),
    fingerprint: z.string().optional(),
    type: z.string().optional(),
    created: z.number().nullable().optional(),
  })
  .loose();

/**
 * A signed URL for one port of one instance: the token rides in the URL's
 * `a37_token` query parameter, and Agent 37 can't revoke it before
 * `expires_at` (Unix seconds).
 */
export const agent37SignedUrlSchema = z
  .object({
    url: z.string().min(1).max(2048),
    port: z.number().int(),
    expires_at: z.number(),
  })
  .loose();

export type Agent37SignedUrl = z.infer<typeof agent37SignedUrlSchema>;

/** What a delete answers; anything else isn't proof the instance is gone. */
export const agent37DeletedSchema = z.object({ id: z.string(), deleted: z.literal(true) }).loose();

export const agent37ErrorEnvelopeSchema = z
  .object({
    error: z.union([
      z.object({ code: z.string().optional(), message: z.string().optional() }).loose(),
      // Transport-level rejections are a bare code.
      z.string(),
    ]),
    message: z.string().optional(),
  })
  .loose();
