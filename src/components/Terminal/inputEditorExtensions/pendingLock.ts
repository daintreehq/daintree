import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type ChangeDesc,
  type EditorSelection,
  type Extension,
  type StateCommand,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type Command,
  type ViewUpdate,
} from "@codemirror/view";
import { VOICE_PENDING_REFUSAL_MS } from "@/lib/animationUtils";
import { setPendingAIRanges } from "./base";
import { outsideWrite } from "./correctionReview";
import { userEdit } from "./userEdit";
import { REWRITE_USER_EVENT } from "./voiceRewrite";

export interface PendingBlock {
  from: number;
  to: number;
}

const NO_BLOCKS: readonly PendingBlock[] = [];

// Text inserted at a block's edge stays outside it.
function mapBlocks(blocks: readonly PendingBlock[], changes: ChangeDesc): readonly PendingBlock[] {
  const next = blocks.flatMap(({ from, to }) => {
    const mappedFrom = changes.mapPos(from, 1);
    const mappedTo = changes.mapPos(to, -1);
    return mappedFrom < mappedTo ? [{ from: mappedFrom, to: mappedTo }] : [];
  });
  return next.length > 0 ? next : NO_BLOCKS;
}

/**
 * Each passage the composer draws as pending, whole: the words a streamed
 * rewrite hides and the underlined rest are one block, so the seam between
 * them is inside it. Text typed at either edge stays outside.
 */
export const pendingBlocksField = StateField.define<readonly PendingBlock[]>({
  create: () => NO_BLOCKS,
  update(blocks, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setPendingAIRanges)) continue;
      const docLen = tr.state.doc.length;
      const next = effect.value.flatMap((range) => {
        const from = Math.max(0, range.from);
        const to = Math.min(docLen, range.to);
        return from < to ? [{ from, to }] : [];
      });
      return next.length > 0 ? next : NO_BLOCKS;
    }
    return tr.docChanged && blocks.length > 0 ? mapBlocks(blocks, tr.changes) : blocks;
  },
});

/**
 * The blocks `changes` would change, or null when it leaves them all as they
 * are. Text inserted at a block's edge is outside it. A change may take a
 * block out whole only for a selection that covers it: the user chose to clear
 * it, as clearing the draft does, and its correction goes with it. Word and
 * line deletes from a caret, and history, never can.
 */
export function refusedBlocks(
  blocks: readonly PendingBlock[],
  changes: ChangeDesc,
  selection: EditorSelection | null
): PendingBlock[] | null {
  if (blocks.length === 0 || changes.empty) return null;
  const refused = blocks.filter((block) => {
    let refuses = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (refuses) return;
      const touches =
        fromA === toA
          ? fromA > block.from && fromA < block.to
          : fromA < block.to && toA > block.from;
      if (!touches) return;
      const takesWhole = fromA <= block.from && toA >= block.to;
      const chosen = selection?.ranges.some(
        (range) => !range.empty && range.from <= block.from && range.to >= block.to
      );
      if (!takesWhole || !chosen) refuses = true;
    });
    return refuses;
  });
  return refused.length > 0 ? refused : null;
}

/**
 * Whether `tr` is an edit of the user's. The session's own writes (dictated
 * words, a correction landing, "scratch that", a cancel, a spoken rewrite)
 * and the composer's writes from outside (a recalled prompt, a fleet mirror,
 * a draft swap) carry no user event and pass.
 */
function isUserEdit(tr: Transaction): boolean {
  if (tr.annotation(outsideWrite) || tr.isUserEvent(REWRITE_USER_EVENT)) return false;
  return (
    tr.annotation(userEdit) === true ||
    tr.isUserEvent("input") ||
    tr.isUserEvent("delete") ||
    tr.isUserEvent("move") ||
    tr.isUserEvent("undo") ||
    tr.isUserEvent("redo")
  );
}

export const pendingEditRefused = StateEffect.define<readonly PendingBlock[]>();
const refusalEnded = StateEffect.define<null>();

// Inclusive, so the wash opens ahead of a streamed rewrite at the block's start
// and closes after one running to its end, and covers it whole.
const refusedMark = Decoration.mark({ class: "cm-voice-pending-refused", inclusive: true });

/**
 * The blocks that last refused an edit, washed for a moment so a refused
 * keystroke never goes nowhere unseen. Gone with the blocks themselves.
 */
const refusalField = StateField.define<readonly PendingBlock[]>({
  create: () => NO_BLOCKS,
  update(value, tr) {
    if (tr.docChanged && value.length > 0) value = mapBlocks(value, tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(pendingEditRefused)) value = effect.value;
      else if (effect.is(refusalEnded)) value = NO_BLOCKS;
    }
    if (value.length > 0 && tr.state.field(pendingBlocksField).length === 0) return NO_BLOCKS;
    return value;
  },
  // Below the pending field's, so the wash is the outer mark: one wrapping a
  // streamed rewrite has to be.
  provide: (f) =>
    Prec.low(
      EditorView.decorations.from(f, (blocks) =>
        Decoration.set(blocks.map((block) => refusedMark.range(block.from, block.to)))
      )
    ),
});

const REFUSAL_ANNOUNCEMENT = "Still correcting these words";

/** What a refused edit becomes: the selection where it was, and the wash. */
function refusal(state: EditorState, blocks: readonly PendingBlock[]): TransactionSpec {
  // Said once per wash, not once per key held down.
  const announce = state.field(refusalField).length === 0;
  return {
    effects: [
      pendingEditRefused.of(blocks),
      ...(announce ? [EditorView.announce.of(REFUSAL_ANNOUNCEMENT)] : []),
    ],
    annotations: Transaction.addToHistory.of(false),
  };
}

// A transaction filter, so a refused edit goes whole: its selection, chips and
// history step with it, and an edit that only partly reaches a block is never
// split into the part outside.
const lockFilter = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !isUserEdit(tr)) return tr;
  const blocks = tr.startState.field(pendingBlocksField, false) ?? NO_BLOCKS;
  const refused = refusedBlocks(blocks, tr.changes, tr.startState.selection);
  return refused ? refusal(tr.startState, refused) : tr;
});

/** Owns the wash's deadline: each refusal starts it again. */
const refusalTimer = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (update.transactions.some((tr) => tr.effects.some((e) => e.is(pendingEditRefused)))) {
        this.stop();
        this.timer = setTimeout(() => {
          this.timer = null;
          this.view.dispatch({ effects: refusalEnded.of(null) });
        }, VOICE_PENDING_REFUSAL_MS);
      } else if (update.state.field(refusalField).length === 0) {
        this.stop();
      }
    }

    private stop() {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }

    destroy() {
      this.stop();
    }
  }
);

/**
 * `command` (undo or redo), run only when the step it takes leaves every
 * pending block as it is. History dispatches past the transaction filter, so
 * its step is checked here; a refused one stays on its stack for when the
 * block unlocks.
 */
export function lockedHistoryCommand(command: StateCommand): Command {
  return (view) => {
    const proposed: Transaction[] = [];
    const ran = command({ state: view.state, dispatch: (tr) => proposed.push(tr) });
    const step = proposed[0];
    if (!step) return ran;
    const blocks = view.state.field(pendingBlocksField, false) ?? NO_BLOCKS;
    const refused = refusedBlocks(blocks, step.changes, null);
    view.dispatch(refused ? refusal(view.state, refused) : step);
    return true;
  };
}

/**
 * Locks the words of every passage the composer draws as pending against the
 * user's edits until its correction settles (#15874). Selection and caret
 * moves pass, and so does everything the session itself writes.
 */
export const pendingLock: Extension = [pendingBlocksField, refusalField, lockFilter, refusalTimer];
