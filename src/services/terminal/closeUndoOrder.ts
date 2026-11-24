/**
 * Who a Cmd+Z belongs to when a closed panel could come back: the text field
 * under the keyboard, if it was edited after that close, or the close. Every
 * close the person makes takes a number from one counter; an edit remembers
 * the newest close it came after, so "edited since close N" is a comparison,
 * not a clock read.
 *
 * Kept free of CodeMirror and the stores: the window's key handler reads it
 * on every Cmd+Z. Editors register their own check
 * (`closeUndoOrdering` in the composer's extensions).
 */

let closeSeq = 0;

/** A number for a close about to happen, newer than every one before it. */
export function nextCloseSeq(): number {
  closeSeq += 1;
  return closeSeq;
}

/** The newest close's number, `0` before the first. */
export function latestCloseSeq(): number {
  return closeSeq;
}

/** The checkpoints a field keeps: as many as there are closes to undo. */
export const MAX_CLOSE_CHECKPOINTS = 10;

export interface EditorUndo {
  /** Whether the editor's next undo would take back an edit made after close N. */
  hasEditsSince: (closeSeq: number) => boolean;
  /** Runs the editor's own undo, as its key would. */
  undo: () => void;
}

const editors = new WeakMap<Element, EditorUndo>();

const editListeners = new Set<() => void>();

/**
 * Called when what a field's undo would take back next may have changed: an
 * edit, an undo or redo, a history reset. Edit > Undo reads it to know whether
 * the field or the close has Cmd+Z (#17108).
 */
export function subscribeCloseUndoEdits(listener: () => void): () => void {
  editListeners.add(listener);
  return () => {
    editListeners.delete(listener);
  };
}

/** Tells the subscribers a field's undo history moved. Editors call it for their own. */
export function notifyCloseUndoEdit(): void {
  for (const listener of [...editListeners]) listener();
}

/** Registers an editor by its `.cm-editor` root. */
export function registerEditorUndo(root: Element, editor: EditorUndo): () => void {
  editors.set(root, editor);
  return () => {
    if (editors.get(root) === editor) editors.delete(root);
  };
}

type TextField = HTMLInputElement | HTMLTextAreaElement;

interface FieldCheckpoint {
  /** The newest close before this field's first edit after it. */
  closeSeq: number;
  /** The field's value just before that edit. */
  valueBefore: string;
}

interface FieldHistory {
  checkpoints: FieldCheckpoint[];
  /** The value the person's own last edit or undo left. */
  observed: string;
}

const fieldHistories = new WeakMap<TextField, FieldHistory>();

function isTextField(target: EventTarget | null): target is TextField {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

// A native field's undo stack can't be read, so it keeps the value it had
// before its first edit after each close. Undo and redo walk the stack rather
// than edit it, so they leave the checkpoints alone.
function onBeforeInput(event: InputEvent): void {
  const target = event.target;
  if (!isTextField(target)) return;
  if (event.inputType === "historyUndo" || event.inputType === "historyRedo") return;
  const latest = latestCloseSeq();
  if (latest === 0) return;
  const history = fieldHistories.get(target);
  // A value the app set rather than the person typed (a clear button, a
  // loaded draft) starts the field's undo over, and its checkpoints with it.
  const checkpoints =
    history === undefined || history.observed !== target.value ? [] : history.checkpoints;
  const last = checkpoints[checkpoints.length - 1];
  if (last !== undefined && last.closeSeq >= latest) return;
  fieldHistories.set(target, {
    checkpoints: [...checkpoints, { closeSeq: latest, valueBefore: target.value }].slice(
      -MAX_CLOSE_CHECKPOINTS
    ),
    observed: target.value,
  });
}

function onInput(event: Event): void {
  const target = event.target;
  if (!isTextField(target)) return;
  const history = fieldHistories.get(target);
  if (history !== undefined) history.observed = target.value;
  notifyCloseUndoEdit();
}

let fieldTrackingInstalled = false;

/**
 * Starts watching native text fields, once per view and only from the first
 * close on: before it nothing is ordered against a close.
 */
export function trackNativeFieldEdits(): void {
  if (fieldTrackingInstalled || typeof document === "undefined") return;
  fieldTrackingInstalled = true;
  document.addEventListener("beforeinput", onBeforeInput, { capture: true });
  document.addEventListener("input", onInput, { capture: true });
}

function fieldHasEditsSince(field: TextField, seq: number): boolean {
  const history = fieldHistories.get(field);
  // Changed by the app since the person's last edit: nothing of theirs to undo.
  if (history === undefined || history.observed !== field.value) return false;
  const checkpoint = history.checkpoints.find((entry) => entry.closeSeq >= seq);
  return checkpoint !== undefined && field.value !== checkpoint.valueBefore;
}

/**
 * Whether undo in the field holding `target` would take back an edit made
 * after close `seq`. Edits older than the close come after it, and a target
 * that isn't a text field has nothing of its own to undo.
 */
export function hasEditsSinceClose(target: Element, seq: number): boolean {
  const editor = target.closest(".cm-editor");
  if (editor !== null) return editors.get(editor)?.hasEditsSince(seq) ?? false;
  return isTextField(target) && fieldHasEditsSince(target, seq);
}

/**
 * Hands a press the undo-close key already took back to the field holding
 * `target`, for its own undo: an editor's command, or for a native field the
 * frame's Undo, the same one the Edit menu runs.
 */
export function undoFieldText(target: Element | null): void {
  const editor = target?.closest(".cm-editor");
  if (editor) {
    editors.get(editor)?.undo();
    return;
  }
  if (isTextField(target) && typeof document.execCommand === "function") {
    document.execCommand("undo");
  }
}

/** Test seam: forget every close and checkpoint. */
export function resetCloseUndoOrderForTests(): void {
  closeSeq = 0;
  if (fieldTrackingInstalled && typeof document !== "undefined") {
    document.removeEventListener("beforeinput", onBeforeInput, { capture: true });
    document.removeEventListener("input", onInput, { capture: true });
  }
  fieldTrackingInstalled = false;
}
