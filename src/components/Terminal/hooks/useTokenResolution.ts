import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { EditorSelection } from "@codemirror/state";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { peek as peekTerminalService } from "@/services/terminal/terminalInstanceServiceAccessor";
import { buildTerminalSendPayload } from "@/lib/terminalInput";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import { useDictionaryLearnPromptStore } from "@/store/dictionaryLearnPromptStore";
import { findCorrectionCandidates } from "@shared/utils/phoneticSimilarity";
import {
  getAllAtContextReferences,
  getAllAtTerminalTokens,
  getAllAtSelectionTokens,
  getAllAtDiffTokens,
  fenceTokenExpansion,
  resolveTokenExpansions,
  type DiffContextType,
  type ActiveCompletionContext,
  type TokenExpansion,
} from "../hybridInputParsing";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { usePluginContextProvidersStore } from "@/store/pluginContextProvidersStore";
import type {
  ContextReference,
  ContextReferenceResolution,
} from "@shared/types/pluginContextProvider";
import { expandContextReferences } from "../contextReferenceExpansion";

/** The plugin this view believes holds `prefix`, for a placeholder when main can't be asked. */
function activeProviderName(prefix: string): string | undefined {
  return usePluginContextProvidersStore
    .getState()
    .entries.find((entry) => entry.status === "active" && entry.prefix === prefix)?.pluginName;
}

/** Ask main for a draft's references; a bridge without the method answers that nothing is held. */
function resolveContextReferences(
  references: ContextReference[]
): Promise<ContextReferenceResolution[]> {
  const bridge = window.electron?.plugin;
  if (typeof bridge?.resolveContextReferences !== "function") {
    return Promise.resolve(references.map(() => ({ status: "unknown" })));
  }
  return bridge.resolveContextReferences(references);
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

function detectDictionaryCorrections(panelId: string, finalText: string): void {
  // A later send supersedes a reply still in flight, so it can't offer a stale pair.
  const send = (latestLearnSend.get(panelId) ?? 0) + 1;
  latestLearnSend.set(panelId, send);
  try {
    const voiceState = useVoiceRecordingStore.getState();
    if (!voiceState.learnFromCorrections) return;
    const buffer = voiceState.panelBuffers[panelId];
    const baseline = buffer?.sessionCorrectedText;
    const sessionStart = buffer?.sessionDraftStart ?? -1;
    if (!baseline || sessionStart < 0) return;

    // Consume the baseline so a later send of unrelated text can't re-trigger.
    voiceState.setSessionCorrectedText(panelId, null);

    const candidates = findCorrectionCandidates(baseline, finalText.slice(sessionStart));
    if (candidates.length === 0) return;

    // Main merges them into the queue it owns, so an accept or dismiss made
    // meanwhile in Settings isn't overwritten by this view's copy.
    window.electron.voiceDictionary
      .recordSuggestions({ candidates })
      .then((state) => {
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
      })
      .catch(() => {
        // Best-effort; never surface a learning failure to the user.
      });
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
  }) => void;
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
    options?: { selection?: EditorSelection; focus?: boolean }
  ) => void;
  setIsExpanded: Dispatch<SetStateAction<boolean>>;
  setActiveCompletionContext: Dispatch<SetStateAction<ActiveCompletionContext | null>>;
  terminalId: string;
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
  cwd,
  agentId,
  expandContext = true,
}: UseTokenResolutionParams) {
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
        const terminalTokens = expandContext ? getAllAtTerminalTokens(text) : [];
        const selectionTokens = expandContext ? getAllAtSelectionTokens(text) : [];
        const diffTokens = expandContext ? getAllAtDiffTokens(text) : [];
        const contextReferences = expandContext ? getAllAtContextReferences(text) : [];
        // Started first so the plugins answer while the diff is fetched; every
        // reference resolves in parallel under main's deadline.
        const contextExpansions =
          contextReferences.length > 0
            ? expandContextReferences(
                contextReferences,
                resolveContextReferences,
                activeProviderName
              )
            : null;

        const replacements: TokenExpansion[] = [];

        for (const token of terminalTokens) {
          const managed = peekTerminalService()?.get(terminalId);
          let replacement: string;
          if (managed) {
            const buffer = managed.terminal.buffer.active;
            const start = Math.max(0, buffer.length - 100);
            const lines: string[] = [];
            for (let i = start; i < buffer.length; i++) {
              const line = buffer.getLine(i);
              if (line) lines.push(line.translateToString(true));
            }
            const content = lines.join("\n").trimEnd();
            replacement = content ? fenceTokenExpansion(content) : "[No terminal output]";
          } else {
            replacement = "[Terminal not available]";
          }
          replacements.push({ start: token.start, end: token.end, replacement });
        }

        for (const token of selectionTokens) {
          const selection = peekTerminalService()?.getCachedSelection(terminalId);
          const replacement = selection
            ? fenceTokenExpansion(selection)
            : "[No terminal selection]";
          replacements.push({ start: token.start, end: token.end, replacement });
        }

        for (const token of diffTokens) {
          let replacement: string;
          try {
            const raw = await window.electron.git.getWorkingDiff(cwd, token.diffType);
            if (raw) {
              replacement = fenceTokenExpansion(raw, "diff");
            } else {
              const labels: Record<DiffContextType, string> = {
                unstaged: "working tree",
                staged: "staged",
                head: "HEAD",
              };
              replacement = `No ${labels[token.diffType]} changes.`;
            }
          } catch (err) {
            const msg = formatErrorMessage(err, "Failed to fetch diff");
            replacement = `[Error fetching diff: ${msg}]`;
          }
          replacements.push({ start: token.start, end: token.end, replacement });
        }

        if (contextExpansions) replacements.push(...(await contextExpansions));

        const resolvedText = resolveTokenExpansions(text, replacements);

        const outgoing = options?.compose ? options.compose(resolvedText) : resolvedText;
        // Checked on the composed result rather than the raw draft: an empty
        // draft is a perfectly good send once an instruction has been appended.
        if (outgoing.trim().length === 0) return false;

        if (options?.submit) {
          // Nothing below this line runs on a refused submission — the draft the
          // user can still see is the draft they still have.
          if (!(await options.submit(outgoing))) return false;
        } else {
          const payload = buildTerminalSendPayload(outgoing);
          latest.onSend({
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
        detectDictionaryCorrections(terminalId, text);

        // History keeps what the human authored, so recalling it re-runs the
        // tokens rather than a frozen expansion — composed the same way, because
        // the instruction was part of what was sent.
        const authored = options?.compose ? options.compose(text) : text;
        latest.addToHistory(latest.terminalId, authored, latest.projectId);
        latest.resetHistoryIndex(latest.terminalId, latest.projectId);
        if (latest.projectId) {
          useCommandHistoryStore
            .getState()
            .recordPrompt(latest.projectId, authored, agentId ?? null);
        }

        // The whole composer reset is one decision: if the draft is newer than
        // what went out, collapsing it and closing the completion the user has
        // since opened would be the same overreach as deleting their text.
        if (options?.isDraftUnchanged?.() ?? true) {
          setIsExpanded(false);
          applyEditorValue("", { selection: EditorSelection.create([EditorSelection.cursor(0)]) });
          latest.clearDraftInput(latest.terminalId, latest.projectId);
          setActiveCompletionContext(null);
        }
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
      latestRef,
      setActiveCompletionContext,
      setIsExpanded,
    ]
  );

  return { sendText };
}
