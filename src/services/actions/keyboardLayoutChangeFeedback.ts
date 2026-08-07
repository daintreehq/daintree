import type { ActionId, ActionSource } from "@shared/types/actions";
import { notify } from "@/lib/notify";
import { keybindingService } from "@/services/KeybindingService";
import {
  KEYBOARD_LAYOUT_CONFIRMATION_LIMIT,
  keyboardLayoutBindingKey,
  usePreferencesStore,
} from "@/store/preferencesStore";
import { logWarn } from "@/utils/logger";

/**
 * Bumped for every change reported here, announced or not. An Undo belongs to
 * the transition that produced it: once a later change has landed, the older
 * toast's Undo would reverse something the user has done since, so it goes
 * inert rather than silently rolling back the wrong thing.
 */
let changeSequence = 0;

export interface UndoableKeyboardLayoutChange {
  /** The action whose binding caused the change; also the familiarity key. */
  actionId: ActionId;
  /** `ctx.dispatchSource` for the dispatch that ran. */
  dispatchSource: ActionSource | undefined;
  /**
   * Whether the dispatch actually performed the surprising direction of the
   * change. Callers should pass an *observed* before/after transition rather
   * than their intent, so a dispatch some downstream guard turned into a no-op
   * reports `false` without the caller re-deriving that guard.
   */
  changed: boolean;
  /** Past-tense name for what happened, e.g. "Sidebar hidden". */
  title: string;
  /** Built from the live display combo, so a rebound key attributes correctly. */
  message: (displayCombo: string) => string;
  /** The inverse of the change. Invoked at most once. */
  onUndo: () => void;
}

/**
 * Announce a layout change big enough to be alarming when it arrives
 * unannounced, and offer a time-bound way back (#11704).
 *
 * Only bare keypresses get this. Menu items, the command palette and toolbar
 * buttons all name themselves at the moment of the click, and an agent or
 * plugin dispatch has nobody at the keyboard to inform — a keypress is the one
 * path where a whole region of the app can vanish with nothing connecting it to
 * what the user just did.
 *
 * Fires on one direction only. Callers own the asymmetry via `changed`: hiding
 * something is the surprise, bringing it back is self-evidently what happened.
 */
export function notifyUndoableKeyboardLayoutChange(change: UndoableKeyboardLayoutChange): void {
  const { actionId, dispatchSource, changed, title, message, onUndo } = change;

  if (dispatchSource !== "keybinding") return;
  if (!changed) return;

  changeSequence += 1;
  const sequenceAtAnnouncement = changeSequence;

  // The change itself has already happened by the time we get here, so nothing
  // below may throw into the caller: a failed notice would turn a completed
  // toggle into a failed action. Same reasoning as `emitShortcutHint`.
  try {
    // No binding means no combo to attribute the change to, which is the whole
    // point of the notice.
    const combo = keybindingService.getEffectiveCombo(actionId);
    if (!combo) return;

    const key = keyboardLayoutBindingKey(actionId, combo);
    if (
      (usePreferencesStore.getState().keyboardLayoutConfirmationsByBinding[key] ?? 0) >=
      KEYBOARD_LAYOUT_CONFIRMATION_LIMIT
    ) {
      return;
    }

    announce({ actionId, combo, title, message, onUndo, sequenceAtAnnouncement });
  } catch (error) {
    logWarn("Failed to announce a keyboard layout change", { error });
  }
}

interface Announcement {
  actionId: ActionId;
  combo: string;
  title: string;
  message: (displayCombo: string) => string;
  onUndo: () => void;
  sequenceAtAnnouncement: number;
}

function announce({
  actionId,
  combo,
  title,
  message,
  onUndo,
  sequenceAtAnnouncement,
}: Announcement): void {
  let undoFired = false;

  // eslint-disable-next-line no-restricted-syntax -- notify-event-kind: ok — a transient toast cannot carry context (notify() drops the event whenever the origin surface is visible, and the inbox fallback it needs is exactly what transient skips), and no EVENT_POLICY kind describes an attribution notice.
  const notificationId = notify({
    type: "info",
    title,
    message: message(keybindingService.getDisplayCombo(actionId)),
    // `transient` writes no inbox row, so this toast is the only window the
    // Undo ever gets. Matches the palette's hide-action toast — the other
    // transient undo — rather than the 6s info floor, because a user who just
    // slipped mid-work needs time to notice the change and reach the action.
    duration: 30_000,
    // Explicit, because a passive eventKind would resolve this to "low" and
    // route it to the inbox only — a silent no-op for a toast whose whole job
    // is to be seen right now.
    priority: "high",
    // Time-bound Undo, so it has to surface during quiet hours too; otherwise
    // the recovery path is gone before the user has read the notice.
    urgent: true,
    // The change is already on screen and the toolbar button is the durable way
    // back, so once the Undo lapses an inbox row would carry a stale action and
    // nothing worth reading.
    transient: true,
    action: {
      label: "Undo",
      onClick: () => {
        if (undoFired) return;
        // Something changed again after this notice went up, so this Undo would
        // roll back the newer change rather than the one it named.
        if (sequenceAtAnnouncement !== changeSequence) return;
        undoFired = true;
        // Reaching for Undo is the evidence that this keypress was a slip, so
        // the binding goes back to announcing itself.
        usePreferencesStore.getState().clearKeyboardLayoutConfirmations(actionId);
        onUndo();
      },
    },
  });

  // Count it only once it actually surfaced. A toast dropped by the user's
  // notification settings or by rate limiting teaches nobody, and spending an
  // allowance on it would retire the affordance unseen.
  if (notificationId) {
    usePreferencesStore.getState().recordKeyboardLayoutConfirmation(actionId, combo);
  }
}
