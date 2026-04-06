import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import { EditorSelection } from "@codemirror/state";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { buildTerminalSendPayload } from "@/lib/terminalInput";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useVoiceRecordingStore } from "@/store";
import {
  getAllAtTerminalTokens,
  getAllAtSelectionTokens,
  getAllAtDiffTokens,
  type DiffContextType,
} from "../hybridInputParsing";
import type {
  AtFileContext,
  SlashCommandContext,
  AtDiffContext,
  AtTerminalContext,
  AtSelectionContext,
} from "../hybridInputParsing";

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

interface UseTokenResolutionParams {
  latestRef: React.RefObject<LatestRefShape | null>;
  applyEditorValue: (
    nextValue: string,
    options?: { selection?: EditorSelection; focus?: boolean }
  ) => void;
  setIsExpanded: Dispatch<SetStateAction<boolean>>;
  setAtContext: Dispatch<SetStateAction<AtFileContext | null>>;
  setSlashContext: Dispatch<SetStateAction<SlashCommandContext | null>>;
  setDiffContext: Dispatch<SetStateAction<AtDiffContext | null>>;
  setTerminalContext: Dispatch<SetStateAction<AtTerminalContext | null>>;
  setSelectionContext: Dispatch<SetStateAction<AtSelectionContext | null>>;
  terminalId: string;
  cwd: string;
  agentId?: BuiltInAgentId;
}

export function useTokenResolution({
  latestRef,
  applyEditorValue,
  setIsExpanded,
  setAtContext,
  setSlashContext,
  setDiffContext,
  setTerminalContext,
  setSelectionContext,
  terminalId,
  cwd,
  agentId,
}: UseTokenResolutionParams) {
  const isSendingRef = useRef(false);

  const sendText = useCallback(
    async (text: string) => {
      const latest = latestRef.current;
      if (!latest || latest.disabled) return;
      if (text.trim().length === 0) return;
      if (isSendingRef.current) return;

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

      if (diffTokens.length > 0) {
        isSendingRef.current = true;
        try {
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
              const msg = err instanceof Error ? err.message : String(err);
              replacement = `[Error fetching diff: ${msg}]`;
            }
            replacements.push({ start: token.start, end: token.end, replacement });
          }
        } finally {
          isSendingRef.current = false;
        }
      }

      if (replacements.length > 0) {
        replacements.sort((a, b) => b.start - a.start);
        for (const r of replacements) {
          resolvedText = resolvedText.slice(0, r.start) + r.replacement + resolvedText.slice(r.end);
        }
      }

      const payload = buildTerminalSendPayload(resolvedText);
      latest.onSend({ data: payload.data, trackerData: payload.trackerData, text: resolvedText });
      latest.addToHistory(latest.terminalId, text, latest.projectId);
      latest.resetHistoryIndex(latest.terminalId, latest.projectId);
      if (latest.projectId) {
        useCommandHistoryStore.getState().recordPrompt(latest.projectId, text, agentId ?? null);
      }

      setIsExpanded(false);
      applyEditorValue("", { selection: EditorSelection.create([EditorSelection.cursor(0)]) });
      latest.clearDraftInput(latest.terminalId, latest.projectId);
      useVoiceRecordingStore.getState().clearAICorrectionSpans(latest.terminalId);
      setAtContext(null);
      setSlashContext(null);
      setDiffContext(null);
      setTerminalContext(null);
      setSelectionContext(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refs are stable
    [applyEditorValue, agentId, cwd, terminalId]
  );

  return { sendText };
}
