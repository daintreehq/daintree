/** Why a Compute Engine or token request failed, typed so callers never match on message text. */
export type GceErrorKind =
  | "unauthorized"
  | "forbidden"
  | "api-disabled"
  | "not-found"
  | "quota"
  | "billing"
  | "rate-limited"
  | "conflict"
  | "no-capacity"
  | "invalid-request"
  | "server"
  | "network"
  | "timeout"
  | "cancelled"
  | "bad-response"
  /** The machine runs but its guest hasn't published its SSH host keys yet. */
  | "host-keys-pending"
  /** A create Google accepted whose result couldn't be read back: a machine may exist. */
  | "outcome-unknown";

export class GceApiError extends Error {
  constructor(
    readonly kind: GceErrorKind,
    message: string,
    readonly status: number | null,
    /** Google's own reason or operation error code: `accessNotConfigured`, `ZONE_RESOURCE_POOL_EXHAUSTED`. */
    readonly reason: string | null,
    readonly retryAfterMs: number | null = null
  ) {
    super(message);
    this.name = "GceApiError";
  }
}

/**
 * Strips anything credential-shaped from text that came back from Google
 * before it is shown or logged: bearer and access tokens, signed assertions,
 * and private key blocks.
 */
export function redactGceText(text: string): string {
  return text
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted]"
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/([?&](?:access_token|assertion|key)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);
}
