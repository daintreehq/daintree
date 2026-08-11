import { z as schema } from "zod";

export const REMOTE_ERROR_CODES = [
  "MALFORMED_FRAME",
  "FRAME_TOO_LARGE",
  "UNSUPPORTED_VERSION",
  "AUTHENTICATION_FAILED",
  "DEVICE_REVOKED",
  "SESSION_NOT_READY",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "RATE_LIMITED",
  "NOT_FOUND",
  "CONFLICT",
  "STALE_REVISION",
  "STALE_GENERATION",
  "HOST_UI_UNAVAILABLE",
  "HOST_RESOURCE_PRESSURE",
  "STREAM_GAP",
  "INVALID_REQUEST",
  "INTERNAL_ERROR",
] as const;

export const RemoteErrorCodeSchema = schema.enum(REMOTE_ERROR_CODES);

export const RemoteErrorSchema = schema.strictObject({
  code: RemoteErrorCodeSchema,
  message: schema.string().min(1).max(512),
  retryable: schema.boolean(),
  retryAfterMs: schema.number().int().nonnegative().optional(),
});

export type RemoteErrorCode = schema.infer<typeof RemoteErrorCodeSchema>;
export type RemoteError = schema.infer<typeof RemoteErrorSchema>;
