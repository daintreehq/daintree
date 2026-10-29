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
export const CODEX_QUOTA_UNAVAILABLE_REASONS = [
  "cli-missing",
  "timeout",
  /** The read failed: signed out, API-key auth, or an app-server error. */
  "read-failed",
  /** The reply didn't have the shape this client understands. */
  "unsupported-response",
  /** A well-formed reply that carried no window at all. */
  "no-windows",
] as const;

export type CodexQuotaUnavailableReason = (typeof CODEX_QUOTA_UNAVAILABLE_REASONS)[number];

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

/**
 * Why a profile's `CODEX_HOME` couldn't be read at all (#13686): a preset's,
 * or the agent-wide one the default profile uses (#15047). Kept apart from
 * {@link CODEX_QUOTA_UNAVAILABLE_REASONS} because the MCP quota tool's schema
 * doesn't carry these; it reports an unreadable default home as `read-failed`.
 */
export const CODEX_QUOTA_PROFILE_HOME_REASONS = [
  /** The directory doesn't exist, or isn't a directory. */
  "home-missing",
  /**
   * Relative or `~`-prefixed. Codex expands neither, and a relative path would
   * resolve against whichever folder a pane happened to start in.
   */
  "home-not-absolute",
] as const;

export type CodexQuotaProfileHomeReason = (typeof CODEX_QUOTA_PROFILE_HOME_REASONS)[number];

export type CodexQuotaProfileResult =
  | CodexQuotaResult
  | { status: "unavailable"; reason: CodexQuotaProfileHomeReason; fetchedAt: number };

/**
 * One Codex profile: a distinct `CODEX_HOME`, with the presets that launch
 * into it. Profiles are told apart by home, never by preset, so two presets
 * sharing a home share one reading. No path crosses to the renderer.
 */
export interface CodexQuotaProfile {
  /** Opaque and stable for as long as the home doesn't change. */
  key: string;
  /**
   * What a launch with no preset `CODEX_HOME` uses: the agent-wide one when
   * Codex's env sets it (#15047), main's own otherwise.
   */
  isDefault: boolean;
  /** Names of the presets that set this home, in preset order. */
  presetNames: string[];
  result: CodexQuotaProfileResult;
}
