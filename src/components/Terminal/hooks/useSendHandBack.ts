import { useCallback, useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { usePanelStore } from "@/store/panelStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { captureFocusEpoch, isFocusEpochCurrent, requestPaneFocus } from "../paneFocusRequest";
import { isVoiceSessionActiveFor } from "./useVoiceWaitSubmit";
import type { SendTextOptions } from "./useTokenResolution";

/** Told what the pane's `onSend` returned, once the composer has been reset after the send. */
export type SendHandBack = NonNullable<SendTextOptions["onHandedOff"]>;

export interface SendHandBackClaim {
  /**
   * The send itself takes the editor's focus for a while: a dictation's lock
   * makes it non-editable, which Chromium blurs, and closing the Expanded
   * Editor moves it back to the bar. The keyboard landing nowhere is then the
   * send's doing, not the user's.
   */
  blursEditor?: boolean;
}

export type ClaimSendHandBack = (claim?: SendHandBackClaim) => SendHandBack | undefined;

interface UseSendHandBackParams {
  terminalId: string;
  projectId?: string;
  isolated: boolean;
  editorViewRef: React.RefObject<EditorView | null>;
  /** Runs `handBack` once an open or closing Expanded Editor has handed the caret back. */
  afterExpandedEditorCloses: (handBack: () => void) => void;
}

function keyboardStayedPut(terminalId: string, view: EditorView, blursEditor: boolean): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return blursEditor;
  // The editor itself, in the bar or the Expanded Editor, or anything else of this bar's.
  if (view.dom.contains(active)) return true;
  return (
    active.closest("[data-hybrid-input-root]")?.getAttribute("data-hybrid-input-root") ===
    terminalId
  );
}

/**
 * For a terminal-first user the hybrid input is for the occasional job, so a
 * send from it hands the keyboard back to the pane's terminal once the
 * terminal has accepted it (#14692).
 *
 * The claim is taken at the gesture, before a `@diff` fetch or a dictation's
 * wait: a press or a newer focus request after it calls the hand-back off, as
 * does the selection moving on. The rest is read when the terminal answers —
 * the setting, a new draft (any edit since the send's own reset, even one
 * erased again), a dictation started meanwhile, and whether the keyboard is
 * still in this composer. A send that closed the Expanded Editor waits for the
 * dialog to hand the caret back first, or the dialog would undo the hand-back.
 */
export function useSendHandBack({
  terminalId,
  projectId,
  isolated,
  editorViewRef,
  afterExpandedEditorCloses,
}: UseSendHandBackParams): ClaimSendHandBack {
  const scopeRef = useRef({ terminalId, projectId });
  useEffect(() => {
    scopeRef.current = { terminalId, projectId };
  });

  return useCallback(
    (claim) => {
      const view = editorViewRef.current;
      if (isolated || !view) return undefined;
      const epoch = captureFocusEpoch();
      const selectedId = usePanelStore.getState().focusedId;
      const sentFrom = { terminalId, projectId };
      const blursEditor = claim?.blursEditor ?? false;

      return (accepted) => {
        if (!accepted) return;
        // CodeMirror's document is immutable: any edit after this, even one
        // erased again, leaves a different one in its place.
        const resetDoc = view.state.doc;
        const handBack = () => {
          if (useTerminalInputStore.getState().hybridInputAutoFocus) return;
          if (!isFocusEpochCurrent(epoch)) return;
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
          if (!keyboardStayedPut(sentFrom.terminalId, view, blursEditor)) return;
          requestPaneFocus(sentFrom.terminalId, "xterm");
        };
        accepted.then(
          (ok) => {
            if (ok) afterExpandedEditorCloses(handBack);
          },
          () => {}
        );
      };
    },
    [isolated, editorViewRef, terminalId, projectId, afterExpandedEditorCloses]
  );
}
