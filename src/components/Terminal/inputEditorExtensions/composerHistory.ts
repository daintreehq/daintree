import {
  Compartment,
  type ChangeDesc,
  type Extension,
  type StateEffectType,
  type StateField,
} from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import { history, invertedEffects, redo, redoDepth, undo, undoDepth } from "@codemirror/commands";

interface ChipEntryRange {
  from: number;
  to: number;
}

const historyCompartment = new Compartment();

// The commands only refuse a read-only state, and the composer locks itself
// through `editable` instead (disabled, or holding a send for dictation).
const whileEditable =
  (command: Command): Command =>
  (view) =>
    view.state.facet(EditorView.editable) && command(view);

// `historyKeymap` minus its selection-only undo (Mod-u, Alt-u): moving the
// caret back through old selections is not an edit, and those keys are free
// for the app.
const composerHistoryKeymap = keymap.of([
  { key: "Mod-z", run: whileEditable(undo), preventDefault: true },
  { key: "Mod-y", mac: "Mod-Shift-z", run: whileEditable(redo), preventDefault: true },
  { linux: "Ctrl-Shift-z", run: whileEditable(redo), preventDefault: true },
]);

export function createComposerHistory(): Extension {
  return [historyCompartment.of(history()), composerHistoryKeymap];
}

/**
 * Drops every undo step. For when the document stops being the same draft — a
 * send, a stash, another panel's draft loading — so Cmd+Z can never bring back
 * a prompt that already went out or text that belongs somewhere else.
 */
export function clearComposerHistory(view: EditorView): void {
  if (historyCompartment.get(view.state) === undefined) return;
  if (undoDepth(view.state) === 0 && redoDepth(view.state) === 0) return;
  view.dispatch({ effects: historyCompartment.reconfigure([]) });
  view.dispatch({ effects: historyCompartment.reconfigure(history()) });
}

/**
 * The `map` for a chip's add effect, so an undo step that merged with adjacent
 * typing restores the chip where that typing left it. History also maps stored
 * effects across changes kept out of it, measured against a different document
 * than the one the effect refers to; the composer clears its history after
 * those, and a chip that cannot be placed is dropped rather than misplaced.
 */
export function mapChipEntry<T extends ChipEntryRange>(
  entry: T,
  mapping: ChangeDesc
): T | undefined {
  if (entry.to > mapping.length) return undefined;
  const from = mapping.mapPos(entry.from, 1);
  const to = mapping.mapPos(entry.to, -1);
  return from < to ? { ...entry, from, to } : undefined;
}

/**
 * Image and file-drop chips live in a field, not in the text, so undo alone
 * would bring back a deleted chip as its bare path. The entries an edit drops
 * are re-added when it is undone, and the same holds for an undone paste
 * being redone.
 */
export function restoreChipsOnUndo<T extends ChipEntryRange>(
  field: StateField<T[]>,
  add: StateEffectType<T>
): Extension {
  return invertedEffects.of((tr) => {
    if (!tr.docChanged) return [];
    const entries = tr.startState.field(field, false);
    if (!entries || entries.length === 0) return [];
    return entries
      .filter((entry) => {
        let edited = false;
        tr.changes.iterChangedRanges((fromA, toA) => {
          if (fromA < entry.to && toA > entry.from) edited = true;
        });
        return edited;
      })
      .map((entry) => add.of(entry));
  });
}
