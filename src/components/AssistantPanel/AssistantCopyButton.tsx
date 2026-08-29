import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import type { AssistantTurn } from "@/store/assistantStore";

/**
 * The transcript's copy gesture, for a user's message and for an assistant's answer.
 *
 * Hidden until the block it belongs to is hovered — or until it takes focus, which is
 * the keyboard's way in. The panel is a rail, and a control parked on every turn of a
 * long transcript is a column of glyphs down the side of the reading; the gesture is
 * discovered where the pointer already is.
 *
 * It stays in flow rather than mounting on hover, so the row it sits in never changes
 * width under the pointer. `opacity` is the right tool HERE — unlike the resting state
 * of a persistent control, where it would drag the contrast floor down — because the
 * resting state of this one is invisible on purpose.
 *
 * The `copied` check holds itself visible for its dwell: someone who clicks and
 * immediately moves the pointer away asked a question ("did that work?") that a
 * confirmation vanishing with the hover does not answer.
 */
export function AssistantCopyButton({
  text,
  label,
  className,
}: {
  text: string;
  /** Constant, both as the tooltip and to assistive technology. */
  label: string;
  className?: string;
}) {
  // The announcer is the only spoken confirmation — the label above must not change
  // with the flag, or the result is announced twice.
  const { copied, copy } = useCopyWithFeedback();

  return (
    <button
      type="button"
      onClick={() => void copy(text)}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-sm",
        "text-[var(--assistant-fg-secondary)]",
        "transition-[opacity,color,background-color] duration-150 ease-out",
        "hover:bg-[var(--assistant-hover)] hover:text-[var(--assistant-fg)]",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--assistant-focus)]",
        "opacity-0 focus-visible:opacity-100",
        copied && "opacity-100",
        className
      )}
    >
      {copied ? (
        <Check aria-hidden="true" className="size-3.5 text-[var(--assistant-success-graphic)]" />
      ) : (
        <Copy aria-hidden="true" className="size-3.5" />
      )}
    </button>
  );
}

/**
 * An assistant turn's prose, as text worth pasting somewhere else.
 *
 * NOT `turn.text`, which the store offers for exactly this and joins with nothing
 * between segments — welding the closing line of one paragraph onto the opening word of
 * the next as soon as the turn is read back.
 *
 * Joining with a blank line is safe because a text segment is a ROUND, not an arbitrary
 * cut: tokens extend the open segment until a tool batch closes it, and `turn:end`
 * replaces the trailing one with that round's authoritative message. So each segment is
 * a whole message, never half a sentence and never half a fenced block — which is also
 * why trimming one cannot eat indentation that mattered. The panel already draws these
 * as separate blocks (`space-y-5`); the blank line is what that looks like as text.
 *
 * Prose only. The tool rows, the steers folded in mid-turn and the answers to the
 * model's questions are all part of what HAPPENED, and the panel renders them for
 * exactly that reason — but they are not what the assistant said, and a paste that
 * mixes them in hands over a transcript when what was asked for was an answer.
 */
export function turnProse(turn: AssistantTurn): string {
  return turn.segments
    .filter((segment) => segment.kind === "text")
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join("\n\n");
}
