import { z } from "zod";

/**
 * Runtime shapes for the parts of the Compute Engine v1 REST API Daintree
 * reads (https://cloud.google.com/compute/docs/reference/rest/v1). Every
 * object passes unknown fields through so a newer API never fails validation
 * for adding one; the fields identity, lifecycle and access depend on are
 * checked. Compute Engine sends int64 values (ids, seconds) as strings.
 */

const int64 = z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]);

export const gceErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: z.number().optional(),
        message: z.string().optional(),
        status: z.string().optional(),
        errors: z
          .array(
            z.object({ reason: z.string().optional(), message: z.string().optional() }).loose()
          )
          .optional(),
        details: z
          .array(
            z.object({ "@type": z.string().optional(), reason: z.string().optional() }).loose()
          )
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export const gceProjectSchema = z
  .object({
    name: z.string(),
    id: int64.optional(),
  })
  .loose();

export const gceZoneSchema = z
  .object({
    name: z.string(),
    status: z.string().optional(),
    region: z.string().optional(),
    description: z.string().optional(),
  })
  .loose();

export const gceZoneListSchema = z
  .object({
    items: z.array(z.unknown()).optional(),
    nextPageToken: z.string().optional(),
  })
  .loose();

export const gceMachineTypeSchema = z
  .object({
    name: z.string(),
    guestCpus: z.number().optional(),
    memoryMb: z.number().optional(),
    zone: z.string().optional(),
    deprecated: z.object({ state: z.string().optional() }).loose().optional(),
  })
  .loose();

export const gceMachineTypeAggregatedListSchema = z
  .object({
    items: z
      .record(z.string(), z.object({ machineTypes: z.array(z.unknown()).optional() }).loose())
      .optional(),
    nextPageToken: z.string().optional(),
  })
  .loose();

export const gceSchedulingSchema = z
  .object({
    maxRunDuration: z
      .object({ seconds: int64.optional(), nanos: z.number().optional() })
      .loose()
      .optional(),
    instanceTerminationAction: z.string().optional(),
    terminationTime: z.string().optional(),
  })
  .loose();

export type GceScheduling = z.infer<typeof gceSchedulingSchema>;

const accessConfigSchema = z.object({ natIP: z.string().optional() }).loose();

export const gceInstanceSchema = z
  .object({
    id: int64,
    name: z.string(),
    status: z.string(),
    statusMessage: z.string().optional(),
    zone: z.string().optional(),
    machineType: z.string().optional(),
    creationTimestamp: z.string().optional(),
    lastStartTimestamp: z.string().optional(),
    lastStopTimestamp: z.string().optional(),
    lastSuspendedTimestamp: z.string().optional(),
    labels: z.record(z.string(), z.string()).optional(),
    scheduling: gceSchedulingSchema.optional(),
    resourceStatus: z
      .object({
        scheduling: z.object({ terminationTimestamp: z.string().optional() }).loose().optional(),
      })
      .loose()
      .optional(),
    networkInterfaces: z
      .array(
        z
          .object({
            networkIP: z.string().optional(),
            accessConfigs: z.array(accessConfigSchema).optional(),
          })
          .loose()
      )
      .optional(),
  })
  .loose();

export type GceInstance = z.infer<typeof gceInstanceSchema>;

export const gceInstanceAggregatedListSchema = z
  .object({
    items: z
      .record(z.string(), z.object({ instances: z.array(z.unknown()).optional() }).loose())
      .optional(),
    nextPageToken: z.string().optional(),
    unreachables: z.array(z.string()).optional(),
  })
  .loose();

export const gceSubnetworkSchema = z
  .object({
    name: z.string(),
    network: z.string().optional(),
    region: z.string().optional(),
    ipCidrRange: z.string().optional(),
    purpose: z.string().optional(),
    stackType: z.string().optional(),
  })
  .loose();

export type GceSubnetwork = z.infer<typeof gceSubnetworkSchema>;

export const gceSubnetworkAggregatedListSchema = z
  .object({
    items: z
      .record(z.string(), z.object({ subnetworks: z.array(z.unknown()).optional() }).loose())
      .optional(),
    nextPageToken: z.string().optional(),
    unreachables: z.array(z.string()).optional(),
  })
  .loose();

export const gceOperationSchema = z
  .object({
    name: z.string(),
    status: z.string(),
    targetId: int64.optional(),
    targetLink: z.string().optional(),
    zone: z.string().optional(),
    httpErrorStatusCode: z.number().optional(),
    httpErrorMessage: z.string().optional(),
    error: z
      .object({
        errors: z
          .array(z.object({ code: z.string().optional(), message: z.string().optional() }).loose())
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type GceOperation = z.infer<typeof gceOperationSchema>;

export const gceGuestAttributesSchema = z
  .object({
    queryValue: z
      .object({
        items: z
          .array(
            z
              .object({
                namespace: z.string().optional(),
                key: z.string().optional(),
                value: z.string().optional(),
              })
              .loose()
          )
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

export type GceGuestAttributes = z.infer<typeof gceGuestAttributesSchema>;
