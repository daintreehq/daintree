import {
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import { ViewPlugin, type Command } from "@codemirror/view";
import { invertedEffects, isolateHistory, undo, undoDepth } from "@codemirror/commands";
import {
  latestCloseSeq,
  notifyCloseUndoEdit,
  registerEditorUndo,
} from "@/services/terminal/closeUndoOrder";

// An edit of the person's own. Undo and redo walk the history rather than add
// to it, and a write kept out of history (a draft loading) can't be undone.
function isHistoryEdit(tr: Transaction): boolean {
  return (
    tr.docChanged &&
    tr.annotation(Transaction.addToHistory) !== false &&
    !tr.isUserEvent("undo") &&
    !tr.isUserEvent("redo")
  );
}

const setEditCloseSeq = StateEffect.define<number>();

/**
 * The newest close before the edit undo would take back next. Undo and redo
 * carry it back and forth with the history (the inverted effect below), so it
 * names the top of the undo stack however deep the history is, after a reset
 * as after a trim.
 */
const editCloseSeq = StateField.define<number>({
  create: () => 0,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setEditCloseSeq)) value = effect.value;
    }
    return isHistoryEdit(tr) ? latestCloseSeq() : value;
  },
});

const carryWithHistory = invertedEffects.of((tr) => {
  const before = tr.startState.field(editCloseSeq, false);
  const after = tr.state.field(editCloseSeq, false);
  return before === undefined || before === after ? [] : [setEditCloseSeq.of(before)];
});

// The first edit after a close starts an undo step of its own: typing just
// before the close and just after it would otherwise share one step, and undo
// would take back the older text with the newer.
const isolateFirstEditAfterClose = EditorState.transactionExtender.of((tr) => {
  if (!isHistoryEdit(tr)) return null;
  const previous = tr.startState.field(editCloseSeq, false);
  if (previous === undefined || previous >= latestCloseSeq()) return null;
  return { annotations: isolateHistory.of("before") };
});

/** Whether undo in `state` would take back an edit made after close `seq`. */
export function editorHasEditsSinceClose(state: EditorState, seq: number): boolean {
  const edit = state.field(editCloseSeq, false);
  return edit !== undefined && edit >= seq && undoDepth(state) > 0;
}

/**
 * Lets Cmd+Z tell this editor's newer edits from a panel closed before them,
 * so it undoes the typing first and reopens the panel after (#17107). Needs
 * the editor's `history()`: without it there is nothing to undo here.
 * `undoCommand` is the editor's own undo, locks and all.
 */
export function closeUndoOrdering(undoCommand: Command = undo): Extension {
  const registration = ViewPlugin.define((view) => {
    const unregister = registerEditorUndo(view.dom, {
      hasEditsSince: (seq) => editorHasEditsSinceClose(view.state, seq),
      undo: () => {
        undoCommand(view);
      },
    });
    return {
      // What undo takes back next is the field above and the history's depth.
      update(update) {
        if (
          update.startState.field(editCloseSeq, false) !==
            update.state.field(editCloseSeq, false) ||
          undoDepth(update.startState) !== undoDepth(update.state)
        ) {
          notifyCloseUndoEdit();
        }
      },
      destroy: () => {
        unregister();
        notifyCloseUndoEdit();
      },
    };
  });
  return [editCloseSeq, carryWithHistory, isolateFirstEditAfterClose, registration];
}
