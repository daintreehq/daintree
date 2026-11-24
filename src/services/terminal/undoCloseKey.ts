import { isMac } from "@/lib/platform";
import { PLUGIN_STYLE_OWNER_ATTRIBUTE } from "@/services/plugin/pluginStyleOwner";
import { hasEditsSinceClose } from "./closeUndoOrder";
import { flushOptimisticCloses } from "./optimisticPanelClose";
import { peekUndoCloseStep, type CloseStep } from "./panelCloseHistory";

export const UNDO_CLOSE_ACTION_ID = "panel.undoClose";

let pressedAsTextUndo = false;

/** Notes that the key handler took the undo-close key, and whether it was also text undo. */
export function noteUndoCloseKeyPress(textUndo: boolean): void {
  pressedAsTextUndo = textUndo;
}

/** Whether the undo-close now running came from the text-undo key; reading it consumes it. */
export function takeUndoCloseKeyPress(): boolean {
  const was = pressedAsTextUndo;
  pressedAsTextUndo = false;
  return was;
}

/** Cmd+Z on the Mac, Ctrl+Z elsewhere: the key a text field undoes with. */
export function isTextUndoKey(event: KeyboardEvent): boolean {
  const primary = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return (
    primary &&
    !event.shiftKey &&
    !event.altKey &&
    (event.key.toLowerCase() === "z" || event.code === "KeyZ")
  );
}

/**
 * Whether the text field holding `target` has edits newer than close `seq`,
 * which its own undo takes back before the close. A terminal keeps none.
 */
export function fieldOutranksClose(target: Element | null, seq: number): boolean {
  if (target === null || target.closest(".xterm") !== null) return false;
  return hasEditsSinceClose(target, seq);
}

/**
 * Whether the undo-close key reopens a panel from where the keyboard is, or
 * stays with what holds focus (#17107). Left alone, the key reaches the
 * field's own undo, or on the Mac the Edit menu's Undo, exactly as before.
 *
 * - A plugin's view owns its keys, as a browser panel's page does (those
 *   never reach this window at all).
 * - With nothing to reopen, nothing changes.
 * - A terminal has no use for Cmd+Z. Off the Mac its Ctrl+Z is the shell's,
 *   kept by the terminal-reserved keys before this is asked.
 * - When the key is also text undo (the default), a text field edited since
 *   the close undoes that first; edits older than the close come after it. A
 *   binding moved to other keys is never text undo, so it always reopens.
 */
export function undoCloseTakesKey(
  target: Element,
  inTerminal: boolean,
  textUndoKey: boolean
): boolean {
  if (target.closest(`[${PLUGIN_STYLE_OWNER_ATTRIBUTE}]`) !== null) return false;
  // A close still waiting to commit is the newest one to take back.
  flushOptimisticCloses();
  return undoCloseStepFor(target, inTerminal, textUndoKey) !== null;
}

/**
 * The close the undo-close key would reopen from `target`, or `null` when the
 * key stays with what holds focus: {@link undoCloseTakesKey} without its
 * flush, so asking commits nothing. A close still waiting to commit isn't
 * counted until it does.
 */
export function undoCloseStepFor(
  target: Element,
  inTerminal: boolean,
  textUndoKey: boolean
): CloseStep | null {
  if (target.closest(`[${PLUGIN_STYLE_OWNER_ATTRIBUTE}]`) !== null) return null;
  const step = peekUndoCloseStep();
  if (step === null) return null;
  if (inTerminal || !textUndoKey) return step;
  return fieldOutranksClose(target, step.seq) ? null : step;
}
