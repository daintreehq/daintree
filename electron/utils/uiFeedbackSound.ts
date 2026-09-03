import type { NotificationSettings } from "../../shared/types/ipc/api.js";

/**
 * Whether a UI-feedback sound (git operations, worktree lifecycle, agent
 * spawning, context injection) should play right now.
 *
 * The master `soundEnabled` toggle must actually mute everything, not just
 * agent-notification sounds — call sites used to check `uiFeedbackSoundEnabled`
 * alone, so turning sound off left git/worktree sounds playing (#12185).
 * Extracted so every call site enforces both flags identically rather than
 * risking drift across duplicated inline checks.
 */
export function shouldPlayUiFeedbackSound(
  settings: Pick<NotificationSettings, "soundEnabled" | "uiFeedbackSoundEnabled">
): boolean {
  return settings.soundEnabled && settings.uiFeedbackSoundEnabled;
}
