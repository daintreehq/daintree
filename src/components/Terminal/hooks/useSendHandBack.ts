import { useCallback, useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { usePanelStore } from "@/store/panelStore";
import { selectHomeFocusTarget, useTerminalInputStore } from "@/store/terminalInputStore";
import { captureFocusEpoch, isFocusEpochCurrent, requestPaneFocus } from "../paneFocusRequest";
import { isVoiceSessionActiveFor } from "./useVoiceWaitSubmit";
import type { SendTextOptions } from "./useTokenResolution";

/** Told what the pane's `onSend` returned, once the composer has been reset after the send. */
export type SendHandBack = NonNullable<SendTextOptions["onHandedOff"]>;

export type ClaimSendHandBack = () => SendHandBack | undefined;

interface UseSendHandBackParams {
  terminalId: string;
  projectId?: string;
  isolated: boolean;
  editorViewRef: React.RefObject<EditorView | null>;
  /** How many times the Expanded Editor has opened. */
  expandedEditorOpeningsRef: React.RefObject<number>;
  /** Runs `handBack` once an open or closing Expanded Editor has handed the caret back. */
  afterExpandedEditorCloses: (handBack: () => void) => void;
}

const HYBRID_INPUT_SURFACE = "[data-hybrid-input-root], [data-hybrid-input-editor]";

// Focus landing anywhere but a hybrid input. A press is the epoch's business;
// this is the keyboard's way out (Tab, a shortcut), which a later return to
// the composer, such as a dialog restoring its opener, would otherwise hide.
let focusMovesAway = 0;
let watchingFocus = false;

function watchFocusMovesAway(): void {
  if (watchingFocus || typeof document === "undefined") return;
  watchingFocus = true;
  document.addEventListener(
    "focusin",
    (e) => {
      if (e.target instanceof Element && e.target.closest(HYBRID_INPUT_SURFACE) === null) {
        focusMovesAway += 1;
      }
    },
    true
  );
}

/**
 * Whether the keyboard is in this composer, its editor in either host, or in
 * nothing. Nothing counts: a dictation's send locks the editor, and Chromium
 * blurs a contenteditable that stops being editable; closing the Expanded
 * Editor moves the editor back to the bar, its caret following a frame later.
 */
function keyboardStayedPut(terminalId: string, view: EditorView): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  if (view.dom.contains(active)) return true;
  return (
    active.closest("[data-hybrid-input-root]")?.getAttribute("data-hybrid-input-root") ===
    terminalId
  );
}

/**
 * For a terminal-first user the hybrid input is for the occasional job, so a
 * send from it hands the keyboard back to the pane's terminal once the
 * terminal has accepted it (#14692). Terminal-first is the pane's home, the
 * same one every arrival at the pane lands on, so the two can't disagree.
 *
 * The claim is taken at the gesture, before a `@diff` fetch or a dictation's
 * wait. A press, a newer focus request, the keyboard going anywhere but a
 * hybrid input, the selection moving on, or the Expanded Editor opening again
 * after it calls the hand-back off. The rest is read when the terminal answers:
 * home, a new draft (any edit since the send's own reset, even one
 * erased again), a dictation started meanwhile, and whether the keyboard is
 * still here. A send that closed the Expanded Editor waits for the dialog to
 * hand the caret back first, or the dialog would undo the hand-back.
 */
export function useSendHandBack({
  terminalId,
  projectId,
  isolated,
  editorViewRef,
  expandedEditorOpeningsRef,
  afterExpandedEditorCloses,
}: UseSendHandBackParams): ClaimSendHandBack {
  const scopeRef = useRef({ terminalId, projectId });
  useEffect(() => {
    scopeRef.current = { terminalId, projectId };
  });

  return useCallback(() => {
    const view = editorViewRef.current;
    if (isolated || !view) return undefined;
    watchFocusMovesAway();
    const epoch = captureFocusEpoch();
    const movesAway = focusMovesAway;
    const openings = expandedEditorOpeningsRef.current;
    const selectedId = usePanelStore.getState().focusedId;
    const sentFrom = { terminalId, projectId };

    return (accepted) => {
      if (!accepted) return;
      // CodeMirror's document is immutable: any edit after this, even one
      // erased again, leaves a different one in its place.
      const resetDoc = view.state.doc;
      const handBack = () => {
        if (selectHomeFocusTarget(useTerminalInputStore.getState()) !== "xterm") return;
        if (!isFocusEpochCurrent(epoch)) return;
        if (focusMovesAway !== movesAway) return;
        if (expandedEditorOpeningsRef.current !== openings) return;
        if (usePanelStore.getState().focusedId !== selectedId) return;
        const scope = scopeRef.current;
        if (scope.terminalId !== sentFrom.terminalId || scope.projectId !== sentFrom.projectId) {
          return;
        }
        if (editorViewRef.current !== view) return;
        if (view.state.doc !== resetDoc || resetDoc.length > 0) return;
        // An outside write (a handoff, a transcript) reaches the store an
        // effect before the editor.
        const draft = useTerminalInputStore
          .getState()
          .getDraftInput(sentFrom.terminalId, sentFrom.projectId);
        if (draft !== "") return;
        if (isVoiceSessionActiveFor(sentFrom.terminalId)) return;
        if (!keyboardStayedPut(sentFrom.terminalId, view)) return;
        requestPaneFocus(sentFrom.terminalId, "xterm");
      };
      accepted.then(
        (ok) => {
          if (ok) afterExpandedEditorCloses(handBack);
        },
        () => {}
      );
    };
  }, [
    isolated,
    editorViewRef,
    expandedEditorOpeningsRef,
    terminalId,
    projectId,
    afterExpandedEditorCloses,
  ]);
}
