import { z } from "zod";
import { CANOPY_HOST_CHANNELS } from "../../../shared/types/ipc/canopyHost.js";

/**
 * Session-level methods behind Canopy reading a host the view isn't bound to.
 * They need no endpoint, so a Shell can read a host it shows no project of.
 */
export const CanopyLinkMethod = {
  /** Shell → Host: one Canopy call, as the Shell's viewer of that name. */
  INVOKE: "canopy.invoke",
  /** Shell → Host: the viewer's panel is gone; forget everything it said. */
  RELEASE: "canopy.release",
  /** Host → Shell: a push to the viewer was lost, and the viewer with it; read again. */
  VIEWER_LOST: "canopy.viewer-lost",
} as const;

/**
 * What a host's pushes to a viewer are addressed to, in place of a view's
 * endpoint: a Shell routes these to the view reading that host, never to the
 * views bound to it.
 */
export const CANOPY_VIEWER_ENDPOINT_PREFIX = "canopy-viewer:";

/** The most args any allowed Canopy call takes, with room to spare. */
export const MAX_CANOPY_INVOKE_ARGS = 8;

const VIEWER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isCanopyViewerId(value: unknown): value is string {
  return typeof value === "string" && VIEWER_ID_PATTERN.test(value);
}

const viewerId = z.string().regex(VIEWER_ID_PATTERN);

export const CanopyInvokePayloadSchema = z.object({
  viewerId,
  channel: z.enum(CANOPY_HOST_CHANNELS),
  args: z.array(z.unknown()).max(MAX_CANOPY_INVOKE_ARGS),
});
export type CanopyInvokePayload = z.infer<typeof CanopyInvokePayloadSchema>;

export const CanopyReleasePayloadSchema = z.object({ viewerId });

export const CanopyViewerLostPayloadSchema = z.object({ viewerId });
