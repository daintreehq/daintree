import {
  captureFocusEpoch,
  isFocusEpochCurrent,
  paneSurfaceHoldingFocus,
  requestPaneFocus,
} from "@/components/Terminal/paneFocusRequest";
import { findPanelIdForElement, hasBlockingOverlay, hasUsefulFocus } from "@/lib/typeAnywhere";
import { usePanelStore } from "@/store/panelStore";
import { selectSlotForTerminal, useHelpPanelStore } from "@/store/helpPanelStore";

/**
 * Dictation writes into a pane's composer, so starting it takes the keyboard
 * there too: Enter at the end of the session then sends what was dictated
 * instead of reaching the agent's own prompt (#14770). Once, at the start; a
 * click elsewhere during the session is the user's and nothing here pulls it
 * back, since the request is called off by any press or other typing surface.
 *
 * Only the selected pane's composer is ever taken, so a locked target in
 * another pane keeps the keyboard where it is. So does a keyboard on a typing
 * surface that isn't this pane's (the assistant, another pane, a dialog's
 * field), and any open modal. The pane's own terminal, hybrid input and the
 * controls that started the session (a mic button just clicked) all give it up.
 *
 * The caret stays where the composer showed it, selection included: that is
 * where the words go (#14634).
 */
export function focusDictationComposer(panelId: string): void {
  if (usePanelStore.getState().focusedId !== panelId) return;
  if (hasBlockingOverlay()) return;
  const active = document.activeElement;
  if (hasUsefulFocus(active) && findPanelIdForElement(active) !== panelId) return;
  requestPaneFocus(panelId, "hybridInput", { forDictation: true });
}

/**
 * The indicator's "go there" (#14773): the person asked for this pane, so the
 * keyboard moves to its composer from wherever this view last left it, which
 * may be another pane from before they went elsewhere. An open modal still
 * keeps it, and only the selected pane's composer is taken. `caret`, read when
 * the composer takes the keyboard, places its caret instead of the rules
 * dictation starts with.
 */
export function revealDictationComposer(panelId: string, caret?: () => number | null): void {
  if (usePanelStore.getState().focusedId !== panelId) return;
  if (hasBlockingOverlay()) return;
  requestPaneFocus(panelId, "hybridInput", { forDictation: true, ...(caret ? { caret } : {}) });
}

/**
 * The dictation key is stopping this pane's dictation and taking the person
 * back to it (#14791). Called as the key stops it, before the pane comes
 * forward: the call it returns then reveals the composer, caret wherever
 * `caret` says. Null when there is nothing to do: the keyboard is in that
 * composer already, or a modal holds it. The assistant's input isn't a pane, so
 * a dictation there has none to go back to. A press, or any newer request for
 * a pane's keyboard, before the pane is ready calls it off.
 */
export function beginDictationReturn(
  panelId: string
): ((caret: () => number | null) => void) | null {
  if (selectSlotForTerminal(useHelpPanelStore.getState(), panelId) !== null) return null;
  if (hasBlockingOverlay()) return null;
  if (paneSurfaceHoldingFocus(panelId) === "hybridInput") return null;
  const epoch = captureFocusEpoch();
  return (caret) => {
    if (isFocusEpochCurrent(epoch)) revealDictationComposer(panelId, caret);
  };
}
