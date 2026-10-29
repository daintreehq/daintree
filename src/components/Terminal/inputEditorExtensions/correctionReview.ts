import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import {
  Annotation,
  StateEffect,
  StateField,
  Transaction,
  type ChangeDesc,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import {
  UI_ANIMATION_DURATION,
  VOICE_CORRECTION_MARK_DWELL_MS,
  VOICE_CORRECTION_MARK_FADE_MS,
} from "@/lib/animationUtils";
import { alignWords, tokenizeWords, type WordToken } from "@/lib/wordAlignment";
import { chipCardText, chipHoverTooltip, chipTooltip } from "./chipCard";

/** A correction swapped into a dictated passage of the draft. */
export interface CorrectionReview {
  /** Where the corrected passage starts in the draft. */
  from: number;
  rawText: string;
  correctedText: string;
  /** Opaque here: carried through history for `onSwapped`'s listener. */
  baseline?: { raw: string; corrected: string } | null;
}

/** Offsets into the corrected text, each with the words that were heard there. */
export interface CorrectionChanges {
  /** Spans holding words the correction wrote. `heard` is empty for pure additions. */
  changed: { from: number; to: number; heard: string }[];
  /**
   * Where the correction dropped words and wrote nothing in their place: just
   * after the kept word before the gap, or, at the start of the passage, just
   * before the first kept word.
   */
  removed: { at: number; afterWord: boolean; heard: string }[];
}

// Punctuation that rides on a word's edge without changing it. Single quotes
// and brackets stay: `workers'` is a possessive, and `foo()` is not `foo`.
const LEADING_PUNCTUATION = /^["“«…—–]+/u;
const TRAILING_PUNCTUATION = /["”».,;:!?…—–]+$/u;
const SENTENCE_END = /[.!?…][)\]}"'”’»]*$/u;
const PRONOUN_I = /^I(?:'(?:m|ll|ve|d))?$/;
// The only capital in the word, as a sentence's first word takes.
const LONE_CAPITAL = /^\p{Lu}(?=[^\p{Lu}]*$)/u;

interface DiffWord extends WordToken {
  /** The word without the punctuation on its edges. */
  core: string;
  /** `core` without the capital that sentence position (or the pronoun I) gives it. */
  key: string;
}

/**
 * The words of `text` as the review compares them. A token of only punctuation
 * isn't a word. Inside a word everything counts: an apostrophe, a digit for a
 * spelled number, a capital that makes a name. Sentences are read from full
 * stops and line breaks, so an abbreviation can open one that isn't.
 */
function diffWords(text: string): DiffWord[] {
  const words: DiffWord[] = [];
  // A token of only punctuation can end a sentence but never uses up the
  // opening of the next.
  let opens = true;
  let prevTo = 0;
  for (const token of tokenizeWords(text)) {
    if (text.slice(prevTo, token.from).includes("\n")) opens = true;
    prevTo = token.to;
    const core = token.text
      .replaceAll("’", "'")
      .replace(LEADING_PUNCTUATION, "")
      .replace(TRAILING_PUNCTUATION, "");
    if (core !== "") {
      const folds = opens || PRONOUN_I.test(core);
      words.push({
        ...token,
        core,
        key: folds ? core.replace(LONE_CAPITAL, (capital) => capital.toLowerCase()) : core,
      });
      opens = false;
    }
    if (SENTENCE_END.test(token.text)) opens = true;
  }
  return words;
}

// A capital that stays put is the same word wherever the sentence breaks fall.
function sameWord(x: DiffWord, y: DiffWord): boolean {
  return x.core === y.core || x.key === y.key;
}

/**
 * The words a correction changed. Words are whitespace-separated and compared
 * as `diffWords` reads them, so punctuation and a sentence's capital the
 * correction added land quietly while a change to the word itself counts; a
 * change to the spacing alone does not.
 */
export function diffCorrection(rawText: string, correctedText: string): CorrectionChanges {
  const a = diffWords(rawText);
  const b = diffWords(correctedText);
  // Framed by the positions just outside either end, so every gap is between two pairs.
  const kept: [number, number][] = [
    [-1, -1],
    ...alignWords(a, b, sameWord),
    [a.length, b.length],
  ];

  const changes: CorrectionChanges = { changed: [], removed: [] };
  for (let k = 0; k < kept.length - 1; k++) {
    const [prevA, prevB] = kept[k]!;
    const [nextA, nextB] = kept[k + 1]!;
    const heard = nextA - prevA > 1 ? rawText.slice(a[prevA + 1]!.from, a[nextA - 1]!.to) : "";
    if (nextB - prevB > 1) {
      changes.changed.push({ from: b[prevB + 1]!.from, to: b[nextB - 1]!.to, heard });
    } else if (heard) {
      if (prevB >= 0) changes.removed.push({ at: b[prevB]!.to, afterWord: true, heard });
      else if (nextB < b.length) {
        changes.removed.push({ at: b[nextB]!.from, afterWord: false, heard });
      } else if (correctedText.trim() !== "") {
        // The correction left only punctuation: the gap stands at the passage's start.
        changes.removed.push({ at: 0, afterWord: false, heard });
      }
    }
  }
  return changes;
}

// See `mapChipEntry`. A review that cannot be placed keeps its offset: showing
// it again re-checks the text there, and learning reads only its two texts.
function mapReview(review: CorrectionReview, mapping: ChangeDesc): CorrectionReview {
  if (review.from > mapping.length) return review;
  return { ...review, from: mapping.mapPos(review.from, 1) };
}

/**
 * Rides the transaction that swaps a correction into the draft. History
 * inverts it along with the swap, so undoing one carries `correctionReverted`
 * and redoing it carries this again.
 */
export const correctionLanded = StateEffect.define<CorrectionReview>({ map: mapReview });
/** Rides a transaction that puts the raw transcription back over a correction. */
export const correctionReverted = StateEffect.define<CorrectionReview>({ map: mapReview });
const advanceReview = StateEffect.define<null>();
/**
 * Dismisses the review and leaves the text as it is: the correction is behind
 * the user, but still the undo step it was.
 */
export const correctionReviewEnded = StateEffect.define<null>();

/**
 * The effects that land a correction. One a newer dictation has put behind
 * the user (#14875) lands out of review: still an undo step, which undo and
 * redo carry as any other.
 */
export function correctionLandingEffects(
  review: CorrectionReview,
  reviewed = true
): StateEffect<unknown>[] {
  const landed = correctionLanded.of(review);
  return reviewed ? [landed] : [landed, correctionReviewEnded.of(null)];
}

/**
 * Marks a write from outside the composer: dictated words, a cleanup, a file
 * link. A long dictation's chunks are cleaned while it runs (#14772), so the
 * words dictated after one land while its review is still showing.
 */
export const outsideWrite = Annotation.define<true>();

/**
 * `marked`: the changed words are underlined. `fading`: the underline is on its
 * way out. `settled`: nothing shows, and the review lasts until the next edit.
 */
type ReviewPhase = "marked" | "fading" | "settled";

interface ReviewState {
  review: CorrectionReview;
  changes: CorrectionChanges;
  phase: ReviewPhase;
}

function reviewFor(doc: Text, review: CorrectionReview): ReviewState | null {
  const to = review.from + review.correctedText.length;
  if (review.from < 0 || to > doc.length) return null;
  if (doc.sliceString(review.from, to) !== review.correctedText) return null;
  const changes = diffCorrection(review.rawText, review.correctedText);
  if (changes.changed.length === 0 && changes.removed.length === 0) return null;
  return { review, changes, phase: "marked" };
}

/**
 * The review carried through an outside write that only added text and left
 * its words alone, or null. A write that takes text out (a scratch, a cancel,
 * a send) ends it: the composer diffs such a write, and a diff can put the
 * removal on an identical copy of the passage, leaving the review on text
 * that was never corrected.
 */
function carryReview(state: ReviewState, tr: Transaction): ReviewState | null {
  let removes = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    if (toA > fromA) removes = true;
  });
  if (removes) return null;
  const { review } = state;
  const from = tr.changes.mapPos(review.from, 1);
  const to = from + review.correctedText.length;
  if (tr.state.doc.sliceString(from, to) !== review.correctedText) return null;
  return from === review.from ? state : { ...state, review: { ...review, from } };
}

/**
 * The correction that last landed in this draft. An edit of the user's ends
 * the review: the marks describe that one swap, and after an edit the passage
 * is either the user's or no longer what the correction wrote. An outside
 * write that leaves the passage alone moves it.
 */
export const correctionReviewField = StateField.define<ReviewState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    if (value && tr.docChanged) value = tr.annotation(outsideWrite) ? carryReview(value, tr) : null;
    for (const effect of tr.effects) {
      if (effect.is(correctionLanded)) value = reviewFor(tr.state.doc, effect.value);
      else if (effect.is(correctionReverted) || effect.is(correctionReviewEnded)) value = null;
      else if (effect.is(advanceReview) && value && value.phase !== "settled") {
        value = { ...value, phase: value.phase === "marked" ? "fading" : "settled" };
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, reviewDecorations),
});

/**
 * A correction already in the document when the editor learns of it: the
 * composer mounted after it landed, or a send synced the draft ahead of the
 * usual sync. The raw text goes back out of history and the correction lands
 * over it as its own undo step, the same as one seen live.
 */
export function replayLandedCorrection(
  view: EditorView,
  review: CorrectionReview,
  reviewed = true
): void {
  const to = review.from + review.correctedText.length;
  if (view.state.doc.sliceString(review.from, to) !== review.correctedText) return;
  view.dispatch({
    changes: { from: review.from, to, insert: review.rawText },
    annotations: Transaction.addToHistory.of(false),
  });
  view.dispatch({
    changes: {
      from: review.from,
      to: review.from + review.rawText.length,
      insert: review.correctedText,
    },
    effects: correctionLandingEffects(review, reviewed),
    annotations: isolateHistory.of("full"),
  });
}

/**
 * Ends the review of the correction that last landed, if one is showing. A
 * new dictation puts it behind the user (#14875).
 */
export function endCorrectionReview(view: EditorView): void {
  if (!view.state.field(correctionReviewField, false)) return;
  view.dispatch({ effects: correctionReviewEnded.of(null) });
}

function phaseClass(base: string, phase: ReviewPhase): string {
  return phase === "fading" ? `${base} cm-voice-corrected-fading` : base;
}

class RemovedWordsWidget extends WidgetType {
  constructor(
    readonly afterWord: boolean,
    readonly phase: ReviewPhase
  ) {
    super();
  }

  eq(other: RemovedWordsWidget): boolean {
    return other.afterWord === this.afterWord && other.phase === this.phase;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = phaseClass("cm-voice-corrected-gap", this.phase);
    span.dataset.side = this.afterWord ? "after" : "before";
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

const changedMark = Decoration.mark({ class: "cm-voice-corrected" });
const fadingChangedMark = Decoration.mark({ class: phaseClass("cm-voice-corrected", "fading") });

function reviewDecorations(state: ReviewState | null): DecorationSet {
  if (!state) return Decoration.none;
  const { review, changes, phase } = state;
  const ranges: Range<Decoration>[] = [];
  if (phase !== "settled") {
    const mark = phase === "fading" ? fadingChangedMark : changedMark;
    for (const span of changes.changed) {
      ranges.push(mark.range(review.from + span.from, review.from + span.to));
    }
    for (const gap of changes.removed) {
      ranges.push(
        Decoration.widget({
          widget: new RemovedWordsWidget(gap.afterWord, phase),
          side: gap.afterWord ? -1 : 1,
        }).range(review.from + gap.at)
      );
    }
  }
  return Decoration.set(ranges, true);
}

const reviewHistory = invertedEffects.of((tr) => {
  const inverted: StateEffect<CorrectionReview>[] = [];
  for (const effect of tr.effects) {
    if (effect.is(correctionLanded)) inverted.push(correctionReverted.of(effect.value));
    else if (effect.is(correctionReverted)) inverted.push(correctionLanded.of(effect.value));
  }
  return inverted;
});

/** Owns the dwell and fade deadlines. CSS only paints the fade. */
const reviewTimers = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(readonly view: EditorView) {
      this.schedule(view.state.field(correctionReviewField, false) ?? null);
    }

    update(update: ViewUpdate) {
      const before = update.startState.field(correctionReviewField, false) ?? null;
      const after = update.state.field(correctionReviewField, false) ?? null;
      // A review only moved by a write elsewhere keeps its deadline.
      if (before?.changes !== after?.changes || before?.phase !== after?.phase) {
        this.schedule(after);
      }
    }

    private schedule(state: ReviewState | null) {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      if (!state || state.phase === "settled") return;
      this.timer = setTimeout(
        () => {
          this.timer = null;
          this.view.dispatch({ effects: advanceReview.of(null) });
        },
        state.phase === "marked" ? VOICE_CORRECTION_MARK_DWELL_MS : VOICE_CORRECTION_MARK_FADE_MS
      );
    }

    destroy() {
      if (this.timer !== null) clearTimeout(this.timer);
    }
  }
);

/**
 * The card for the change at `pos`: a word the correction wrote (its edges
 * included, so a one-letter change has somewhere to stand), or the gap where
 * it dropped some.
 */
function changeCard(state: ReviewState, pos: number): Tooltip | null {
  const { review, changes } = state;
  const offset = pos - review.from;
  const span = changes.changed.find((s) => offset >= s.from && offset <= s.to);
  if (span) {
    const range = { from: review.from + span.from, to: review.from + span.to };
    return chipTooltip(range, ".cm-voice-corrected", () => [
      chipCardText(span.heard ? `Heard “${span.heard}”` : "Added by correction"),
    ]);
  }
  // A gap mark sits on the space beside the kept word it follows (or leads).
  const gap = changes.removed.find((g) =>
    g.afterWord ? offset === g.at || offset === g.at + 1 : offset === g.at || offset === g.at - 1
  );
  if (!gap) return null;
  const at = review.from + gap.at;
  return chipTooltip({ from: at, to: at }, ".cm-voice-corrected-gap", () => [
    chipCardText(`Removed “${gap.heard}”`),
  ]);
}

const dismissCaretCard = StateEffect.define<null>();

/**
 * The same card for a caret the user moves onto a change, so a keyboard
 * learns what was heard without a pointer, for as long as the review lasts.
 * Only a move opens or closes it: the caret dictation leaves after the
 * passage opens nothing, and the marks' fade leaves an open card alone.
 * Escape puts it away until the caret moves again.
 */
const caretCardField = StateField.define<Tooltip | null>({
  create: () => null,
  update(card, tr) {
    const review = tr.state.field(correctionReviewField, false);
    if (!review || tr.effects.some((e) => e.is(dismissCaretCard))) return null;
    const caret = tr.state.selection.main;
    const moved = tr.isUserEvent("select");
    // An outside write moved the passage: the open card follows its change.
    if (!moved && !(card && tr.docChanged)) return card;
    const next = caret.empty ? changeCard(review, caret.head) : null;
    // The same change keeps the same card, so moving within a word doesn't
    // build it again.
    return next && card && next.pos === card.pos && next.end === card.end ? card : next;
  },
  provide: (f) => showTooltip.from(f),
});

// An observer, so the composer's own Escape (cancel a dictation or a send)
// runs as ever and can't keep the card from closing.
const dismissCaretCardOnEscape = EditorView.domEventObservers({
  keydown(event, view) {
    if (event.key === "Escape" && view.state.field(caretCardField, false)) {
      view.dispatch({ effects: dismissCaretCard.of(null) });
    }
  },
});

const reviewTooltip = chipHoverTooltip(
  (view, pos) => {
    const state = view.state.field(correctionReviewField, false);
    if (!state) return null;
    if (state.phase === "settled") return null;
    const card = changeCard(state, pos);
    // The caret's card for the same change is already up.
    if (card && view.state.field(caretCardField, false)?.pos === card.pos) return null;
    return card;
  },
  // A pointer card already open closes when the caret opens the same one.
  { hideOn: (tr, tooltip) => tr.state.field(caretCardField, false)?.pos === tooltip.pos }
);

// Colour lives in the swappable input bar theme; the fade only says "to
// nothing", so it reads whatever colour the theme gave the mark.
const reviewFadeTheme = EditorView.baseTheme({
  // The marks come in as a state change rather than appearing in one frame:
  // the streamed words they land on were unmarked a moment before.
  "@keyframes cm-voice-corrected-in": { from: { textDecorationColor: "transparent" } },
  "@keyframes cm-voice-corrected-gap-in": { from: { opacity: "0" } },
  ".cm-voice-corrected": {
    animation: `cm-voice-corrected-in ${UI_ANIMATION_DURATION}ms ease-out`,
  },
  ".cm-voice-corrected-gap": {
    animation: `cm-voice-corrected-gap-in ${UI_ANIMATION_DURATION}ms ease-out`,
  },
  "@media (prefers-reduced-motion: reduce)": {
    ".cm-voice-corrected:not(.cm-voice-corrected-fading), .cm-voice-corrected-gap:not(.cm-voice-corrected-fading)":
      { animation: "none" },
  },
  'body[data-reduce-animations="true"] .cm-voice-corrected:not(.cm-voice-corrected-fading), body[data-reduce-animations="true"] .cm-voice-corrected-gap:not(.cm-voice-corrected-fading)':
    { animation: "none" },
  "@keyframes cm-voice-corrected-fade": { to: { textDecorationColor: "transparent" } },
  "@keyframes cm-voice-corrected-out": { to: { opacity: "0" } },
  ".cm-voice-corrected.cm-voice-corrected-fading": {
    animation: `cm-voice-corrected-fade ${VOICE_CORRECTION_MARK_FADE_MS}ms ease-out forwards`,
  },
  ".cm-voice-corrected-gap.cm-voice-corrected-fading": {
    animation: `cm-voice-corrected-out ${VOICE_CORRECTION_MARK_FADE_MS}ms ease-out forwards`,
  },
});

export interface CorrectionReviewOptions {
  /** A correction came into view: it landed, or an undo or redo brought it back. */
  onShown?: (review: CorrectionReview) => void;
  /**
   * The passage changed hands between the correction and the raw transcription,
   * by an undo or a redo. `now` is what the draft holds.
   */
  onSwapped?: (review: CorrectionReview, now: "raw" | "corrected") => void;
}

export function createCorrectionReview(options: CorrectionReviewOptions = {}): Extension {
  const { onShown, onSwapped } = options;
  return [
    correctionReviewField,
    reviewHistory,
    reviewTimers,
    reviewTooltip,
    caretCardField,
    dismissCaretCardOnEscape,
    reviewFadeTheme,
    EditorView.updateListener.of((update) => {
      for (const tr of update.transactions) {
        const replayed = tr.isUserEvent("undo") || tr.isUserEvent("redo");
        for (const effect of tr.effects) {
          if (effect.is(correctionReverted)) onSwapped?.(effect.value, "raw");
          else if (effect.is(correctionLanded) && replayed) onSwapped?.(effect.value, "corrected");
        }
      }
      const before = update.startState.field(correctionReviewField, false) ?? null;
      const after = update.state.field(correctionReviewField, false) ?? null;
      if (after && after.review !== before?.review) onShown?.(after.review);
    }),
  ];
}
