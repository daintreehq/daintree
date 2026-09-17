import type {
  PanelRestoreRecovery,
  PtyPanelData,
  RestoreRecoveryReason,
} from "@shared/types/panel";

const RESTORE_RECOVERY_REASONS: ReadonlySet<string> = new Set<RestoreRecoveryReason>([
  "sibling-owns-session-id",
  "sibling-owns-resume-latest-slot",
  "session-unresolved",
  "destination-unavailable",
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
  return {
    reason,
    ...(sessionId !== undefined && { sessionId }),
    ...(value.awaitingDestination === true && { awaitingDestination: true as const }),
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
