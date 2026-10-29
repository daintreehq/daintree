import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { FocusEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  useDictionaryLearnPromptStore,
  type DictionaryLearnPrompt as LearnOffer,
} from "@/store/dictionaryLearnPromptStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { logWarn } from "@/utils/logger";

const PROMPT_VISIBLE_MS = 8_000;

type Answer = "acceptSuggestion" | "dismissSuggestion";

/** What the line is doing for the offer it shows. A new offer starts from idle. */
interface LineState {
  offer: LearnOffer | undefined;
  /** The answer being saved, or the one that failed to save. */
  answer: Answer | null;
  failed: boolean;
  hovered: boolean;
  focused: boolean;
}

const idleFor = (offer: LearnOffer | undefined): LineState => ({
  offer,
  answer: null,
  failed: false,
  hovered: false,
  focused: false,
});

interface DictionaryLearnPromptProps {
  terminalId: string;
  projectId?: string;
  /** Takes the keyboard back to the composer when the line goes while it had focus. */
  onReturnFocus?: () => void;
}

/**
 * The offer to learn a word, shown in the composer a send corrected a
 * mishearing in. Quiet by design: it clears on the next keystroke or after a
 * few seconds, and never raises a toast. The seconds only run while the
 * pointer and the keyboard are elsewhere, and an answer stays on the line
 * until it is saved, so a failed one says so and can be tried again.
 */
export function DictionaryLearnPrompt({
  terminalId,
  projectId,
  onReturnFocus,
}: DictionaryLearnPromptProps) {
  const prompt = useDictionaryLearnPromptStore((s) => s.prompts.get(terminalId));
  const hasDraft = useTerminalInputStore((s) => s.getDraftInput(terminalId, projectId) !== "");
  const rootRef = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState<LineState>(() => idleFor(prompt));
  const current = line.offer === prompt ? line : idleFor(prompt);
  const saving = current.answer !== null && !current.failed;
  const failedAnswer = current.failed ? current.answer : null;

  const adopt = (patch: Partial<LineState>) =>
    setLine((prev) => ({ ...(prev.offer === prompt ? prev : idleFor(prompt)), ...patch }));

  const dismiss = (offer: LearnOffer) => {
    const store = useDictionaryLearnPromptStore.getState();
    if (store.prompts.get(terminalId) !== offer) return;
    const hadFocus = rootRef.current?.contains(document.activeElement) ?? false;
    store.clear(terminalId, offer);
    if (hadFocus) onReturnFocus?.();
  };
  // The timer must not restart whenever the composer hands a new callback down.
  const expire = useEffectEvent((offer: LearnOffer) => dismiss(offer));

  useEffect(() => {
    if (prompt && hasDraft && !saving) useDictionaryLearnPromptStore.getState().clear(terminalId);
  }, [prompt, hasDraft, saving, terminalId]);

  const expires =
    Boolean(prompt) && current.answer === null && !current.hovered && !current.focused;
  useEffect(() => {
    if (!prompt || !expires) return;
    const timer = setTimeout(() => expire(prompt), PROMPT_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [prompt, expires]);

  if (!prompt) return null;

  const resolve = (answer: Answer) => {
    if (saving) return;
    const offer = prompt;
    adopt({ answer, failed: false });
    window.electron.voiceDictionary[answer]({
      word: offer.word,
      utterance: offer.utterance,
    }).then(
      () => dismiss(offer),
      (err: unknown) => {
        logWarn("Failed to answer the dictionary prompt", {
          message: formatErrorMessage(err, "Failed to answer the dictionary prompt"),
        });
        setLine((prev) => (prev.offer === offer ? { ...prev, failed: true } : prev));
      }
    );
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    adopt({ focused: false });
  };

  return (
    <div
      ref={rootRef}
      role="status"
      aria-live="polite"
      className="mb-1 flex items-center gap-2 px-1 text-xs text-text-secondary"
      onPointerEnter={() => adopt({ hovered: true })}
      onPointerLeave={() => adopt({ hovered: false })}
      onFocus={() => adopt({ focused: true })}
      onBlur={onBlur}
    >
      {failedAnswer ? (
        <>
          <span className="min-w-0 flex-1 truncate text-status-error">
            Couldn&apos;t {failedAnswer === "acceptSuggestion" ? "add" : "dismiss"} &ldquo;
            {prompt.word}&rdquo;
          </span>
          <Button size="xs" variant="ghost" onClick={() => resolve(failedAnswer)}>
            Retry
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">
            Learn &ldquo;{prompt.word}&rdquo;
            {prompt.utterance ? <> for &ldquo;{prompt.utterance}&rdquo;</> : null}?
          </span>
          <Button
            size="xs"
            variant="ghost"
            loading={current.answer === "acceptSuggestion"}
            disabled={saving && current.answer !== "acceptSuggestion"}
            onClick={() => resolve("acceptSuggestion")}
          >
            Add
          </Button>
          <Button
            size="xs"
            variant="ghost"
            loading={current.answer === "dismissSuggestion"}
            disabled={saving && current.answer !== "dismissSuggestion"}
            onClick={() => resolve("dismissSuggestion")}
          >
            Dismiss
          </Button>
        </>
      )}
    </div>
  );
}
