import { requestPaneFocus } from "@/components/Terminal/paneFocusRequest";
import { findPanelIdForElement, hasBlockingOverlay, hasUsefulFocus } from "@/lib/typeAnywhere";
import { usePanelStore } from "@/store/panelStore";

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
 * keeps it, and only the selected pane's composer is taken.
 */
export function revealDictationComposer(panelId: string): void {
  if (usePanelStore.getState().focusedId !== panelId) return;
  if (hasBlockingOverlay()) return;
  requestPaneFocus(panelId, "hybridInput", { forDictation: true });
}
