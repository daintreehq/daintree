/**
 * One Codex rate-limit window as `account/rateLimits/read` reports it (#12797).
 * Windows are told apart by `windowDurationMins`, never by whether the server
 * sent them as `primary` or `secondary`.
 */
export interface CodexQuotaWindow {
  usedPercent: number;
  windowDurationMins: number;
  /** Epoch ms. Null when the server didn't say. */
  resetsAt: number | null;
}

/**
 * Why there is no quota to show. Stable slugs the renderer maps to copy; there
 * is deliberately no zero-usage fallback for any of them.
 */
export type CodexQuotaUnavailableReason =
  | "cli-missing"
  | "timeout"
  /** The read failed: signed out, API-key auth, or an app-server error. */
  | "read-failed"
  /** The reply didn't have the shape this client understands. */
  | "unsupported-response"
  /** A well-formed reply that carried no window at all. */
  | "no-windows";

export type CodexQuotaResult =
  | {
      status: "ok";
      planType: string | null;
      /** Shortest window first. */
      windows: CodexQuotaWindow[];
      fetchedAt: number;
    }
  | {
      status: "unavailable";
      reason: CodexQuotaUnavailableReason;
      fetchedAt: number;
    };

/** A reading older than this is shown as stale rather than current. */
export const CODEX_QUOTA_STALE_AFTER_MS = 2 * 60_000;
