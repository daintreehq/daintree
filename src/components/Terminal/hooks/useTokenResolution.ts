import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { EditorSelection } from "@codemirror/state";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { buildTerminalSendPayload } from "@/lib/terminalInput";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useDictationRangeStore } from "@/store/dictationRangeStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { useDictionaryLearnPromptStore } from "@/store/dictionaryLearnPromptStore";
import { mapSpanKeepingEdits, minimalDocChange } from "@/lib/textRangeMapping";
import type { ActiveCompletionContext } from "../hybridInputParsing";
import { expandDraftContext } from "../draftContextExpansion";

/** A dictated passage as it settled, and the same passage as the user is sending it. */
interface CorrectionSnapshot {
  baseline: string;
  edited: string;
  /** The draft before the passage. */
  preceding: string;
  /** The session that wrote the baseline; a newer one owns whatever replaced it. */
  sessionId: string;
}

/**
 * Where the session's dictated words sit in the text being sent: its record's
 * learning span, which follows every edit, carried onto `text` when the
 * composer is a keystroke ahead of the stored draft. Text typed before, after
 * or around the dictation stays out of it.
 */
function locateDictatedText(
  panelId: string,
  projectId: string | undefined,
  sessionId: string,
  text: string
): { from: number; to: number } | null {
  const span = useDictationRangeStore
    .getState()
    .listDictations(panelId, projectId)
    .find((record) => record.sessionId === sessionId)?.learningSpan;
  if (!span) return null;
  const draft = useTerminalInputStore.getState().getDraftInput(panelId, projectId);
  const change = minimalDocChange(draft, text);
  return change ? mapSpanKeepingEdits(span, change) : span;
}

/**
 * Pairs the panel's learning baseline with the dictated words in the draft
 * being sent. Taken before the send awaits anything: a dictation that finishes
 * meanwhile writes a newer baseline, and this draft must not be diffed against
 * it. A draft under another key (an isolated composer on the same terminal)
 * isn't the one the passage was dictated into, and a session the send doesn't
 * take (`sessions`) dictated words that aren't in it.
 */
function takeCorrectionSnapshot(
  panelId: string,
  projectId: string | undefined,
  text: string,
  sessions: ReadonlySet<string> | undefined
): CorrectionSnapshot | null {
  try {
    const buffer = useVoiceRecordingStore.getState().panelBuffers[panelId];
    const baseline = buffer?.sessionCorrectedText;
    const sessionId = buffer?.dictationSessionId;
    if (!baseline || !sessionId || buffer.projectId !== projectId) return null;
    if (sessions && !sessions.has(sessionId)) return null;
    const span = locateDictatedText(panelId, projectId, sessionId, text);
    if (!span) return null;
    return {
      baseline,
      edited: text.slice(span.from, span.to),
      preceding: text.slice(0, span.from),
      sessionId,
    };
  } catch {
    return null;
  }
}

/**
 * Learn custom-dictionary words from a user's manual corrections to dictated
 * text. Compares the settled transcription baseline (captured after dictation
 * stops) against the final text the user is sending; phonetically-similar
 * substitutions are persisted as suggestions in Voice settings, pending
 * explicit accept/dismiss (#9749). The first new pair is also offered in the
 * composer the text was sent from (#14646).
 *
 * Synchronous store read at the send site (no React subscription — see [[#9441]]).
 * Fully swallows errors: learning must never block or alter the send.
 */
const latestLearnSend = new Map<string, number>();

function detectDictionaryCorrections(panelId: string, snapshot: CorrectionSnapshot | null): void {
  // A later send supersedes a reply still in flight, so it can't offer a stale pair.
  const send = (latestLearnSend.get(panelId) ?? 0) + 1;
  latestLearnSend.set(panelId, send);
  if (!snapshot) return;
  try {
    const voiceState = useVoiceRecordingStore.getState();
    // The draft is gone, so its baseline goes with it whether or not learning
    // is on — unless a newer dictation has already replaced it.
    const buffer = voiceState.panelBuffers[panelId];
    if (
      buffer?.sessionCorrectedText === snapshot.baseline &&
      buffer.dictationSessionId === snapshot.sessionId
    ) {
      voiceState.setSessionCorrectedText(panelId, null);
    }
    if (!voiceState.learnFromCorrections) return;

    // The matcher and its word list load here, off the send path. Main merges
    // the candidates into the queue it owns, so an accept or dismiss made
    // meanwhile in Settings isn't overwritten by this view's copy.
    const report = async () => {
      try {
        const { findCorrectionCandidates } = await import("@shared/utils/phoneticSimilarity");
        const candidates = findCorrectionCandidates(
          snapshot.baseline,
          snapshot.edited,
          snapshot.preceding
        );
        if (candidates.length === 0) return;
        const state = await window.electron.voiceDictionary.recordSuggestions({ candidates });
        if (latestLearnSend.get(panelId) !== send) return;
        // Only a pair main kept in the queue is offered: one already in the
        // dictionary or dismissed earlier never reaches it.
        for (const candidate of candidates) {
          const original = candidate.original.trim();
          const queued = state.suggestedDictionary.find(
            (entry) =>
              entry.word.toLowerCase() === candidate.word.trim().toLowerCase() &&
              entry.utterance === original
          );
          if (queued) {
            useDictionaryLearnPromptStore
              .getState()
              .offer(panelId, { word: queued.word, utterance: queued.utterance });
            return;
          }
        }
      } catch {
        // Best-effort; never surface a learning failure to the user.
      }
    };
    void report();
  } catch {
    // Never let learning interfere with sending.
  }
}

interface LatestRefShape {
  terminalId: string;
  projectId?: string;
  disabled: boolean;
  value: string;
  onSend: (payload: {
    data: string;
    trackerData: string;
    text: string;
    imagePaths?: string[];
  }) => void | Promise<boolean>;
  addToHistory: (terminalId: string, command: string, projectId?: string) => void;
  resetHistoryIndex: (terminalId: string, projectId?: string) => void;
  clearDraftInput: (terminalId: string, projectId?: string) => void;
}

export interface SendTextOptions {
  /**
   * Turn the resolved draft into the exact text to submit. Applied *after*
   * token resolution so anything appended here reaches the terminal verbatim —
   * a directory path that happens to contain something shaped like an @-token
   * must not be rewritten into a diff.
   */
  compose?: (resolvedDraft: string) => string;
  /**
   * Replaces the pane's fire-and-forget `onSend` handoff with a submission that
   * reports whether the terminal accepted the text. The editor, the draft store
   * and the history are committed only when it resolves `true`, so a caller
   * that surfaces failure can retry without the draft having been eaten
   * (#11867).
   */
  submit?: (text: string) => Promise<boolean>;
  /**
   * Absolute paths of the draft's image chips, in document order (#12792).
   * Each is also in the text; the pty-host decides whether the agent takes it
   * as an attachment. Ignored when `submit` replaces the pane's handoff.
   */
  imagePaths?: readonly string[];
  /**
   * Consulted just before the editor and the draft store are cleared, on a send
   * that has already succeeded. `false` leaves the draft alone: an awaited
   * `submit` is a window the user can keep typing in, and eating what they
   * wrote in it to tidy up after text that has already gone out is the worse
   * of the two outcomes.
   */
  isDraftUnchanged?: () => boolean;
  /**
   * Leaves the editor and the draft store with what the send held back,
   * instead of clearing them, once `isDraftUnchanged` agrees.
   */
  keepDraft?: () => void;
  /**
   * The dictation sessions whose words a dictated send takes; learning only
   * diffs what one of them dictated.
   */
  dictationSessions?: ReadonlySet<string>;
  /**
   * Handed what the pane's `onSend` returned — a promise of whether the
   * terminal accepted the text, from a host that can say — once the composer
   * has been reset after the send. With `submit`, the terminal has already
   * taken the text by then, and a draft the send left alone hands nothing.
   */
  onHandedOff?: (accepted: Promise<boolean> | void) => void;
}

/**
 * An `isDraftUnchanged` for a send of the draft as it reads now. A send can
 * await — a `@diff` fetch, a targeted submit — and in that window the user can
 * type, and voice, prompt history, file references, type-anywhere and plugin
 * handoffs can append to the draft. Those write the draft store first and reach
 * the editor an effect later, so both are compared: the editor against what was
 * sent, and the store against what it held at send time — or against what was
 * sent, for a store that was a keystroke behind and has since caught up.
 *
 * `externalWritePending` says an outside write had reached the store but not
 * yet the editor when the send began. A store that differs from the editor
 * then is ahead of it, not behind: it holds that write, which was never sent,
 * so the draft is never cleared.
 */
export function draftUnchangedSince(
  readDoc: () => string | undefined,
  readStored: () => string,
  externalWritePending = false
): () => boolean {
  const snapshot = readDoc();
  const storedAtSend = readStored();
  const storeAhead = externalWritePending && storedAtSend !== snapshot;
  return () => {
    if (storeAhead || readDoc() !== snapshot) return false;
    const stored = readStored();
    return stored === storedAtSend || stored === snapshot;
  };
}

interface UseTokenResolutionParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  applyEditorValue: (
    nextValue: string,
    options?: { selection?: EditorSelection; focus?: boolean; resetHistory?: boolean }
  ) => void;
  setIsExpanded: Dispatch<SetStateAction<boolean>>;
  setActiveCompletionContext: Dispatch<SetStateAction<ActiveCompletionContext | null>>;
  terminalId: string;
  /**
   * Where dictation into this composer is kept, when not under the terminal
   * (Canopy's reply): its target's id and project, which address the same draft.
   */
  voice?: { panelId: string; projectId?: string };
  cwd: string;
  agentId?: BuiltInAgentId;
  /**
   * Expand `@terminal`, `@selection`, `@diff` and plugin context references
   * into what they name here. Off for a terminal on another host, where this
   * machine's screens, working tree and plugins are not the agent's: the
   * tokens go as typed.
   */
  expandContext?: boolean;
}

export function useTokenResolution({
  latestRef,
  applyEditorValue,
  setIsExpanded,
  setActiveCompletionContext,
  terminalId,
  voice,
  cwd,
  agentId,
  expandContext = true,
}: UseTokenResolutionParams) {
  const ownVoice = voice !== undefined;
  const voiceId = voice?.panelId ?? terminalId;
  const voiceProjectId = voice?.projectId;
  const isSendingRef = useRef(false);

  /**
   * Returns whether the text actually reached the terminal. Every bail-out is
   * `false`: callers that only mirror the user's Enter can keep ignoring it,
   * but a caller that has to tell the user whether their click landed cannot
   * work with a silent void (#11867).
   */
  const sendText = useCallback(
    async (text: string, options?: SendTextOptions): Promise<boolean> => {
      const latest = latestRef.current;
      if (!latest || latest.disabled) return false;
      if (isSendingRef.current) return false;

      // Held across the whole transaction, not just the diff fetch it used to
      // guard: an awaited `submit` is another window in which a second send
      // could otherwise interleave and double-post.
      isSendingRef.current = true;
      try {
        const correctionSnapshot = takeCorrectionSnapshot(
          voiceId,
          ownVoice ? voiceProjectId : latest.projectId,
          text,
          options?.dictationSessions
        );
        const resolvedText = expandContext
          ? await expandDraftContext(text, { terminalId, cwd })
          : text;

        const outgoing = options?.compose ? options.compose(resolvedText) : resolvedText;
        // Checked on the composed result rather than the raw draft: an empty
        // draft is a perfectly good send once an instruction has been appended.
        if (outgoing.trim().length === 0) return false;

        let accepted: Promise<boolean> | void = undefined;
        if (options?.submit) {
          // Nothing below this line runs on a refused submission — the draft the
          // user can still see is the draft they still have.
          if (!(await options.submit(outgoing))) return false;
        } else {
          const payload = buildTerminalSendPayload(outgoing);
          accepted = latest.onSend({
            data: payload.data,
            trackerData: payload.trackerData,
            text: outgoing,
            ...(options?.imagePaths !== undefined && options.imagePaths.length > 0
              ? { imagePaths: [...options.imagePaths] }
              : {}),
          });
        }

        // Learn dictionary words from manual corrections to dictated text. Uses
        // the original `text` (the human-authored content), not `resolvedText`
        // (which has @-token expansions spliced in).
        detectDictionaryCorrections(voiceId, correctionSnapshot);

        // History keeps what the human authored, so recalling it re-runs the
        // tokens rather than a frozen expansion — composed the same way, because
        // the instruction was part of what was sent.
        const authored = options?.compose ? options.compose(text) : text;
        latest.addToHistory(latest.terminalId, authored, latest.projectId);
        // Apart from recall history, which reorders repeats: cleanup reads the
        // sends to this terminal in the order they went, so this one is noted
        // as it goes and taken back if the terminal turns it down.
        const destination = latest.terminalId;
        const sent = useTerminalInputStore.getState().recordSentPrompt(destination, authored);
        if (sent && accepted instanceof Promise) {
          const retract = () =>
            useTerminalInputStore.getState().retractSentPrompt(destination, sent);
          void accepted.then((ok) => {
            if (!ok) retract();
          }, retract);
        }
        latest.resetHistoryIndex(latest.terminalId, latest.projectId);
        if (latest.projectId) {
          useCommandHistoryStore
            .getState()
            .recordPrompt(latest.projectId, authored, agentId ?? null);
        }

        // The whole composer reset is one decision: if the draft is newer than
        // what went out, collapsing it and closing the completion the user has
        // since opened would be the same overreach as deleting their text.
        const reset = options?.isDraftUnchanged?.() ?? true;
        if (reset) {
          setIsExpanded(false);
          if (options?.keepDraft) {
            options.keepDraft();
          } else {
            applyEditorValue("", {
              selection: EditorSelection.create([EditorSelection.cursor(0)]),
              resetHistory: true,
            });
            latest.clearDraftInput(latest.terminalId, latest.projectId);
          }
          setActiveCompletionContext(null);
        }
        if (!options?.submit) options?.onHandedOff?.(accepted);
        else if (reset) options.onHandedOff?.(Promise.resolve(true));
        return true;
      } finally {
        isSendingRef.current = false;
      }
    },
    [
      applyEditorValue,
      agentId,
      cwd,
      expandContext,
      terminalId,
      voiceId,
      voiceProjectId,
      ownVoice,
      latestRef,
      setActiveCompletionContext,
      setIsExpanded,
    ]
  );

  return { sendText };
}
