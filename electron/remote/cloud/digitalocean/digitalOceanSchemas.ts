import { z } from "zod";

/**
 * Runtime shapes for the DigitalOcean v2 API
 * (https://docs.digitalocean.com/reference/api/api-reference/), limited to the
 * fields Daintree reads. Unknown fields pass through so a newer API never
 * fails validation for adding one; the fields identity, lifecycle and access
 * depend on are checked.
 */

const nullableString = z.string().nullable().optional();

/** A Droplet's id: DigitalOcean's positive integer, kept as its decimal text. */
export const DIGITALOCEAN_DROPLET_ID = /^[1-9][0-9]{0,18}$/;

const listLinksSchema = z
  .object({
    pages: z.object({ next: nullableString }).loose().nullable().optional(),
  })
  .loose()
  .nullable()
  .optional();

export const digitalOceanErrorSchema = z
  .object({
    id: z.string().optional(),
    message: z.string().optional(),
    request_id: z.string().optional(),
  })
  .loose();

export const digitalOceanAccountSchema = z
  .object({
    account: z
      .object({
        uuid: z.string(),
        email: nullableString,
        status: nullableString,
        status_message: nullableString,
        droplet_limit: z.number().nullable().optional(),
        team: z.object({ uuid: z.string(), name: z.string() }).loose().nullable().optional(),
      })
      .loose(),
  })
  .loose();

export type DigitalOceanAccount = z.infer<typeof digitalOceanAccountSchema>["account"];

export const digitalOceanRegionSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    sizes: z.array(z.string()).optional().default([]),
    available: z.boolean(),
  })
  .loose();

export type DigitalOceanRegion = z.infer<typeof digitalOceanRegionSchema>;

export const digitalOceanSizeSchema = z
  .object({
    slug: z.string(),
    memory: z.number(),
    vcpus: z.number(),
    disk: z.number().optional(),
    price_hourly: z.number().nullable().optional(),
    price_monthly: z.number().nullable().optional(),
    regions: z.array(z.string()).optional().default([]),
    available: z.boolean(),
    description: nullableString,
  })
  .loose();

export type DigitalOceanSize = z.infer<typeof digitalOceanSizeSchema>;

export const digitalOceanImageSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    distribution: z.string(),
    slug: nullableString,
    regions: z.array(z.string()).optional().default([]),
    status: nullableString,
    description: nullableString,
    public: z.boolean().optional(),
  })
  .loose();

export type DigitalOceanImage = z.infer<typeof digitalOceanImageSchema>;

const networkSchema = z
  .object({
    ip_address: z.string(),
    type: z.string(),
  })
  .loose();

export const digitalOceanDropletSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    memory: z.number().nullable().optional(),
    vcpus: z.number().nullable().optional(),
    disk: z.number().nullable().optional(),
    locked: z.boolean().optional(),
    status: z.string(),
    created_at: nullableString,
    size_slug: nullableString,
    image: z
      .object({
        id: z.number().nullable().optional(),
        slug: nullableString,
        distribution: nullableString,
        name: nullableString,
      })
      .loose()
      .nullable()
      .optional(),
    region: z.object({ slug: z.string(), name: nullableString }).loose().nullable().optional(),
    networks: z
      .object({
        v4: z.array(networkSchema).optional().default([]),
        v6: z.array(networkSchema).optional().default([]),
      })
      .loose()
      .nullable()
      .optional(),
    tags: z.array(z.string()).optional().default([]),
  })
  .loose();

export type DigitalOceanDroplet = z.infer<typeof digitalOceanDropletSchema>;

export const digitalOceanActionSchema = z
  .object({
    id: z.number(),
    status: z.string(),
    type: z.string(),
    started_at: nullableString,
    completed_at: nullableString,
  })
  .loose();

export type DigitalOceanAction = z.infer<typeof digitalOceanActionSchema>;

export const digitalOceanSshKeySchema = z
  .object({
    id: z.number(),
    fingerprint: z.string(),
    public_key: z.string().optional(),
    name: z.string().optional(),
  })
  .loose();

export type DigitalOceanSshKey = z.infer<typeof digitalOceanSshKeySchema>;

export const digitalOceanDropletEnvelopeSchema = z
  .object({ droplet: digitalOceanDropletSchema })
  .loose();
export const digitalOceanActionEnvelopeSchema = z
  .object({ action: digitalOceanActionSchema })
  .loose();
export const digitalOceanSshKeyEnvelopeSchema = z
  .object({ ssh_key: digitalOceanSshKeySchema })
  .loose();

// A page's items stay unparsed so one odd entry is skipped rather than failing the page.
const items = z.array(z.unknown());
export const digitalOceanRegionPageSchema = z
  .object({ regions: items, links: listLinksSchema })
  .loose();
export const digitalOceanSizePageSchema = z
  .object({ sizes: items, links: listLinksSchema })
  .loose();
export const digitalOceanImagePageSchema = z
  .object({ images: items, links: listLinksSchema })
  .loose();
export const digitalOceanDropletPageSchema = z
  .object({ droplets: items, links: listLinksSchema })
  .loose();
export const digitalOceanActionPageSchema = z
  .object({ actions: items, links: listLinksSchema })
  .loose();
