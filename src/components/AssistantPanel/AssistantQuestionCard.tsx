import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { AssistantQuestion } from "@/store/assistantStore";

/**
 * The multiple-choice question sheet, ported from the cockpit's own
 * (internal/ui/render_question.go).
 *
 * It REPLACES the composer while a decision is pending, exactly as the terminal
 * version did, because the turn is genuinely blocked: the engine has parked the tool
 * dispatch and will not proceed until this settles. Leaving the composer live beside it
 * would offer a way to type at an assistant that cannot read.
 *
 * Selection follows the original: ↑/↓ (and Home/End) move the highlight, an option
 * LETTER answers directly, Enter takes the highlighted option, Escape dismisses. The
 * letters are assigned by the engine and travel on the wire, so the same option shows
 * the same letter here, in the transcript and in the debug log.
 *
 * Dismissing is a real outcome, not a cancel: the engine reports it to the model as
 * "the user declined to answer" rather than as a broken question surface. There is
 * deliberately no way to answer on the user's behalf.
 */

export interface AssistantQuestionCardProps {
  question: AssistantQuestion;
  /** `index` of -1 dismisses without choosing. */
  onAnswer: (questionId: string, index: number) => void;
}

export function AssistantQuestionCard({ question, onAnswer }: AssistantQuestionCardProps) {
  const [cursor, setCursor] = useState(() =>
    Math.min(Math.max(question.defaultIndex, 0), question.options.length - 1)
  );
  const rootRef = useRef<HTMLDivElement>(null);

  // The sheet takes focus when it appears: it is the only thing that can be acted on,
  // and a keyboard user should not have to hunt for it.
  useEffect(() => {
    rootRef.current?.focus();
  }, [question.questionId]);

  const answer = useCallback(
    (index: number) => onAnswer(question.questionId, index),
    [onAnswer, question.questionId]
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const last = question.options.length - 1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCursor((c) => Math.min(last, c + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setCursor(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setCursor(last);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        answer(cursor);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        answer(-1);
        return;
      }
      // A single printable character answers directly when it names an option letter.
      if (e.key.length === 1) {
        const idx = question.options.findIndex(
          (o) => o.label.toLowerCase() === e.key.toLowerCase()
        );
        if (idx >= 0) {
          e.preventDefault();
          answer(idx);
        }
      }
    },
    [answer, cursor, question.options]
  );

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="group"
      aria-label="Question"
      // This sheet OWNS Escape — it dismisses the question. Without the marker the
      // panel's own Esc-to-close fires as well, hiding the panel while the engine stays
      // parked waiting for an answer that can no longer be given.
      data-escape-owner="question"
      onKeyDown={onKeyDown}
      className="rounded-md border border-[var(--assistant-border-strong)] bg-[var(--assistant-inset)]/60 p-2.5 outline-hidden"
    >
      <p className="text-[1em] font-medium text-[var(--assistant-accent)]">
        Daintree needs a decision
      </p>
      <p className="mt-1.5 text-[1em]">{question.question}</p>

      <div
        role="listbox"
        aria-label="Options"
        aria-activedescendant={`q-${question.questionId}-${cursor}`}
        className="mt-2 border-y border-[var(--assistant-border)] py-1"
      >
        {question.options.map((option, i) => (
          <button
            key={option.label}
            id={`q-${question.questionId}-${i}`}
            role="option"
            aria-selected={i === cursor}
            type="button"
            onMouseEnter={() => setCursor(i)}
            onClick={() => answer(i)}
            className={cn(
              "flex w-full items-baseline gap-2 rounded-sm px-1.5 py-1 text-left text-[1em]",
              "transition-colors duration-150 ease-out",
              i === cursor ? "bg-[var(--assistant-hover)]" : "hover:bg-[var(--assistant-hover)]/60"
            )}
          >
            <span className="shrink-0 text-[var(--assistant-fg-secondary)]">{option.label}</span>
            <span className="min-w-0 flex-1">{option.text}</span>
          </button>
        ))}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[0.92em] text-[var(--assistant-fg-secondary)]">
        <span>↑↓ move · letter or Enter to answer</span>
        <button
          type="button"
          onClick={() => answer(-1)}
          className="rounded-sm px-1.5 py-0.5 transition-colors duration-150 ease-out hover:bg-[var(--assistant-hover)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
