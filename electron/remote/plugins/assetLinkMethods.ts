import { z } from "zod";

/** Session CALL a Shell uses to load a host plugin's view assets. */
export const PLUGIN_ASSET_METHOD = "plugins.asset";

/**
 * A view bundle must fit one link frame; plugin views are far smaller than
 * this, and a bigger asset is refused rather than streamed.
 */
export const PLUGIN_ASSET_MAX_BYTES = 8 * 1024 * 1024;

export const PluginAssetRequestSchema = z.object({
  /** The Shell's endpoints on this host; the first one allowed to see the plugin is used. */
  endpointIds: z.array(z.string().min(1).max(256)).min(1).max(64),
  authority: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9._@-]+$/),
  /** URL-encoded path under the plugin root, generation segment included. */
  path: z.string().min(1).max(4096),
  method: z.enum(["GET", "HEAD"]),
  /** The tag of the copy the Shell already holds; an unchanged asset comes back without bytes. */
  ifMatch: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type PluginAssetRequest = z.infer<typeof PluginAssetRequestSchema>;

export const PluginAssetResponseSchema = z.object({
  /** 200 with bytes, 304 when `ifMatch` still holds, or an error status. */
  status: z.number().int().min(200).max(599),
  /** Instance id of the plugin the asset belongs to (the Shell's cache key). */
  pluginId: z.string().min(1).max(256).nullable(),
  /** sha256 of the bytes. */
  etag: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  lastModified: z.number().int().nonnegative().nullable(),
  body: z.instanceof(Uint8Array).nullable(),
});
export type PluginAssetResponse = z.infer<typeof PluginAssetResponseSchema>;
