import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

/**
 * Where text the user typed or pasted in front of a word meets that word
 * (#15872). A completion token is the whole whitespace-delimited run around
 * the caret, so without this `/gith` typed against `I found` would take the
 * `I` with it when a completion replaces the token.
 *
 * A boundary is a position with a non-space character either side. Typing at
 * it stays in front of it; once a space or a line break reaches either side,
 * or the text either side is deleted, it is dropped. Re-completing a token the
 * caret was moved into records nothing, so the whole token is still replaced.
 */
const restoreBoundary = StateEffect.define<number>({
  map: (pos, mapping) => mapping.mapPos(pos, 1),
});

const isNonSpace = (char: string) => char !== "" && !/\s/.test(char);

function joinsWords(state: EditorState, pos: number): boolean {
  const { doc } = state;
  return (
    pos > 0 &&
    pos < doc.length &&
    isNonSpace(doc.sliceString(pos - 1, pos)) &&
    isNonSpace(doc.sliceString(pos, pos + 1))
  );
}

export const completionBoundaryField = StateField.define<readonly number[]>({
  create: () => [],
  update(boundaries, tr) {
    const restored: number[] = [];
    for (const effect of tr.effects) if (effect.is(restoreBoundary)) restored.push(effect.value);
    if (!tr.docChanged && restored.length === 0) return boundaries;

    const next = new Set(boundaries.map((pos) => tr.changes.mapPos(pos, 1)));
    for (const pos of restored) next.add(pos);
    if (tr.isUserEvent("input.type") || tr.isUserEvent("input.paste")) {
      const before = tr.startState.doc;
      tr.changes.iterChanges((fromA, toA, _fromB, toB, inserted) => {
        if (inserted.length === 0) return;
        // Only text written where a word starts: typing inside a token the
        // caret was moved into is still editing that one token.
        const opensWord = fromA === 0 || !isNonSpace(before.sliceString(fromA - 1, fromA));
        if (opensWord && isNonSpace(before.sliceString(toA, toA + 1))) next.add(toB);
      });
    }
    const kept = [...next].filter((pos) => joinsWords(tr.state, pos)).sort((a, b) => a - b);
    return kept.length === boundaries.length && kept.every((pos, i) => pos === boundaries[i])
      ? boundaries
      : kept;
  },
});

// Undo brings back the boundaries a change dropped, so accepting a completion,
// undoing it and picking another still leaves the word alone.
const restoreOnUndo = invertedEffects.of((tr) => {
  if (!tr.docChanged) return [];
  const before = tr.startState.field(completionBoundaryField, false);
  if (!before || before.length === 0) return [];
  const after = tr.state.field(completionBoundaryField);
  return before
    .filter((pos) => !after.includes(tr.changes.mapPos(pos, 1)))
    .map((pos) => restoreBoundary.of(pos));
});

export const completionBoundary: Extension = [completionBoundaryField, restoreOnUndo];

/**
 * The nearest boundary at or after `caret`, for `getActiveCompletionContext`
 * to end the token at. Undefined when the editor doesn't track them.
 */
export function completionBoundaryAt(state: EditorState, caret: number): number | undefined {
  const boundaries = state.field(completionBoundaryField, false);
  return boundaries?.find((pos) => pos >= caret);
}
