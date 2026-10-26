import { useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useDictionaryLearnPromptStore } from "@/store/dictionaryLearnPromptStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logWarn } from "@/utils/logger";

const PROMPT_VISIBLE_MS = 8_000;

interface DictionaryLearnPromptProps {
  terminalId: string;
  projectId?: string;
}

/**
 * The offer to learn a word, shown in the composer a send corrected a
 * mishearing in. Quiet by design: it clears on the next keystroke or after a
 * few seconds, and never raises a toast.
 */
export function DictionaryLearnPrompt({ terminalId, projectId }: DictionaryLearnPromptProps) {
  const prompt = useDictionaryLearnPromptStore((s) => s.prompts.get(terminalId));
  const hasDraft = useTerminalInputStore((s) => s.getDraftInput(terminalId, projectId) !== "");
  const clear = useCallback(
    () => useDictionaryLearnPromptStore.getState().clear(terminalId),
    [terminalId]
  );

  useEffect(() => {
    if (prompt && hasDraft) clear();
  }, [prompt, hasDraft, clear]);

  useEffect(() => {
    if (!prompt) return;
    const timer = setTimeout(clear, PROMPT_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [prompt, clear]);

  if (!prompt) return null;

  const resolve = (action: "acceptSuggestion" | "dismissSuggestion") => {
    clear();
    window.electron.voiceDictionary[action]({ word: prompt.word }).catch((err: unknown) => {
      logWarn("Failed to answer the dictionary prompt", {
        message: formatErrorMessage(err, "Failed to answer the dictionary prompt"),
      });
    });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-1 flex items-center gap-2 px-1 text-xs text-text-secondary"
    >
      <span className="min-w-0 flex-1 truncate">
        Learn &ldquo;{prompt.word}&rdquo;
        {prompt.utterance ? <> for &ldquo;{prompt.utterance}&rdquo;</> : null}?
      </span>
      <Button size="xs" variant="ghost" onClick={() => resolve("acceptSuggestion")}>
        Add
      </Button>
      <Button size="xs" variant="ghost" onClick={() => resolve("dismissSuggestion")}>
        Dismiss
      </Button>
    </div>
  );
}
