import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { EditorSelection } from "@codemirror/state";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { buildTerminalSendPayload } from "@/lib/terminalInput";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useVoiceRecordingStore } from "@/store/voiceRecordingStore";
import {
  findCorrectionCandidates,
  type CorrectionCandidate,
} from "@shared/utils/phoneticSimilarity";
import type { SuggestedDictionaryEntry } from "@shared/types";
import {
  getAllAtTerminalTokens,
  getAllAtSelectionTokens,
  getAllAtDiffTokens,
  type DiffContextType,
  type ActiveCompletionContext,
} from "../hybridInputParsing";
import { formatErrorMessage } from "@shared/utils/errorMessage";

/** Cap on the pending-suggestions queue — confirmed words live in customDictionary. */
const MAX_SUGGESTED_WORDS = 50;

/**
 * Merge freshly-detected correction candidates into the persisted suggestion
 * queue: skip words already in the confirmed dictionary, bump frequency on a
 * repeat, and cap the queue. Returns null when nothing changed.
 */
function mergeSuggestions(
  candidates: CorrectionCandidate[],
  customDictionary: string[],
  suggested: SuggestedDictionaryEntry[],
  now: number
): SuggestedDictionaryEntry[] | null {
  const confirmed = new Set(customDictionary.map((w) => w.toLowerCase()));
  const next = [...suggested];
  let changed = false;

  for (const { word, original } of candidates) {
    const lower = word.toLowerCase();
    if (confirmed.has(lower)) continue;
    const idx = next.findIndex((e) => e.word.toLowerCase() === lower);
    if (idx >= 0) {
      const entry = next[idx]!;
      next[idx] = {
        ...entry,
        frequency: entry.frequency + 1,
        suggestedAt: now,
        utterance: original,
      };
    } else {
      next.unshift({ word, utterance: original, suggestedAt: now, frequency: 1 });
    }
    changed = true;
  }

  return changed ? next.slice(0, MAX_SUGGESTED_WORDS) : null;
}

/**
 * Learn custom-dictionary words from a user's manual corrections to dictated
 * text. Compares the settled transcription baseline (captured after dictation
 * stops) against the final text the user is sending; phonetically-similar
 * substitutions are persisted as suggestions in Voice settings, pending
 * explicit accept/dismiss (#9749).
 *
 * Synchronous store read at the send site (no React subscription — see [[#9441]]).
 * Fully swallows errors: learning must never block or alter the send.
 */
function detectDictionaryCorrections(panelId: string, finalText: string): void {
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

    // Read-modify-write the suggestion queue via the existing settings channel.
    // The dictate→correct→send flow is human-paced, so concurrent writes to
    // suggestedDictionary don't happen in practice.
    void (async () => {
      try {
        const settings = await window.electron.voiceInput.getSettings();
        if (!settings.learnFromCorrections) return;
        const next = mergeSuggestions(
          candidates,
          settings.customDictionary,
          settings.suggestedDictionary,
          Date.now()
        );
        if (next) {
          await window.electron.voiceInput.setSettings({ suggestedDictionary: next });
        }
      } catch {
        // Best-effort; never surface a learning failure to the user.
      }
    })();
  } catch {
    // Never let learning interfere with sending.
  }
}

interface LatestRefShape {
  terminalId: string;
  projectId?: string;
  disabled: boolean;
  value: string;
  onSend: (payload: { data: string; trackerData: string; text: string }) => void;
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
}

export function useTokenResolution({
  latestRef,
  applyEditorValue,
  setIsExpanded,
  setActiveCompletionContext,
  terminalId,
  cwd,
  agentId,
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
        let resolvedText = text;

        const terminalTokens = getAllAtTerminalTokens(text);
        const selectionTokens = getAllAtSelectionTokens(text);
        const diffTokens = getAllAtDiffTokens(text);

        const replacements: Array<{ start: number; end: number; replacement: string }> = [];

        for (const token of terminalTokens) {
          const managed = terminalInstanceService.get(terminalId);
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
            replacement = content ? "```\n" + content + "\n```" : "[No terminal output]";
          } else {
            replacement = "[Terminal not available]";
          }
          replacements.push({ start: token.start, end: token.end, replacement });
        }

        for (const token of selectionTokens) {
          const selection = terminalInstanceService.getCachedSelection(terminalId);
          const replacement = selection ? "```\n" + selection + "\n```" : "[No terminal selection]";
          replacements.push({ start: token.start, end: token.end, replacement });
        }

        for (const token of diffTokens) {
          let replacement: string;
          try {
            const raw = await window.electron.git.getWorkingDiff(cwd, token.diffType);
            if (raw) {
              replacement = "```diff\n" + raw + "\n```";
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

        if (replacements.length > 0) {
          replacements.sort((a, b) => b.start - a.start);
          for (const r of replacements) {
            resolvedText =
              resolvedText.slice(0, r.start) + r.replacement + resolvedText.slice(r.end);
          }
        }

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
          latest.onSend({ data: payload.data, trackerData: payload.trackerData, text: outgoing });
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

        setIsExpanded(false);
        applyEditorValue("", { selection: EditorSelection.create([EditorSelection.cursor(0)]) });
        latest.clearDraftInput(latest.terminalId, latest.projectId);
        setActiveCompletionContext(null);
        return true;
      } finally {
        isSendingRef.current = false;
      }
    },
    [
      applyEditorValue,
      agentId,
      cwd,
      terminalId,
      latestRef,
      setActiveCompletionContext,
      setIsExpanded,
    ]
  );

  return { sendText };
}
