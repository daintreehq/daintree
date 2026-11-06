import {
  Annotation,
  Compartment,
  Prec,
  type ChangeDesc,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type StateEffectType,
  type StateField,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";
import {
  history,
  invertedEffects,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from "@codemirror/commands";
import { advanceComposerDraft } from "./composerDraftGeneration";
import { correctionLandingEffects, outsideWrite, type CorrectionReview } from "./correctionReview";
import { lockedHistoryCommand } from "./pendingLock";

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

// Neither can take back or redo a step that changes words still being
// corrected (#15874).
const composerUndo = whileEditable(lockedHistoryCommand(undo));
const composerRedo = whileEditable(lockedHistoryCommand(redo));

// `historyKeymap` minus its selection-only undo (Mod-u, Alt-u): moving the
// caret back through old selections is not an edit, and those keys are free
// for the app.
const composerHistoryKeymap = keymap.of([
  { key: "Mod-z", run: composerUndo, preventDefault: true },
  { key: "Mod-y", mac: "Mod-Shift-z", run: composerRedo, preventDefault: true },
  { linux: "Ctrl-Shift-z", run: composerRedo, preventDefault: true },
]);

// The same locks for the Edit menu's Undo, which reaches the editor as a
// `beforeinput` that `history()` would otherwise run unguarded.
const lockedNativeHistory = Prec.highest(
  EditorView.domEventHandlers({
    beforeinput(event, view) {
      if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return false;
      event.preventDefault();
      (event.inputType === "historyUndo" ? composerUndo : composerRedo)(view);
      return true;
    },
  })
);

export function createComposerHistory(): Extension {
  return [historyCompartment.of(history()), composerHistoryKeymap, lockedNativeHistory];
}

/**
 * Marks an outside write that leaves the caret to the user: the dictation's
 * own words, their cleanup, a file link. A recalled prompt, a handoff or a
 * host's draft moves the caret, and is no part of any dictation.
 */
export const dictationWrite = Annotation.define<true>();

/**
 * An outside write to the draft (a dictated utterance, a correction or
 * file-link swap, a handoff) as one undo step of its own: typing next to it
 * within the grouping delay would otherwise merge into it. A correction that
 * landed in it rides along, so undo and redo carry the correction too, and
 * one already under review stays there while the write leaves it alone. The
 * caret goes to the end of the draft unless `selection` places it. A landed
 * correction a newer dictation has put behind the user comes in unreviewed.
 * A write that leaves the caret to the user (`keepsCaret`) doesn't scroll to
 * it either: dictation is followed by `dictationFollow`, and a cleanup lands
 * where the composer already shows it.
 */
export function outsideDraftWrite(
  change: ChangeSpec,
  draft: string,
  landed: CorrectionReview | null,
  {
    selection = { anchor: draft.length },
    reviewed = true,
    keepsCaret = false,
  }: {
    selection?: { anchor: number; head?: number };
    reviewed?: boolean;
    keepsCaret?: boolean;
  } = {}
): TransactionSpec {
  return {
    changes: change,
    selection,
    scrollIntoView: !keepsCaret,
    effects: landed ? correctionLandingEffects(landed, reviewed) : [],
    annotations: [
      isolateHistory.of("full"),
      outsideWrite.of(true),
      ...(keepsCaret ? [dictationWrite.of(true)] : []),
    ],
  };
}

/**
 * The selection for an outside write that leaves the caret to the user: the
 * one the writer asked for, else the current one carried through the write.
 * A composer without focus has no caret the user is working at, so its caret
 * goes to the end as it does for any other write.
 */
export function selectionAfterOutsideWrite(
  state: EditorState,
  hasFocus: boolean,
  change: ChangeSpec,
  pending: { from: number; to: number } | null
): { anchor: number; head: number } | undefined {
  if (pending) return { anchor: pending.from, head: pending.to };
  if (!hasFocus) return undefined;
  const { anchor, head } = state.selection.main.map(state.changes(change), 1);
  return { anchor, head };
}

/**
 * Drops every undo step. For when the document stops being the same draft — a
 * send, a stash, another panel's draft loading — so Cmd+Z can never bring back
 * a prompt that already went out or text that belongs somewhere else.
 */
export function clearComposerHistory(view: EditorView): void {
  // Ahead of the early returns: a draft with nothing to undo is still a
  // different draft.
  advanceComposerDraft(view);
  if (historyCompartment.get(view.state) === undefined) return;
  if (undoDepth(view.state) === 0 && redoDepth(view.state) === 0) return;
  view.dispatch({ effects: historyCompartment.reconfigure([]) });
  view.dispatch({ effects: historyCompartment.reconfigure(history()) });
}

/**
 * The `map` for a chip's add effect, so an undo step that merged with adjacent
 * typing restores the chip where that typing left it. History also maps stored
 * effects across changes kept out of it (a fleet follower's mirror, a replayed
 * correction), measured against a different document than the one the effect
 * refers to; a chip that cannot be placed that way is dropped, not misplaced.
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
