import {
  captureFocusEpoch,
  isFocusEpochCurrent,
  paneSurfaceHoldingFocus,
  requestPaneFocus,
} from "@/components/Terminal/paneFocusRequest";
import { findPanelIdForElement, hasBlockingOverlay, hasUsefulFocus } from "@/lib/typeAnywhere";
import { usePanelStore } from "@/store/panelStore";
import { selectSlotForTerminal, useHelpPanelStore } from "@/store/helpPanelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";

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
 * The dictation key falling back to the Assistant (#15870): its composer
 * takes the keyboard as a grid pane's does for #14770, past a home of the
 * terminal, once the panel shows it. An open modal still keeps it.
 */
export function revealAssistantComposer(): void {
  if (hasBlockingOverlay()) return;
  useHelpPanelStore.getState().requestFocus({ forDictation: true });
}

/** The dictation key's way back to its pane (#14791), from {@link beginDictationReturn}. */
export interface DictationReturn {
  /** False once a press, or a newer request for a pane's keyboard, has called it off. */
  isCurrent: () => boolean;
  /** Puts the keyboard in the pane's composer, its caret where `caret` says when it lands. */
  focus: (caret: () => number | null) => void;
}

/**
 * The dictation key is stopping this pane's dictation and taking the person
 * back to it (#14791). Called as the key stops it, before the pane comes
 * forward. Null when there is nothing to do: the key was pressed with the
 * keyboard in that composer already, or a modal holds it. Pressed in another
 * view, the composer this view last focused kept only the DOM's focus, so it
 * goes back all the same. The assistant's input isn't a pane, so a dictation
 * there has none to go back to.
 */
export function beginDictationReturn(
  panelId: string,
  { pressedHere }: { pressedHere: boolean }
): DictationReturn | null {
  if (selectSlotForTerminal(useHelpPanelStore.getState(), panelId) !== null) return null;
  if (hasBlockingOverlay()) return null;
  if (pressedHere && paneSurfaceHoldingFocus(panelId) === "hybridInput") return null;
  const epoch = captureFocusEpoch();
  const isCurrent = () => isFocusEpochCurrent(epoch);
  return {
    isCurrent,
    focus: (caret) => {
      if (!isCurrent()) return;
      // A dictated send already under way owns the keyboard, its hand-back included.
      if (useTerminalInputStore.getState().voiceSubmittingPanels.has(panelId)) return;
      revealDictationComposer(panelId, caret);
    },
  };
}
