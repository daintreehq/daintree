import { EditorState, StateField, Transaction, type Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { isolateHistory, undoDepth } from "@codemirror/commands";
import {
  MAX_CLOSE_CHECKPOINTS,
  latestCloseSeq,
  registerEditorUndoCheck,
} from "@/services/terminal/closeUndoOrder";

interface CloseCheckpoint {
  /** The newest close before this editor's first edit after it. */
  closeSeq: number;
  /** How many steps undo held just before that edit. */
  depthBefore: number;
}

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

function needsCheckpoint(checkpoints: readonly CloseCheckpoint[]): boolean {
  const latest = latestCloseSeq();
  if (latest === 0) return false;
  const last = checkpoints[checkpoints.length - 1];
  return last === undefined || last.closeSeq < latest;
}

const closeCheckpoints = StateField.define<readonly CloseCheckpoint[]>({
  create: () => [],
  update(checkpoints, tr) {
    if (!isHistoryEdit(tr) || !needsCheckpoint(checkpoints)) return checkpoints;
    const next = [
      ...checkpoints,
      { closeSeq: latestCloseSeq(), depthBefore: undoDepth(tr.startState) },
    ];
    return next.slice(-MAX_CLOSE_CHECKPOINTS);
  },
});

// The first edit after a close starts an undo step of its own: typing just
// before the close and just after it would otherwise share one step, and undo
// would take back the older text with the newer.
const isolateFirstEditAfterClose = EditorState.transactionExtender.of((tr) => {
  if (!isHistoryEdit(tr)) return null;
  const checkpoints = tr.startState.field(closeCheckpoints, false);
  if (checkpoints === undefined || !needsCheckpoint(checkpoints)) return null;
  return { annotations: isolateHistory.of("before") };
});

/** Whether undo in `state` would take back an edit made after close `seq`. */
export function editorHasEditsSinceClose(state: EditorState, seq: number): boolean {
  const checkpoint = state.field(closeCheckpoints, false)?.find((entry) => entry.closeSeq >= seq);
  return checkpoint !== undefined && undoDepth(state) > checkpoint.depthBefore;
}

const registration = ViewPlugin.define((view) => {
  const unregister = registerEditorUndoCheck(view.dom, (seq) =>
    editorHasEditsSinceClose(view.state, seq)
  );
  return { destroy: unregister };
});

/**
 * Lets Cmd+Z tell this editor's newer edits from a panel closed before them,
 * so it undoes the typing first and reopens the panel after (#17107). Needs
 * the editor's `history()`: without it there is nothing to undo here.
 */
export function closeUndoOrdering(): Extension {
  return [closeCheckpoints, isolateFirstEditAfterClose, registration];
}
