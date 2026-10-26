import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  StateEffect,
  StateField,
  Transaction,
  type ChangeDesc,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import { invertedEffects, isolateHistory } from "@codemirror/commands";
import { createTrustedHTML, setTrustedInnerHTML } from "@/lib/trustedTypesPolicy";
import { isMac } from "@/lib/platform";
import { labelWithShortcut } from "@/lib/kbdShortcut";
import {
  VOICE_CORRECTION_MARK_DWELL_MS,
  VOICE_CORRECTION_MARK_FADE_MS,
} from "@/lib/animationUtils";
import { chipCardText, chipHoverTooltip, chipTooltip } from "./chipCard";

/** A correction swapped into a dictated passage of the draft. */
export interface CorrectionReview {
  /** Where the corrected passage starts in the draft. */
  from: number;
  rawText: string;
  correctedText: string;
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

interface Token {
  text: string;
  from: number;
  to: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    tokens.push({ text: match[0], from: match.index, to: match.index + match[0].length });
  }
  return tokens;
}

// A passage past this many word pairs is marked as one span between its common
// head and tail rather than aligned word by word.
const MAX_ALIGNMENT_CELLS = 250_000;

/**
 * The words a correction changed. Words are whitespace-separated and compared
 * exactly, so a capital or a punctuation mark the correction added counts; a
 * change to the spacing alone does not.
 */
export function diffCorrection(rawText: string, correctedText: string): CorrectionChanges {
  const a = tokenize(rawText);
  const b = tokenize(correctedText);

  let head = 0;
  while (head < a.length && head < b.length && a[head]!.text === b[head]!.text) head++;
  let endA = a.length;
  let endB = b.length;
  while (endA > head && endB > head && a[endA - 1]!.text === b[endB - 1]!.text) {
    endA--;
    endB--;
  }

  // Index pairs of the words both sides keep, framed by the common head and tail.
  const kept: [number, number][] = [[head - 1, head - 1]];
  const m = endA - head;
  const n = endB - head;
  if (m > 0 && n > 0 && m * n <= MAX_ALIGNMENT_CELLS) {
    const width = n + 1;
    const lcs = new Uint32Array((m + 1) * width);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i * width + j] =
          a[head + i]!.text === b[head + j]!.text
            ? lcs[(i + 1) * width + j + 1]! + 1
            : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (a[head + i]!.text === b[head + j]!.text) {
        kept.push([head + i, head + j]);
        i++;
        j++;
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        i++;
      } else {
        j++;
      }
    }
  }
  kept.push([endA, endB]);

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
 * `marked`: the changed words are underlined. `fading`: the underline is on its
 * way out. `settled`: only the restore control is left, until the next edit.
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
 * The correction that last landed in this draft. Any edit ends the review: the
 * marks and the restore control describe that one swap, and after an edit the
 * passage is either the user's or no longer what the correction wrote.
 */
export const correctionReviewField = StateField.define<ReviewState | null>({
  create() {
    return null;
  },
  update(value, tr) {
    if (value && tr.docChanged) value = null;
    for (const effect of tr.effects) {
      if (effect.is(correctionLanded)) value = reviewFor(tr.state.doc, effect.value);
      else if (effect.is(correctionReverted)) value = null;
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
export function replayLandedCorrection(view: EditorView, review: CorrectionReview): void {
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
    effects: correctionLanded.of(review),
    annotations: isolateHistory.of("full"),
  });
}

const RESTORE_USER_EVENT = "input.restore";

/**
 * Puts the raw transcription back over the corrected passage, as one undo step.
 * False when no correction is under review.
 */
export function restoreCorrection(view: EditorView): boolean {
  const state = view.state.field(correctionReviewField, false);
  if (!state || !view.state.facet(EditorView.editable)) return false;
  const { review } = state;
  const to = review.from + review.correctedText.length;
  if (view.state.doc.sliceString(review.from, to) !== review.correctedText) return false;
  view.dispatch({
    changes: { from: review.from, to, insert: review.rawText },
    selection: { anchor: review.from + review.rawText.length },
    effects: correctionReverted.of(review),
    annotations: [isolateHistory.of("full"), Transaction.userEvent.of(RESTORE_USER_EVENT)],
    scrollIntoView: true,
  });
  return true;
}

const ROTATE_CCW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>`;

const RESTORE_LABEL = "Restore original transcription";

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

class RestoreControlWidget extends WidgetType {
  toDOM(view: EditorView): HTMLElement {
    const control = document.createElement("span");
    control.className = "cm-voice-restore";
    // Not focusable: Tab belongs to the composer. While this shows, the
    // correction is the newest undo step, so Cmd+Z is the keyboard path.
    control.setAttribute("role", "button");
    control.setAttribute("aria-label", RESTORE_LABEL);
    setTrustedInnerHTML(control, createTrustedHTML(ROTATE_CCW_SVG));
    control.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    control.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (restoreCorrection(view)) view.focus();
    });
    return control;
  }

  eq(): boolean {
    return true;
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
  ranges.push(
    Decoration.widget({ widget: new RestoreControlWidget(), side: 1 }).range(
      review.from + review.correctedText.length
    )
  );
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
      if (before !== after) this.schedule(after);
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

const reviewTooltip = chipHoverTooltip((view, pos, side) => {
  const state = view.state.field(correctionReviewField, false);
  if (!state) return null;
  const { review, changes, phase } = state;
  const end = review.from + review.correctedText.length;
  if (pos === end && side > 0) {
    return chipTooltip({ from: end, to: end }, ".cm-voice-restore", () => [
      chipCardText(labelWithShortcut(RESTORE_LABEL, "Cmd+Z", isMac())),
    ]);
  }
  if (phase === "settled") return null;
  const offset = pos - review.from;
  const span = changes.changed.find((s) => offset >= s.from && offset <= s.to);
  if (!span) return null;
  const range = { from: review.from + span.from, to: review.from + span.to };
  return chipTooltip(range, ".cm-voice-corrected", () => [
    chipCardText(span.heard ? `Heard “${span.heard}”` : "Added by correction"),
  ]);
});

// Colour lives in the swappable input bar theme; the fade only says "to
// nothing", so it reads whatever colour the theme gave the mark.
const reviewFadeTheme = EditorView.baseTheme({
  "@keyframes cm-voice-corrected-fade": { to: { textDecorationColor: "transparent" } },
  "@keyframes cm-voice-corrected-out": { to: { opacity: "0" } },
  ".cm-voice-corrected.cm-voice-corrected-fading": {
    animation: `cm-voice-corrected-fade ${VOICE_CORRECTION_MARK_FADE_MS}ms ease-out forwards`,
  },
  ".cm-voice-corrected-gap.cm-voice-corrected-fading": {
    animation: `cm-voice-corrected-out ${VOICE_CORRECTION_MARK_FADE_MS}ms ease-out forwards`,
  },
  // A locked composer (disabled, or holding a send) takes no restore.
  '.cm-content[contenteditable="false"] .cm-voice-restore': { display: "none" },
});

export interface CorrectionReviewOptions {
  /** A correction came into view: it landed, or an undo or redo brought it back. */
  onShown?: (review: CorrectionReview) => void;
  /**
   * The passage changed hands between the correction and the raw transcription,
   * by the restore control, an undo or a redo. `now` is what the draft holds.
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
