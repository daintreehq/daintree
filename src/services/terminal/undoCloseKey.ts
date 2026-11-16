import { PLUGIN_STYLE_OWNER_ATTRIBUTE } from "@/services/plugin/pluginStyleOwner";
import { hasEditsSinceClose } from "./closeUndoOrder";
import { flushOptimisticCloses } from "./optimisticPanelClose";
import { peekUndoCloseStep } from "./panelCloseHistory";

export const UNDO_CLOSE_ACTION_ID = "panel.undoClose";

/**
 * Whether the undo-close key (Cmd+Z) reopens a panel from where the keyboard
 * is, or stays with what holds focus (#17107). Left alone, the key reaches the
 * field's own undo, or on the Mac the Edit menu's Undo, exactly as before.
 *
 * - A plugin's view owns its keys, as a browser panel's page does (those
 *   never reach this window at all).
 * - With nothing to reopen, nothing changes.
 * - A terminal has no use for Cmd+Z. Off the Mac its Ctrl+Z is the shell's,
 *   kept by the terminal-reserved keys before this is asked.
 * - A text field edited since the close undoes that first; edits older than
 *   the close come after it.
 */
export function undoCloseTakesKey(target: Element, inTerminal: boolean): boolean {
  if (target.closest(`[${PLUGIN_STYLE_OWNER_ATTRIBUTE}]`) !== null) return false;
  // A close still waiting to commit is the newest one to take back.
  flushOptimisticCloses();
  const step = peekUndoCloseStep();
  if (step === null) return false;
  if (inTerminal) return true;
  return !hasEditsSinceClose(target, step.seq);
}
