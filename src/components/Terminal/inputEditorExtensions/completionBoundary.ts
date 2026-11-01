import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

/**
 * A completion token typed straight in front of a word (#15872): `from` is
 * where its trigger went, `to` where the word it was typed against starts.
 */
interface TypedToken {
  from: number;
  to: number;
}

// Every char `ComposerTrigger` names. A run that opens with anything else can
// never be a completion token, so it records nothing.
const TRIGGERS = new Set(["/", "@", "#", "$"]);

const isNonSpace = (char: string) => char !== "" && !/\s/.test(char);

/**
 * The list as it stood before a change, which undo or redo puts back. History
 * maps an undo step's effects through later edits outside the history in the
 * wrong frame, so the snapshot only survives when there were none; otherwise
 * the list is mapped through the undo like any edit.
 */
const restoreTokens = StateEffect.define<readonly TypedToken[]>({
  map: (tokens, mapping) => (mapping.empty ? tokens : undefined),
});

/**
 * Where completion tokens the user typed or pasted in front of a word meet
 * that word. A completion token is the whole whitespace-delimited run around
 * the caret, so without this `/gith` typed against `I found` would take the
 * `I` with it when a completion replaces the token. A token the caret was
 * moved into records nothing, so re-completing it still replaces all of it.
 *
 * Both ends follow edits: text typed at the join or ahead of the trigger goes
 * in front of them. One lasts as long as the word it was typed against, so a
 * space typed at the join and taken out again leaves it as it was.
 */
export const completionBoundaryField = StateField.define<readonly TypedToken[]>({
  create: () => [],
  update(tokens, tr) {
    for (const effect of tr.effects) if (effect.is(restoreTokens)) return effect.value;
    if (!tr.docChanged) return tokens;
    const next = tokens.map(({ from, to }) => ({
      from: tr.changes.mapPos(from, 1),
      to: tr.changes.mapPos(to, 1),
    }));
    if (tr.isUserEvent("input.type") || tr.isUserEvent("input.paste")) {
      const before = tr.startState.doc;
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (!TRIGGERS.has(inserted.sliceString(0, 1))) return;
        const opensWord = fromA === 0 || !isNonSpace(before.sliceString(fromA - 1, fromA));
        if (opensWord && isNonSpace(before.sliceString(toA, toA + 1))) {
          next.push({ from: fromB, to: toB });
        }
      });
    }
    if (next.length === 0) return tokens;
    const { doc } = tr.state;
    return next.filter(({ from, to }) => from < to && isNonSpace(doc.sliceString(to, to + 1)));
  },
});

const restoreOnUndo = invertedEffects.of((tr) => {
  const tokens = tr.startState.field(completionBoundaryField, false);
  return tr.docChanged && tokens && tokens.length > 0 ? [restoreTokens.of(tokens)] : [];
});

export const completionBoundary: Extension = [completionBoundaryField, restoreOnUndo];

/**
 * Where the word starts that the token at `caret` was typed against, for
 * `getActiveCompletionContext` to end the token at. Only a token whose
 * trigger still opens the caret's run counts: one merged into a word before
 * it, or split from the caret by a space, is no longer the token typed.
 */
export function completionBoundaryAt(state: EditorState, caret: number): number | undefined {
  const tokens = state.field(completionBoundaryField, false);
  if (!tokens || tokens.length === 0) return undefined;
  const line = state.doc.lineAt(caret);
  let start = caret - line.from;
  while (start > 0 && isNonSpace(line.text[start - 1]!)) start--;
  const runStart = line.from + start;
  let nearest: number | undefined;
  for (const { from, to } of tokens) {
    if (from !== runStart || to < caret || (nearest !== undefined && to >= nearest)) continue;
    if (!/\s/.test(state.doc.sliceString(caret, to))) nearest = to;
  }
  return nearest;
}
