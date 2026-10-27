import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState, Prec, type Compartment, type Extension } from "@codemirror/state";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useVoiceRecordingStore } from "@/store";
import type { VoiceRecordingTarget } from "@/store/voiceRecordingStore";
import { useProjectStore } from "@/store/projectStore";
import { usePanelStore } from "@/store/panelStore";
import { takeLandedCorrection } from "@/services/voiceCorrectionLanding";
import { minimalDocChange } from "@/lib/textRangeMapping";
import {
  outsideDraftWrite,
  selectionAfterOutsideWrite,
} from "../inputEditorExtensions/composerHistory";
import { takePendingComposerSelection } from "@/lib/composerCaret";
import { makeDraftKey } from "@/lib/draftKey";
import { replayLandedCorrection } from "../inputEditorExtensions/correctionReview";
import { voiceRecordingService } from "@/services/VoiceRecordingService";
import { isSpokenSendable } from "@/services/voiceSpokenSend";
import { claimVoiceWaitKeys } from "@/lib/voiceWaitKeys";
import type { ClaimSendHandBack, SendHandBack } from "./useSendHandBack";

/** What a voice send is waiting on: the transcript draining, or its correction. */
export type VoiceSubmitPhase = "finishing" | "polishing";

/**
 * The wait as the composer draws it, on the `performance.now()` clock. A
 * correction's wait has no deadline: it lasts until the correction lands or
 * fails, or a second Enter sends what stands (#14780). `expectedAt` is when
 * past corrections say it should land (null: no estimate).
 */
export type VoiceSubmitWait = { attempt: number; startedAt: number } & (
  { phase: "finishing" } | { phase: "polishing"; expectedAt: number | null }
);

/**
 * How the last wait ended: sent, called off by Escape, or held back unsent;
 * `sending` while the composer is still handing the text over.
 */
export interface VoiceSubmitOutcome {
  kind: "sending" | "sent" | "cancelled" | "held";
  attempt: number;
}

interface UseVoiceWaitSubmitParams {
  terminalId: string;
  /**
   * The composer's draft scope. An isolated composer's is its own, not the
   * current project's; left out, the current project's.
   */
  projectId?: string;
  /**
   * Where dictation into this composer is kept, when not under the terminal
   * (Canopy's reply): its target's id and project, which address the same draft.
   */
  voice?: Pick<VoiceRecordingTarget, "panelId" | "projectId">;
  editorViewRef: React.RefObject<EditorView | null>;
  editableCompartmentRef: React.RefObject<Compartment>;
  /**
   * Whether it took the draft, or a promise of it while an expansion or a
   * submission is awaited; a send held back (an upload still going) did not.
   */
  sendFromEditor: (handBack?: SendHandBack) => boolean | Promise<boolean> | void;
  /**
   * Claims the keyboard's hand-back for the send at the Enter that starts the
   * wait, not when the wait ends: a press during it calls the hand-back off.
   */
  claimSendHandBack?: ClaimSendHandBack;
  /** A disabled composer ignores a spoken "send it" the way it ignores Enter. */
  isDisabled?: () => boolean;
}

interface VoiceWaitSubmitOptions {
  /** Sent by a spoken "send it": a draft too short to be a prompt stays unsent. */
  spoken?: boolean;
}

const isCopyOrSelectAll = (event: KeyboardEvent) =>
  (event.metaKey || event.ctrlKey) && !event.altKey && (event.key === "c" || event.key === "a");

const refuse = (event: Event) => {
  event.preventDefault();
  return true;
};

/**
 * The editor while a voice send waits: nothing edits it, and it keeps the
 * keyboard. Turning `editable` off alone drops `contenteditable`, and
 * Chromium then moves focus to the body, so the composer has lost the
 * keyboard by the time the send goes. Enter and Escape belong to the wait
 * (`claimVoiceWaitKeys` takes them at the window first); every other key but
 * copy is refused before the composer's own bindings see it, so nothing can
 * stash, recall or edit the draft mid-send.
 */
const LOCKED_FOR_SEND: Extension = [
  EditorView.editable.of(false),
  EditorState.readOnly.of(true),
  EditorView.contentAttributes.of({ tabindex: "-1" }),
  // A blinking caret would say the draft still takes typing.
  EditorView.theme({ ".cm-cursorLayer": { display: "none" } }),
  Prec.highest(
    keymap.of([{ any: (_view, event) => event.key !== "Escape" && !isCopyOrSelectAll(event) }])
  ),
  Prec.highest(EditorView.domEventHandlers({ paste: refuse, cut: refuse, drop: refuse })),
];

/**
 * Lifting the lock drops `tabindex` before `contenteditable` comes back, and
 * Chromium takes focus off the editor in between, so an editor that had the
 * keyboard gets it back, unless the caller hands it back itself (`refocus`
 * off). One that didn't (the send's hand-back already moved it to the
 * terminal) is left alone.
 */
function unlockAfterSend(view: EditorView, compartment: Compartment, refocus = true): void {
  const hadFocus = view.hasFocus;
  view.dispatch({ effects: compartment.reconfigure(EditorView.editable.of(true)) });
  if (refocus && hadFocus && !view.hasFocus) view.focus();
}

export function isVoiceSessionActiveFor(panelId: string): boolean {
  const voiceState = useVoiceRecordingStore.getState();
  return (
    voiceState.activeTarget?.panelId === panelId &&
    (voiceState.status === "recording" ||
      voiceState.status === "connecting" ||
      voiceState.status === "paused" ||
      voiceState.status === "reconnecting" ||
      voiceState.status === "finishing")
  );
}

export function useVoiceWaitSubmit({
  terminalId,
  projectId,
  voice,
  editorViewRef,
  editableCompartmentRef,
  sendFromEditor,
  claimSendHandBack,
  isDisabled,
}: UseVoiceWaitSubmitParams) {
  const ownVoice = voice !== undefined;
  const voiceId = voice?.panelId ?? terminalId;
  const voiceProjectId = voice ? voice.projectId : projectId;
  const sendFromEditorRef = useRef(sendFromEditor);
  const isDisabledRef = useRef(isDisabled);
  useEffect(() => {
    sendFromEditorRef.current = sendFromEditor;
    isDisabledRef.current = isDisabled;
  }, [sendFromEditor, isDisabled]);
  const claimSendHandBackRef = useRef(claimSendHandBack);
  useEffect(() => {
    claimSendHandBackRef.current = claimSendHandBack;
  }, [claimSendHandBack]);
  const projectIdRef = useRef(projectId);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  // Each Enter is its own attempt, and only the active one may send or unlock
  // the composer: after Escape and a second Enter, the first continuation
  // must do neither under the second.
  const attemptRef = useRef(0);
  const activeAttemptRef = useRef<number | null>(null);
  // The active attempt's way out of its wait, and its hold on Enter and Escape.
  const activeWaitRef = useRef<{ controller: AbortController; releaseKeys: () => void } | null>(
    null
  );
  const [voiceSubmitWait, setVoiceSubmitWait] = useState<VoiceSubmitWait | null>(null);
  const [voiceSubmitOutcome, setVoiceSubmitOutcome] = useState<VoiceSubmitOutcome | null>(null);

  // A composer that unmounts, or moves to another terminal, mid-wait can't
  // send what it no longer shows. The draft, and any correction still on its
  // way to it, stay in the store.
  useEffect(() => {
    return () => {
      if (activeAttemptRef.current === null) return;
      activeAttemptRef.current = null;
      const wait = activeWaitRef.current;
      activeWaitRef.current = null;
      wait?.releaseKeys();
      wait?.controller.abort();
      useTerminalInputStore.getState().setVoiceSubmitting(voiceId, false);
      setVoiceSubmitWait(null);
    };
  }, [voiceId]);

  // Escape cancels the send, not the correction: it still lands in the draft.
  // `deferFocus` leaves handing the keyboard back to the caller.
  const cancelVoiceWaitSubmit = useCallback(
    (options?: { deferFocus?: boolean }) => {
      const store = useTerminalInputStore.getState();
      if (!store.isVoiceSubmitting(voiceId)) return false;
      const attempt = activeAttemptRef.current;
      activeAttemptRef.current = null;
      const wait = activeWaitRef.current;
      activeWaitRef.current = null;
      wait?.releaseKeys();
      wait?.controller.abort();
      store.setVoiceSubmitting(voiceId, false);
      setVoiceSubmitWait(null);
      if (attempt !== null) setVoiceSubmitOutcome({ kind: "cancelled", attempt });
      const view = editorViewRef.current;
      if (view) unlockAfterSend(view, editableCompartmentRef.current, !options?.deferFocus);
      return true;
    },
    [voiceId, editorViewRef, editableCompartmentRef]
  );

  const startVoiceWaitSubmit = useCallback(
    (options?: VoiceWaitSubmitOptions) => {
      const store = useTerminalInputStore.getState();
      if (store.isVoiceSubmitting(voiceId)) return;

      const attempt = ++attemptRef.current;
      activeAttemptRef.current = attempt;
      const isCurrentAttempt = () =>
        activeAttemptRef.current === attempt &&
        useTerminalInputStore.getState().isVoiceSubmitting(voiceId);

      // Before the lock below, so a press during the wait counts against it.
      const handBack = claimSendHandBackRef.current?.();
      store.setVoiceSubmitting(voiceId, true);
      setVoiceSubmitWait({ attempt, phase: "finishing", startedAt: performance.now() });

      // Aborted by a second Enter, the wait ends and the send goes with the
      // text as it stands; by Escape or an unmount, the attempt is over too.
      const controller = new AbortController();
      const releaseKeys = claimVoiceWaitKeys({
        holds: (element) => {
          const view = editorViewRef.current;
          if (view?.dom.contains(element)) return true;
          return (
            element.closest("[data-hybrid-input-root]")?.getAttribute("data-hybrid-input-root") ===
            terminalId
          );
        },
        editor: () => editorViewRef.current?.dom ?? null,
        isSelected: () => usePanelStore.getState().focusedId === terminalId,
        sendNow: () => {
          if (isCurrentAttempt()) controller.abort();
        },
        cancel: () => {
          if (!isCurrentAttempt() || !cancelVoiceWaitSubmit({ deferFocus: true })) return;
          // Lifting the lock took the keyboard off the editor, or it was
          // already nowhere; it goes back to the text the user is now free to
          // edit. On the key's release, not its press: a held Escape's repeats
          // would reach the editor's own Escape, which collapses the Expanded
          // Editor or hands Escape to the agent.
          const refocus = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            window.removeEventListener("keyup", refocus, true);
            const view = editorViewRef.current;
            const active = document.activeElement;
            if (view?.dom.isConnected && (active === null || active === document.body)) {
              view.focus();
            }
          };
          window.addEventListener("keyup", refocus, true);
        },
      });
      activeWaitRef.current = { controller, releaseKeys };

      const view = editorViewRef.current;
      if (view) {
        view.dispatch({
          effects: editableCompartmentRef.current.reconfigure(LOCKED_FOR_SEND),
        });
      }

      void (async () => {
        let sent: boolean | Promise<boolean> = false;
        try {
          if (isVoiceSessionActiveFor(voiceId)) {
            await voiceRecordingService.stop("Submitting command.", {
              preserveLiveText: true,
              announce: false,
              reason: "send",
            });
          }

          if (!isCurrentAttempt()) return;

          // stop() has registered the passage's correction by now. The send
          // waits for it to land or fail, as long as its request takes, unless
          // a second Enter, even one while the transcript was finishing, says
          // to send what stands; the send drops what is still on its way
          // (#14611, #14780).
          if (!controller.signal.aborted && voiceRecordingService.hasPendingCorrection(voiceId)) {
            setVoiceSubmitWait({
              attempt,
              phase: "polishing",
              startedAt: performance.now(),
              expectedAt: voiceRecordingService.expectedCorrectionLanding(voiceId),
            });
            await voiceRecordingService.waitForPendingCorrections(voiceId, controller.signal);
            if (!isCurrentAttempt()) return;
          }

          // `stop()` and a landed correction bump externalDraftRevision after
          // writing the draft store, but HybridInputBar's sync useEffect doesn't
          // fire until the next React render — which is AFTER this microtask.
          // Sync the editor here so sendFromEditor reads the final dictated text
          // and not the pre-stop doc (#9172).
          const projectId = projectIdRef.current ?? useProjectStore.getState().currentProject?.id;
          const draft = useTerminalInputStore.getState().getDraftInput(terminalId, projectId);
          const finalView = editorViewRef.current;
          if (finalView) {
            // The same outside write the sync effect would make, correction
            // included, so a send held back afterwards leaves it undoable.
            const landed = takeLandedCorrection(terminalId, projectId, draft);
            // The caret stays where dictation left it, so a send that's held
            // back doesn't strand it at the end.
            const pending = takePendingComposerSelection(
              makeDraftKey(terminalId, projectId),
              draft
            );
            const change = minimalDocChange(finalView.state.doc.toString(), draft);
            if (change !== null) {
              const selection = selectionAfterOutsideWrite(
                finalView.state,
                finalView.hasFocus,
                change,
                pending
              );
              finalView.dispatch(outsideDraftWrite(change, draft, landed, selection));
            } else {
              if (landed) replayLandedCorrection(finalView, landed);
              if (pending)
                finalView.dispatch({ selection: { anchor: pending.from, head: pending.to } });
            }
          }

          if (options?.spoken && !isSpokenSendable(draft)) return;
          sent = sendFromEditorRef.current(handBack) ?? true;
        } finally {
          releaseKeys();
          if (activeWaitRef.current?.controller === controller) activeWaitRef.current = null;
          if (activeAttemptRef.current === attempt) {
            activeAttemptRef.current = null;
            useTerminalInputStore.getState().setVoiceSubmitting(voiceId, false);
            setVoiceSubmitWait(null);
            if (typeof sent === "boolean") {
              setVoiceSubmitOutcome({ kind: sent ? "sent" : "held", attempt });
            } else {
              setVoiceSubmitOutcome({ kind: "sending", attempt });
              const settle = (went: boolean) => {
                if (attemptRef.current !== attempt) return;
                setVoiceSubmitOutcome({ kind: went ? "sent" : "held", attempt });
              };
              sent.then(settle, () => settle(false));
            }
            const v = editorViewRef.current;
            if (v) unlockAfterSend(v, editableCompartmentRef.current);
          }
        }
      })();
    },
    [terminalId, voiceId, editorViewRef, editableCompartmentRef, cancelVoiceWaitSubmit]
  );

  useEffect(
    () =>
      voiceRecordingService.onSpokenSend(
        voiceId,
        ownVoice
          ? voiceProjectId
          : (voiceProjectId ?? useProjectStore.getState().currentProject?.id),
        () => {
          if (isDisabledRef.current?.()) {
            void voiceRecordingService.stop("Dictation stopped.", { reason: "send" });
            return;
          }
          startVoiceWaitSubmit({ spoken: true });
        }
      ),
    [voiceId, voiceProjectId, ownVoice, startVoiceWaitSubmit]
  );

  // Read at the key press rather than from the last render: a hotkey stop
  // registers its correction before any render shows it.
  const hasPendingVoiceCorrection = useCallback(
    () => voiceRecordingService.hasPendingCorrection(voiceId),
    [voiceId]
  );

  /** A send from the editor that waits for dictation still finishing or being corrected. */
  const submitFromEditor = useCallback(() => {
    if (isVoiceSessionActiveFor(voiceId) || voiceRecordingService.hasPendingCorrection(voiceId)) {
      startVoiceWaitSubmit();
      return;
    }
    void sendFromEditorRef.current();
  }, [voiceId, startVoiceWaitSubmit]);

  return {
    startVoiceWaitSubmit,
    cancelVoiceWaitSubmit,
    hasPendingVoiceCorrection,
    submitFromEditor,
    voiceSubmitPhase: voiceSubmitWait?.phase ?? null,
    voiceSubmitWait,
    voiceSubmitOutcome,
  };
}
