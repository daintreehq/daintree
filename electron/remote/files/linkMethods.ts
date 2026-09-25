import { z } from "zod";

/**
 * Session CALL methods a Shell uses to read files on its host: previews
 * (served by the host's own protocol handlers, bytes streamed back in
 * verified bulk transfers) and "save locally" downloads.
 *
 * Bytes never ride the CALL itself. The Shell mints a token, names it in the
 * call, and the host sends the bytes as a BULK transfer whose destination is
 * that token; a transfer naming a token the Shell never minted is refused.
 */
export const FileLinkMethod = {
  /** Shell → Host: run a preview request through the host's contained-file handler. */
  REQUEST: "files.request",
  /** Shell → Host: the next slice of an open preview body, as one transfer. */
  PULL: "files.pull",
  /** Shell → Host: the Shell stopped reading a preview body. */
  CANCEL: "files.cancel",
  /** Shell → Host: send a whole file for saving on the Shell. */
  DOWNLOAD: "files.download",
} as const;

/** Transfer destinations the Shell accepts, each followed by the token it minted. */
export const STREAM_SINK_PREFIX = "daintree-stream:";
export const DOWNLOAD_SINK_PREFIX = "daintree-download:";

/**
 * One pull's ceiling. Each slice is hashed before it is sent, so a slice is
 * held whole on the host and on the Shell; this bounds both.
 */
export const PULL_MAX_BYTES = 1024 * 1024;

export const CONTAINED_FILE_SCHEMES = ["daintree-file", "daintree-media", "daintree-pdf"] as const;

const hostPath = z.string().min(1).max(4096);
const endpointId = z.string().min(1).max(256);
const hexId = z.string().regex(/^[0-9a-f]{32}$/);

export const FileRequestPayloadSchema = z.object({
  /**
   * The asking view's own endpoint on this host. The request runs under that
   * endpoint's project and lease only, never another view's.
   */
  endpointId,
  scheme: z.enum(CONTAINED_FILE_SCHEMES),
  path: hostPath,
  root: hostPath,
  method: z.enum(["GET", "HEAD"]),
  range: z.string().max(256).nullable(),
});
export type FileRequestPayload = z.infer<typeof FileRequestPayloadSchema>;

export const FileResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  headers: z
    .record(z.string().max(128), z.string().max(8192))
    .refine((headers) => Object.keys(headers).length <= 64),
  /** A short error body; never file content. */
  text: z.string().max(4096).nullable(),
  /** Set when the body is streamed: pull it until `done`. */
  streamId: hexId.nullable(),
});
export type FileResponse = z.infer<typeof FileResponseSchema>;

export const FilePullPayloadSchema = z.object({
  streamId: hexId,
  token: hexId,
  maxBytes: z.number().int().min(1).max(PULL_MAX_BYTES),
});
export type FilePullPayload = z.infer<typeof FilePullPayloadSchema>;

export const FilePullResultSchema = z.object({
  bytes: z.number().int().min(0).max(PULL_MAX_BYTES),
  done: z.boolean(),
});
export type FilePullResult = z.infer<typeof FilePullResultSchema>;

export const FileCancelPayloadSchema = z.object({ streamId: hexId });

export const FileDownloadPayloadSchema = z.object({
  /** As for a preview: the asking view's own endpoint. */
  endpointId,
  hostPath,
  token: hexId,
});
export type FileDownloadPayload = z.infer<typeof FileDownloadPayloadSchema>;

export const FileDownloadStartSchema = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type FileDownloadStart = z.infer<typeof FileDownloadStartSchema>;
