import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { useVoiceRecordingStore } from "@/store";
import type { VoiceCorrectionRange } from "@/store/voiceRecordingStore";
import { useDictationRangeStore } from "@/store/dictationRangeStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { insertionSpan, planVoiceWords } from "@/services/voiceInsertion";
import { isHeldBackSession } from "@/services/voiceDraftSend";
import { isActiveVoiceSession } from "@shared/types";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";
import {
  interimWidgetField,
  revealDictationStart,
  setDictationFollow,
  setInterimText,
  setPendingAIRanges,
  setVoiceCaret,
  VOICE_CARET_LEVEL_PROPERTY,
  type InterimPreview,
  type VoiceCaretAt,
  type VoiceCaretPhase,
} from "../inputEditorExtensions";

const NO_RANGES: VoiceCorrectionRange[] = [];
const NOT_DICTATING = { session: null };
// Per level update (about one a frame): about a third of the way to each new reading.
const LEVEL_SMOOTHING = 0.35;

interface UseVoiceDecorationsParams {
  terminalId: string;
  editorViewRef: React.RefObject<EditorView | null>;
}

export function useVoiceDecorations({ terminalId, editorViewRef }: UseVoiceDecorationsParams) {
  const transcriptPhase = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.transcriptPhase ?? "idle"
  );
  const liveText = useVoiceRecordingStore((s) => s.panelBuffers[terminalId]?.liveText ?? "");
  // A spoken rewrite instruction is not prompt text, so it never shows as ghost text.
  const recordingRewrite = useVoiceRecordingStore(
    (s) => s.activeTarget?.panelId === terminalId && s.activeTarget.rewrite !== undefined
  );
  // A session taking words into this draft, until it has drained.
  const dictating = useVoiceRecordingStore(
    (s) =>
      s.activeTarget?.panelId === terminalId &&
      s.activeTarget.rewrite === undefined &&
      isActiveVoiceSession(s.status)
  );
  const correctionRanges = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.correctionRanges ?? NO_RANGES
  );
  const sessionId = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.dictationSessionId ?? null
  );
  const projectId = useVoiceRecordingStore((s) => s.panelBuffers[terminalId]?.projectId);
  const anchor = useDictationRangeStore((s) =>
    sessionId ? s.getAnchor({ sessionId, panelId: terminalId, projectId }) : null
  );
  // How the mic stands for a session writing words into this draft.
  const caretPhase = useVoiceRecordingStore((s): VoiceCaretPhase | null => {
    if (s.activeTarget?.panelId !== terminalId || s.activeTarget.rewrite !== undefined) return null;
    switch (s.status) {
      case "connecting":
      case "recording":
        return s.micSignal === "live" ? "live" : "starting";
      case "reconnecting":
      case "paused":
      case "finishing":
        return "held";
      default:
        return null;
    }
  });
  // Sessions whose cleanup has been shown from the start of its passage.
  const revealedRef = useRef(new Set<string>());

  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;

    const draft = useTerminalInputStore.getState().getDraftInput(terminalId, projectId);
    // Store positions only mean something in the text they were taken in.
    const inStep = view.state.doc.toString() === draft;

    let preview: InterimPreview = { text: "", pos: null };
    if (transcriptPhase === "interim" && liveText.length > 0 && !recordingRewrite) {
      // While the editor and the store disagree (a keystroke on its way to the
      // store), the preview stays where it was, mapped through the typing.
      if (anchor && inStep) {
        // Shown as it will be written, spacing included, where it will go.
        const { change } = planVoiceWords(draft, anchor, liveText);
        preview = { text: change.insert, pos: change.from };
      } else {
        const shown = view.state.field(interimWidgetField, false);
        preview = { text: liveText, pos: anchor ? (shown?.pos ?? null) : null };
      }
    }

    const docLen = view.state.doc.length;
    const pendingRanges = correctionRanges.filter(
      (range) => range.from >= 0 && range.to <= docLen && range.from < range.to
    );
    // A rewrite hides the words under it, so it is only drawn over the text
    // its positions were taken in; until the editor and the store agree, the
    // passage shows as dictated.
    const rewritesHold = pendingRanges.some((range) => range.rewrite) && inStep;
    const shownRanges = pendingRanges.map((range) =>
      range.rewrite &&
      (!rewritesHold || range.rewrite.to <= range.from || range.rewrite.to > range.to)
        ? { from: range.from, to: range.to }
        : range
    );

    // A cleanup beginning shows its passage from the start, once per session,
    // after the dictation it cleans up has stopped.
    const revealed = revealedRef.current;
    if (correctionRanges.length === 0) revealed.clear();
    let revealAt: number | null = null;
    if (!dictating && inStep) {
      for (const range of pendingRanges) {
        if (!range.session || revealed.has(range.session)) continue;
        if (revealAt === null || range.from < revealAt) revealAt = range.from;
      }
      for (const range of pendingRanges) if (range.session) revealed.add(range.session);
    }

    // Where the session's next words go, as `resolveVoiceAnchor` will pick it
    // before the first words fix it. Positions from a store out of step with
    // the editor stay as they were, mapped through the typing.
    let caretAt: VoiceCaretAt | undefined;
    if (anchor) caretAt = inStep ? insertionSpan(draft, anchor).from : undefined;
    else caretAt = sessionId && isHeldBackSession(terminalId, sessionId) ? "end" : "caret";

    view.dispatch({
      effects: [
        setInterimText.of(preview),
        setVoiceCaret.of(
          caretPhase
            ? { phase: caretPhase, ...(caretAt !== undefined ? { at: caretAt } : {}) }
            : { phase: null }
        ),
        setPendingAIRanges.of(shownRanges),
        setDictationFollow.of(
          dictating && sessionId
            ? { session: sessionId, ...(anchor && inStep ? { end: anchor.from } : {}) }
            : NOT_DICTATING
        ),
        ...(revealAt !== null ? [revealDictationStart.of(revealAt)] : []),
      ],
    });
  }, [
    transcriptPhase,
    liveText,
    recordingRewrite,
    dictating,
    caretPhase,
    correctionRanges,
    anchor,
    sessionId,
    terminalId,
    projectId,
    editorViewRef,
  ]);

  // The live caret's opacity follows the voice. Level arrives at frame rate,
  // so it is written straight to the editor, never through React or a
  // transaction, and smoothed so the caret doesn't flicker with every frame.
  // Reduced motion holds it at full, read per update so flipping the
  // preference mid-dictation takes effect at once.
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || caretPhase !== "live") return;
    const dom = view.dom;
    let smooth = useVoiceRecordingStore.getState().audioLevel;
    const write = (level: number) => {
      smooth += (Math.min(1, Math.max(0, level)) - smooth) * LEVEL_SMOOTHING;
      dom.style.setProperty(
        VOICE_CARET_LEVEL_PROPERTY,
        prefersReducedMotion() ? "1" : smooth.toFixed(3)
      );
    };
    write(smooth);
    const unsubscribe = useVoiceRecordingStore.subscribe((state, prev) => {
      if (state.audioLevel !== prev.audioLevel) write(state.audioLevel);
    });
    return () => {
      unsubscribe();
      dom.style.removeProperty(VOICE_CARET_LEVEL_PROPERTY);
    };
  }, [caretPhase, editorViewRef]);
}
