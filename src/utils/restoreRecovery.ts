import type {
  PanelHostEnd,
  PanelRestoreRecovery,
  PtyPanelData,
  RestoreRecoveryReason,
} from "@shared/types/panel";

const RESTORE_RECOVERY_REASONS: ReadonlySet<string> = new Set<RestoreRecoveryReason>([
  "sibling-owns-session-id",
  "sibling-owns-resume-latest-slot",
  "session-unresolved",
  "destination-unavailable",
  "resume-deferred",
  "held-by-plugin",
  "host-ended-uncleanly",
]);

const HOST_END_CAUSES: ReadonlySet<string> = new Set<PanelHostEnd["cause"]>([
  "watchdog-deadlock",
  "external-kill",
  "unknown",
]);

// Control characters never belong in a path, and this one is later handed to
// the Codex app-server as a lookup key.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function isRestoreRecoveryReason(value: unknown): value is RestoreRecoveryReason {
  return typeof value === "string" && RESTORE_RECOVERY_REASONS.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHostEndCause(value: unknown): value is PanelHostEnd["cause"] {
  return typeof value === "string" && HOST_END_CAUSES.has(value);
}

function sanitizeHostEnd(value: unknown): PanelHostEnd | undefined {
  if (!isPlainObject(value)) return undefined;
  const cause = value.cause;
  if (!isHostEndCause(cause)) return undefined;
  if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at <= 0) {
    return undefined;
  }
  const missedBeats =
    typeof value.missedBeats === "number" &&
    Number.isInteger(value.missedBeats) &&
    value.missedBeats > 0
      ? value.missedBeats
      : undefined;
  return {
    cause,
    at: value.at,
    ...(missedBeats !== undefined && { missedBeats }),
  };
}

/**
 * Read an on-disk recovery marker (#12434). The snapshot schema passes unknown
 * keys through, so this is the only validation it gets.
 *
 * A marker whose reason is unrecognised still holds the pane — a newer build
 * may have written it, and reading "can't parse" as "safe to launch" would
 * start the very conversation the marker was written to hold. Only a value that
 * isn't a marker at all is dropped.
 */
export function sanitizeRestoreRecovery(value: unknown): PanelRestoreRecovery | undefined {
  if (!isPlainObject(value)) return undefined;
  const reason = isRestoreRecoveryReason(value.reason) ? value.reason : "session-unresolved";
  const sessionId =
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    !value.sessionId.startsWith("-") &&
    !CONTROL_CHARS.test(value.sessionId)
      ? value.sessionId
      : undefined;
  // Only what it observed is quoted, so a record that doesn't parse is dropped
  // while the hold itself stays.
  const hostEnd = reason === "host-ended-uncleanly" ? sanitizeHostEnd(value.hostEnd) : undefined;
  return {
    reason,
    ...(sessionId !== undefined && { sessionId }),
    ...(value.awaitingDestination === true && { awaitingDestination: true as const }),
    ...(hostEnd !== undefined && { hostEnd }),
  };
}

export function sanitizeConversationCwd(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  if (CONTROL_CHARS.test(value)) return undefined;
  return value;
}

/** The folder a pane's conversation was filed under — where Find session looks. */
export function resolveConversationSearchCwd(
  panel: Pick<PtyPanelData, "cwd" | "conversationCwd">
): string {
  return panel.conversationCwd || panel.cwd;
}
