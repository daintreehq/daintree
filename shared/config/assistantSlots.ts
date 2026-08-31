/**
 * Assistant session slots (#12108).
 *
 * A project runs up to {@link MAX_ASSISTANT_SLOTS} concurrent Daintree
 * Assistant sessions. A *slot* is the durable lane identity: stable across
 * launches, unlike the per-provision `sessionId`. Two things force that
 * stability — Claude Code's per-folder workspace-trust acceptance is keyed by
 * the session directory, and an agent's resume token is keyed by the cwd it
 * was captured from. A directory named after the ephemeral session id would
 * re-prompt for trust and strand the resume token on every launch, which is
 * why `HelpSessionService` moved off per-launch UUID dirs in the first place.
 *
 * Slot 0 is the historical single session: same directory, same persisted
 * keys after migration, so an existing install keeps its trust acceptance and
 * its resume token.
 *
 * The single-backend invariant (#7509) is scoped to the slot rather than
 * dropped: at most one assistant PTY per (project, slot). A same-slot
 * re-provision still revokes the prior bearer before killing its PTY; only
 * genuinely different lanes coexist.
 */

/**
 * Concurrent assistant sessions allowed per project. Each costs a billed CLI
 * process, a PTY, an xterm instance, a live MCP transport and a session
 * directory, so the ceiling is deliberate rather than configurable.
 */
export const MAX_ASSISTANT_SLOTS = 3;

/** The lane an install had before slots existed. Never re-numbered. */
export const DEFAULT_ASSISTANT_SLOT = 0;

/** Every slot, ascending — the canonical order tabs and sweeps iterate in. */
export const ASSISTANT_SLOTS: readonly number[] = Array.from(
  { length: MAX_ASSISTANT_SLOTS },
  (_, i) => i
);

export function isValidAssistantSlot(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_ASSISTANT_SLOTS
  );
}

/**
 * Composite key for the per-(project, slot) bookkeeping that used to be keyed
 * by project alone. Uses a NUL delimiter because a project id can be a
 * filesystem path and every printable separator is a legal path character —
 * the same reasoning behind `WorkspaceService`'s control-char delimiters.
 */
export function assistantSlotKey(projectId: string, slot: number): string {
  return `${projectId}\u0000${slot}`;
}

/**
 * Recover the project id from a slot key. Splits on the last delimiter so a
 * project id that itself contains a NUL round-trips.
 */
export function projectIdFromSlotKey(slotKey: string): string {
  const at = slotKey.lastIndexOf("\u0000");
  return at === -1 ? slotKey : slotKey.slice(0, at);
}

/**
 * Session directory name for a slot. Slot 0 keeps the bare project hash so an
 * existing install's directory — and the workspace trust granted to it — is
 * untouched by this change.
 */
export function assistantSlotDirName(projectPathHash: string, slot: number): string {
  return slot === DEFAULT_ASSISTANT_SLOT ? projectPathHash : `${projectPathHash}-s${slot}`;
}

/**
 * Parse a session-directory name back to its slot, or null when the name is
 * not a recognized slot directory.
 *
 * Load-bearing for GC: `gcStaleSessions` recursively deletes every directory
 * it does not recognize, so a name that fails to parse here is a *deleted*
 * session directory, not merely an unclassified one. Rejecting `-s0` (slot 0
 * has no suffix) and out-of-range suffixes keeps exactly one spelling per
 * slot, so a directory orphaned by a lowered ceiling is still collected
 * instead of being kept alive by a permissive pattern.
 */
export function parseAssistantSlotDirName(
  name: string,
  projectHashLength: number
): { projectPathHash: string; slot: number } | null {
  const match = new RegExp(`^([0-9a-f]{${projectHashLength}})(?:-s([1-9][0-9]*))?$`).exec(name);
  if (!match) return null;
  const projectPathHash = match[1]!;
  const rawSlot = match[2];
  if (rawSlot === undefined) return { projectPathHash, slot: DEFAULT_ASSISTANT_SLOT };
  const slot = Number(rawSlot);
  return isValidAssistantSlot(slot) ? { projectPathHash, slot } : null;
}
