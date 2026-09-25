import { z } from "zod";
import { BULK_CHUNK_BYTES } from "../link/frames.js";

/**
 * Session CALL methods that carry TCP streams between a Shell's local
 * listener and a port on its Host's loopback, plus the host-side lookups port
 * forwarding needs. The link's message set is fixed, so a stream rides CALLs:
 * each data call is acknowledged once the far side has written it, and those
 * answers are the stream's flow control.
 *
 * Stream ids are minted by the Shell and scoped to one session. Either side
 * may send DATA, END and CLOSE for a stream the Shell opened.
 */
export const PortLinkMethod = {
  /** Shell → Host: connect a new stream to `localhost:<port>` on the Host. */
  OPEN: "ports.open",
  /** Either way: bytes for a stream, answered once written (or buffered) on the far side. */
  DATA: "ports.data",
  /** Either way: the sender has no more bytes for this stream (TCP half-close). */
  END: "ports.end",
  /** Either way: tear the stream down now. */
  CLOSE: "ports.close",
  /** Shell → Host: the TCP ports listening on the Host's loopback, for "Detected" forwards. */
  LIST_LISTENERS: "ports.list-listeners",
  /** Shell → Host: the dev server a dev-preview subdomain maps to on the Host. */
  RESOLVE_PREVIEW: "ports.resolve-preview",
} as const;

/** One data call's ceiling, matching the link's bulk chunk so no single call hogs a frame. */
export const PORT_DATA_CHUNK_BYTES = BULK_CHUNK_BYTES;

const streamId = z.number().int().min(1).max(0xffffffff);
const port = z.number().int().min(1).max(65535);

export const PortOpenPayloadSchema = z.object({ streamId, port });
export type PortOpenPayload = z.infer<typeof PortOpenPayloadSchema>;

export const PortDataPayloadSchema = z.object({
  streamId,
  data: z
    .instanceof(Uint8Array)
    .refine((bytes) => bytes.byteLength > 0 && bytes.byteLength <= PORT_DATA_CHUNK_BYTES),
});
export type PortDataPayload = z.infer<typeof PortDataPayloadSchema>;

export const PortStreamPayloadSchema = z.object({ streamId });
export type PortStreamPayload = z.infer<typeof PortStreamPayloadSchema>;

export const HostListenerSchema = z.object({
  port,
  processName: z.string().max(256).nullable(),
  pid: z.number().int().min(1).nullable(),
});
export const HostListenerListSchema = z.array(HostListenerSchema).max(1024);

export const ResolvePreviewPayloadSchema = z.object({
  subdomain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[a-z0-9-]+$/),
});

export const PreviewResolutionSchema = z.union([
  z.object({ kind: z.literal("ok"), port, isHttps: z.boolean() }),
  z.object({
    kind: z.literal("not-running"),
    status: z.enum([
      "stopped",
      "starting",
      "installing",
      "running",
      "stopping",
      "error",
      "restored-stopped",
    ]),
  }),
  z.object({ kind: z.literal("unknown-subdomain") }),
]);
export type PreviewResolution = z.infer<typeof PreviewResolutionSchema>;
