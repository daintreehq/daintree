import type { TextChange, TrackedTextRange } from "@/lib/textRangeMapping";
import type { DictationTextSpan } from "@/store/dictationRangeStore";

/** One voice write into a draft, in the coordinates of the draft it produces. */
export interface VoiceInsertPlan {
  next: string;
  /** The write as one change to the old draft. */
  change: TextChange;
  /** What the write went in at in the old draft: the anchor, or the caret past an edited one. */
  at: DictationTextSpan;
  /** Everything the write put in that belongs to the dictation. */
  insertion: DictationTextSpan;
  /** The words alone, or the break itself. */
  words: DictationTextSpan;
  /** Where the session's anchor goes next. */
  anchor: DictationTextSpan;
  /** The space put after the words so they don't run into the text after them, when one was. */
  separatorAfter?: DictationTextSpan;
  /** The selection the write replaced, for the cancel that has to put it back. */
  replaced?: string;
}

// Text that hugs the word before it, so dictation landing just ahead of it
// gets no space of its own.
const HUGS_PREVIOUS = /^[\s.,;:!?)\]}]/;
const OPENS = /[([{]$/;

/** The span the session's next words replace: empty where they only go in. */
export function insertionSpan(draft: string, anchor: TrackedTextRange | null): DictationTextSpan {
  if (!anchor) return { from: draft.length, to: draft.length };
  const to = Math.min(anchor.to, draft.length);
  // A selection the user changed since dictation began is theirs again: the
  // words go after it rather than over what's left of it.
  const from = anchor.edited ? to : Math.min(anchor.from, to);
  return { from, to };
}

/** Whether words planned at the anchor would have nothing but whitespace before them. */
export function voiceWordsOpenDraft(draft: string, anchor: TrackedTextRange | null): boolean {
  return draft.slice(0, insertionSpan(draft, anchor).from).trim() === "";
}

/**
 * Plans dictated words into `draft` at the session's anchor, replacing the
 * selection it still holds. A space is added before the words when they'd
 * otherwise run into the previous word, and after them when they'd run into
 * the next one. The trailing space stays outside the dictation, so the next
 * utterance lands right after these words.
 */
export function planVoiceWords(
  draft: string,
  anchor: TrackedTextRange | null,
  text: string
): VoiceInsertPlan {
  const { from, to } = insertionSpan(draft, anchor);
  const before = draft.slice(0, from);
  const replaced = draft.slice(from, to);
  const after = draft.slice(to);
  const leading =
    before && !/\s$/.test(before) && !OPENS.test(before) && !HUGS_PREVIOUS.test(text) ? " " : "";
  const trailing = after && !HUGS_PREVIOUS.test(after) ? " " : "";
  const wordsFrom = from + leading.length;
  const wordsTo = wordsFrom + text.length;
  const insert = leading + text + trailing;
  return {
    next: before + insert + after,
    change: { from, to, insert },
    at: { from, to },
    insertion: { from, to: wordsTo },
    words: { from: wordsFrom, to: wordsTo },
    anchor: { from: wordsTo, to: wordsTo },
    ...(trailing ? { separatorAfter: { from: wordsTo, to: wordsTo + trailing.length } } : {}),
    ...(replaced ? { replaced } : {}),
  };
}

/**
 * Plans a paragraph break at the session's anchor. A selection no words have
 * replaced yet survives it: the break goes in ahead of the selection, which
 * the next words still replace.
 */
export function planVoiceBreak(draft: string, anchor: TrackedTextRange | null): VoiceInsertPlan {
  const { from, to } = insertionSpan(draft, anchor);
  const next = draft.slice(0, from) + "\n" + draft.slice(from);
  return {
    next,
    change: { from, to: from, insert: "\n" },
    at: { from, to },
    insertion: { from, to: from + 1 },
    words: { from, to: from + 1 },
    anchor: { from: from + 1, to: to + 1 },
  };
}
