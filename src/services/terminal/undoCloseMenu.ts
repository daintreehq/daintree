import type { UndoCloseMenuState } from "@shared/types/menu";
import { isMac } from "@/lib/platform";
import { keybindingService } from "@/services/KeybindingService";
import { subscribeCloseUndoEdits } from "./closeUndoOrder";
import { peekUndoCloseStep, subscribePanelCloseHistory, type CloseStep } from "./panelCloseHistory";
import { UNDO_CLOSE_ACTION_ID, undoCloseStepFor } from "./undoCloseKey";

/**
 * Edit > Undo names the close the next Cmd+Z in this view would reopen
 * (#17108). Main shows the menu, but only this view knows where its keyboard
 * is and what that field's undo would take back, so the view works it out and
 * tells main whenever it changes.
 */

// Cmd+Z on the Mac, Ctrl+Z elsewhere: the key Edit > Undo carries.
function textUndoKeystroke(): KeyboardEvent {
  const mac = isMac();
  return new KeyboardEvent("keydown", { key: "z", code: "KeyZ", metaKey: mac, ctrlKey: !mac });
}

/**
 * The close the next Cmd+Z would reopen from where the keyboard is, by
 * #17107's rules, or `null` when it would undo text or there's nothing to
 * reopen. A terminal counts as reopening on every platform: off the Mac its
 * Ctrl+Z stays the shell's, but the menu item carries no key there, and
 * choosing it is how a close comes back from a focused terminal.
 */
export function undoCloseMenuStep(): CloseStep | null {
  if (typeof document === "undefined" || peekUndoCloseStep() === null) return null;
  const target = document.activeElement ?? document.body;
  if (target === null) return null;
  // A frame's keys go to its own document, never to this one's key handler.
  if (target.tagName === "IFRAME" || target.tagName === "WEBVIEW") return null;
  // A surface typing to a terminal of its own keeps Cmd+Z for it.
  if (target.closest("[data-keybindings-isolated]") !== null) return null;
  // Rebound, unbound or outranked by another binding, Cmd+Z reopens nothing.
  if (
    keybindingService.peekKeybinding(textUndoKeystroke(), target)?.actionId !== UNDO_CLOSE_ACTION_ID
  ) {
    return null;
  }
  return undoCloseStepFor(target, target.closest(".xterm") !== null, true);
}

/** More than the menu ever shows, and within what main accepts. */
const MAX_PUBLISHED_TITLE = 256;

/** {@link undoCloseMenuStep} as the menu names it. */
export function undoCloseMenuState(): UndoCloseMenuState {
  const step = undoCloseMenuStep();
  if (step === null) return null;
  const count = step.panels.length;
  const title = count === 1 ? step.panels[0]!.title : null;
  return {
    count,
    title: title === null ? null : Array.from(title).slice(0, MAX_PUBLISHED_TITLE).join(""),
  };
}

function sameState(a: UndoCloseMenuState, b: UndoCloseMenuState | undefined): boolean {
  return a === b || (a !== null && b != null && a.count === b.count && a.title === b.title);
}

/**
 * Hands `publish` this view's Edit > Undo state whenever it changes: a close
 * joining or leaving the history, focus moving (in the document, into a
 * frame, or back to the window), a field's undo history moving, or a key
 * binding changing. Changes in one task are published once, after
 * focus has settled on its new element. Returns the stop.
 */
export function startUndoCloseMenuPublisher(
  publish: (state: UndoCloseMenuState) => void
): () => void {
  // The first state always goes out: a view reloaded or recovered clears
  // whatever the document before it had named.
  let published: UndoCloseMenuState | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const update = () => {
    timer = null;
    const state = undoCloseMenuState();
    if (sameState(state, published)) return;
    published = state;
    publish(state);
  };
  // A task later, not a microtask: focus moving fires focusout before
  // focusin, and the element between them is the document's body.
  const schedule = () => {
    timer ??= setTimeout(update, 0);
  };

  const unsubscribers = [
    subscribePanelCloseHistory(schedule),
    subscribeCloseUndoEdits(schedule),
    keybindingService.subscribe(schedule),
    keybindingService.subscribeChord(schedule),
  ];
  document.addEventListener("focusin", schedule, true);
  document.addEventListener("focusout", schedule, true);
  // Focus going into a frame, or the window coming back, moves no focus
  // between this document's own elements.
  window.addEventListener("focus", schedule);
  window.addEventListener("blur", schedule);
  schedule();

  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
    document.removeEventListener("focusin", schedule, true);
    document.removeEventListener("focusout", schedule, true);
    window.removeEventListener("focus", schedule);
    window.removeEventListener("blur", schedule);
  };
}
