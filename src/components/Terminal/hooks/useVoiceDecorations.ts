import { useEffect, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { useVoiceRecordingStore } from "@/store";
import type { VoiceCorrectionRange } from "@/store/voiceRecordingStore";
import { useDictationRangeStore } from "@/store/dictationRangeStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { insertionSpan, planVoiceWords } from "@/services/voiceInsertion";
import { isHeldBackSession } from "@/services/voiceDraftSend";
import { isActiveVoiceSession } from "@shared/types";
import {
  interimWidgetField,
  revealDictationStart,
  setDictationFollow,
  setInterimText,
  setPendingAIRanges,
  requestVoiceCaret,
  VOICE_CARET_LEVEL_PROPERTY,
  type InterimPreview,
  type VoiceCaretAt,
  type VoiceCaretPhase,
} from "../inputEditorExtensions";

const NO_RANGES: VoiceCorrectionRange[] = [];
const NOT_DICTATING = { session: null };

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
  // Another screen took control of this draft: the session's words go to
  // Recent dictations, so none of them show here (#15919).
  const detached = useVoiceRecordingStore((s) => {
    const id = s.panelBuffers[terminalId]?.dictationSessionId;
    return id != null && s.draftDetachedSessionId === id;
  });
  // A session taking words into this draft, until it has drained.
  const dictating =
    useVoiceRecordingStore(
      (s) =>
        s.activeTarget?.panelId === terminalId &&
        s.activeTarget.rewrite === undefined &&
        isActiveVoiceSession(s.status)
    ) && !detached;
  const correctionRanges = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.correctionRanges ?? NO_RANGES
  );
  const sessionId = useVoiceRecordingStore(
    (s) => s.panelBuffers[terminalId]?.dictationSessionId ?? null
  );
  const projectId = useVoiceRecordingStore((s) => s.panelBuffers[terminalId]?.projectId);
  // Only says when the anchor moved: the pass below reads it with the draft.
  const anchorSeen = useDictationRangeStore((s) =>
    sessionId ? s.getAnchor({ sessionId, panelId: terminalId, projectId }) : null
  );
  // How the mic stands for a session writing words into this draft.
  const caretPhase = useVoiceRecordingStore((s): VoiceCaretPhase | null => {
    if (s.activeTarget?.panelId !== terminalId || s.activeTarget.rewrite !== undefined) return null;
    const id = s.panelBuffers[terminalId]?.dictationSessionId;
    if (id != null && s.draftDetachedSessionId === id) return null;
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
    // Store positions only mean something in the text they were taken in, so
    // the anchor is read with the draft: one from the render can predate a
    // send that has emptied both since, and point into the words it took
    // (#15716).
    const anchor = sessionId
      ? useDictationRangeStore.getState().getAnchor({ sessionId, panelId: terminalId, projectId })
      : null;
    const inStep = view.state.doc.toString() === draft;

    let preview: InterimPreview = { text: "", pos: null };
    if (transcriptPhase === "interim" && liveText.length > 0 && !recordingRewrite && !detached) {
      // While the editor and the store disagree (a keystroke on its way to the
      // store), the preview stays where it was, mapped through the typing.
      if (anchor && inStep) {
        // Shown as it will be written, spacing included, where it will go.
        const { change, separatorAfter } = planVoiceWords(draft, anchor, liveText);
        const trailLength = separatorAfter ? separatorAfter.to - separatorAfter.from : 0;
        const wordsEnd = change.insert.length - trailLength;
        preview = {
          text: change.insert.slice(0, wordsEnd),
          pos: change.from,
          ...(trailLength > 0 ? { trail: change.insert.slice(wordsEnd) } : {}),
        };
      } else {
        const shown = view.state.field(interimWidgetField, false);
        if (anchor && shown?.text) {
          // Keeps the spacing it was planned with, so the words around it
          // don't close up and part again around a keystroke.
          const leading = /^\s*/.exec(shown.text)?.[0] ?? "";
          preview = {
            text: /^\s/.test(liveText) ? liveText : leading + liveText,
            pos: shown.pos,
            ...(shown.trail ? { trail: shown.trail } : {}),
          };
        } else {
          preview = { text: liveText, pos: anchor ? (shown?.pos ?? null) : null };
        }
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
        requestVoiceCaret(
          view,
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
    detached,
    dictating,
    caretPhase,
    correctionRanges,
    anchorSeen,
    sessionId,
    terminalId,
    projectId,
    editorViewRef,
  ]);

  // The live caret's opacity follows the voice. Level arrives at frame rate,
  // so it is written straight to the editor, never through React or a
  // transaction.
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || caretPhase !== "live") return;
    const dom = view.dom;
    const write = (level: number) => {
      const shown = Math.min(1, Math.max(0, level));
      dom.style.setProperty(VOICE_CARET_LEVEL_PROPERTY, shown.toFixed(3));
    };
    write(useVoiceRecordingStore.getState().audioLevel);
    const unsubscribe = useVoiceRecordingStore.subscribe((state, prev) => {
      if (state.audioLevel !== prev.audioLevel) write(state.audioLevel);
    });
    return () => {
      unsubscribe();
      dom.style.removeProperty(VOICE_CARET_LEVEL_PROPERTY);
    };
  }, [caretPhase, editorViewRef]);
}
