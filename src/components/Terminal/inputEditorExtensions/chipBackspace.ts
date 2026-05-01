import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { StateField, StateEffect, Prec, type Extension } from "@codemirror/state";

export interface ChipPendingDelete {
  from: number;
  to: number;
}

export const setChipPendingDelete = StateEffect.define<ChipPendingDelete | null>();

export const chipPendingDeleteField = StateField.define<ChipPendingDelete | null>({
  create() {
    return null;
  },
  update(value, tr) {
    if (tr.docChanged) value = null;

    for (const effect of tr.effects) {
      if (effect.is(setChipPendingDelete)) {
        value = effect.value;
      }
    }

    if (value && tr.selection) {
      const sel = tr.selection.main;
      const matchesRange = sel.from === value.from && sel.to === value.to;
      const cursorAtEdge = sel.empty && (sel.head === value.from || sel.head === value.to);
      if (!matchesRange && !cursorAtEdge) {
        value = null;
      }
    }

    if (value) {
      const docLen = tr.state.doc.length;
      if (value.from < 0 || value.to > docLen || value.from >= value.to) {
        value = null;
      }
    }

    return value;
  },
});

function findAtomicRangeBefore(view: EditorView, pos: number): ChipPendingDelete | null {
  if (pos <= 0) return null;
  const facets = view.state.facet(EditorView.atomicRanges);
  let found: ChipPendingDelete | null = null;
  for (const getRanges of facets) {
    const set = getRanges(view);
    if (!set) continue;
    set.between(pos - 1, pos, (from, to) => {
      if (to === pos && from < pos) {
        found = { from, to };
        return false;
      }
      return undefined;
    });
    if (found) break;
  }
  return found;
}

function findAtomicRangeCovering(
  view: EditorView,
  from: number,
  to: number
): ChipPendingDelete | null {
  if (from >= to) return null;
  const facets = view.state.facet(EditorView.atomicRanges);
  let found: ChipPendingDelete | null = null;
  for (const getRanges of facets) {
    const set = getRanges(view);
    if (!set) continue;
    set.between(from, to, (rFrom, rTo) => {
      if (rFrom === from && rTo === to) {
        found = { from: rFrom, to: rTo };
        return false;
      }
      return undefined;
    });
    if (found) break;
  }
  return found;
}

const backspaceBinding: KeyBinding = {
  key: "Backspace",
  run(view) {
    const sel = view.state.selection.main;

    if (!sel.empty) {
      const covered = findAtomicRangeCovering(view, sel.from, sel.to);
      if (covered) {
        view.dispatch({
          changes: { from: covered.from, to: covered.to, insert: "" },
          effects: setChipPendingDelete.of(null),
        });
        return true;
      }
      return false;
    }

    const chip = findAtomicRangeBefore(view, sel.head);
    if (!chip) return false;

    const staged = view.state.field(chipPendingDeleteField, false) ?? null;
    const alreadyStaged = !!staged && staged.from === chip.from && staged.to === chip.to;

    if (alreadyStaged) {
      view.dispatch({
        changes: { from: chip.from, to: chip.to, insert: "" },
        effects: setChipPendingDelete.of(null),
      });
      return true;
    }

    view.dispatch({
      effects: setChipPendingDelete.of(chip),
      selection: { anchor: chip.from, head: chip.to },
    });
    return true;
  },
};

export function createChipBackspaceKeymap(): Extension {
  return Prec.highest(keymap.of([backspaceBinding]));
}

export function isChipSelected(
  pending: ChipPendingDelete | null,
  from: number,
  to: number
): boolean {
  return !!pending && pending.from === from && pending.to === to;
}
