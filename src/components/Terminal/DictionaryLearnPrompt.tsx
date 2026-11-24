import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { FocusEvent, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { DismissButton } from "@/components/ui/DismissButton";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { cn } from "@/lib/utils";
import {
  useDictionaryLearnPromptStore,
  type DictionaryLearnPrompt as LearnOffer,
} from "@/store/dictionaryLearnPromptStore";
import { useTerminalInputStore } from "@/store/terminalInputStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { HeardAsConflict } from "@shared/types";
import { describeHeardAsConflicts } from "@/lib/heardAsConflictCopy";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { logWarn } from "@/utils/logger";

const PROMPT_VISIBLE_MS = 8_000;

type Answer = "acceptSuggestion" | "dismissSuggestion";

/** What the line is doing for the offer it shows. A new offer starts from idle. */
interface LineState {
  offer: LearnOffer | undefined;
  /** The answer being saved, or the one that failed to save. */
  answer: Answer | null;
  failed: boolean;
  /** Heard forms an accepted word was learned without, because another term fires for them. */
  leftOut: HeardAsConflict[];
  hovered: boolean;
  focused: boolean;
}

const idleFor = (offer: LearnOffer | undefined): LineState => ({
  offer,
  answer: null,
  failed: false,
  leftOut: [],
  hovered: false,
  focused: false,
});

interface DictionaryLearnPromptProps {
  terminalId: string;
  projectId?: string;
  /** Takes the keyboard back to the composer when the line goes while it had focus. */
  onReturnFocus?: () => void;
}

const ErrorGlyph = SEVERITY_GLYPH.error;

/**
 * The words inside their tooltip, which tell the line while they show. The
 * tooltip portals out of the line's DOM, so `:hover` on the line misses a
 * pointer reading it, and it can go from under the pointer without a leave.
 */
function TooltipWords({
  children,
  onShowing,
}: {
  children: ReactNode;
  onShowing: (delta: 1 | -1) => void;
}) {
  const report = useEffectEvent(onShowing);
  useEffect(() => {
    report(1);
    return () => report(-1);
  }, []);
  return children;
}

/** The line's words: cut to fit a narrow pane, and read in full on hover or focus before answering. */
function Message({
  children,
  className,
  onTooltipShowing,
}: {
  children: ReactNode;
  className?: string;
  onTooltipShowing: (delta: 1 | -1) => void;
}) {
  return (
    <TruncatedTooltip
      content={<TooltipWords onShowing={onTooltipShowing}>{children}</TooltipWords>}
      side="top"
      align="start"
      // A dictionary term can be one long unbroken identifier, wider than the tooltip.
      contentClassName="wrap-anywhere"
    >
      <span className={cn("min-w-0 flex-1 truncate", className)}>{children}</span>
    </TruncatedTooltip>
  );
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
  const tooltipsShowing = useRef(0);
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
  // It reads the pointer and focus off the DOM before letting go: an offer
  // that replaced another starts with neither, though both may still be here.
  // A tooltip still showing the words is being read, wherever the pointer is.
  const expire = useEffectEvent((offer: LearnOffer) => {
    const root = rootRef.current;
    const hovered = tooltipsShowing.current > 0 || (root?.matches(":hover") ?? false);
    const focused = root?.contains(document.activeElement) ?? false;
    if (hovered || focused) {
      adopt({ hovered, focused });
      return;
    }
    dismiss(offer);
  });

  // Typing moves on from an offer nobody answered. An answer stays: one still
  // saving, or one that failed, which goes when it is dismissed or retried.
  const answered = current.answer !== null;
  useEffect(() => {
    if (prompt && hasDraft && !answered) {
      useDictionaryLearnPromptStore.getState().clear(terminalId, prompt);
    }
  }, [prompt, hasDraft, answered, terminalId]);

  // A tooltip that goes from under the pointer takes no pointer leave with it.
  const onTooltipShowing = (delta: 1 | -1) => {
    tooltipsShowing.current += delta;
    if (tooltipsShowing.current === 0) {
      adopt({ hovered: rootRef.current?.matches(":hover") ?? false });
    }
  };

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
    const request = { word: offer.word, utterance: offer.utterance };
    const saved: Promise<HeardAsConflict[]> =
      answer === "acceptSuggestion"
        ? window.electron.voiceDictionary.acceptSuggestion(request).then((r) => r.conflicts)
        : window.electron.voiceDictionary.dismissSuggestion(request).then(() => []);
    saved.then(
      (leftOut) => {
        if (leftOut.length === 0) {
          dismiss(offer);
          return;
        }
        // Learned without a phrase another term fires for: the line says so, then goes as usual.
        // A newer offer has the line now, and the keyboard with it.
        if (useDictionaryLearnPromptStore.getState().prompts.get(terminalId) !== offer) return;
        const hadFocus = rootRef.current?.contains(document.activeElement) ?? false;
        setLine((prev) =>
          prev.offer === offer ? { ...prev, answer: null, leftOut, focused: false } : prev
        );
        if (hadFocus) onReturnFocus?.();
      },
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
      // It sits on the composer's band, which takes the terminal's palette, so
      // it brings an app surface of its own for its app inks and controls to
      // read on whatever the pair of themes, as the upload chips do.
      className="flex min-w-0 cursor-default items-center gap-2 rounded-[var(--radius-md)] border border-border-default bg-surface-panel-elevated py-0.5 pl-2.5 pr-0.5 text-xs text-text-secondary"
      onPointerEnter={() => adopt({ hovered: true })}
      onPointerLeave={() => adopt({ hovered: false })}
      onFocus={() => adopt({ focused: true })}
      onBlur={onBlur}
    >
      {/* The glyph carries a failure and the words stay neutral: status-coloured
          text has no contrast floor on this surface across the themes. A slot of
          its own, so a failed Add keeps its button, and the focus on it, as Retry. */}
      {failedAnswer ? (
        <ErrorGlyph className="h-3.5 w-3.5 shrink-0 text-status-error" aria-hidden="true" />
      ) : null}
      {failedAnswer ? (
        <>
          <Message className="text-text-primary" onTooltipShowing={onTooltipShowing}>
            Couldn&apos;t {failedAnswer === "acceptSuggestion" ? "add" : "dismiss"} &ldquo;
            {prompt.word}&rdquo;
          </Message>
          <Button size="xs" variant="outline" onClick={() => resolve(failedAnswer)}>
            Retry
          </Button>
          <DismissButton
            aria-label={`Dismiss the offer to learn \u201c${prompt.word}\u201d`}
            onClick={() => dismiss(prompt)}
          />
        </>
      ) : current.leftOut.length > 0 ? (
        <>
          <Message onTooltipShowing={onTooltipShowing}>
            Added &ldquo;{prompt.word}&rdquo;, but {describeHeardAsConflicts(current.leftOut)}
          </Message>
          <DismissButton
            aria-label={`Dismiss the note about \u201c${prompt.word}\u201d`}
            onClick={() => dismiss(prompt)}
          />
        </>
      ) : (
        <>
          <Message onTooltipShowing={onTooltipShowing}>
            Learn &ldquo;{prompt.word}&rdquo;
            {prompt.utterance ? <> for &ldquo;{prompt.utterance}&rdquo;</> : null}?
          </Message>
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
