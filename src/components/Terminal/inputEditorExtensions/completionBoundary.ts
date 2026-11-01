import { StateField, type EditorState, type Text } from "@codemirror/state";

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
 * Still one unbroken run from a word start through the first char of the word
 * it was typed against. A space typed anywhere in it, or a deleted space that
 * merges it into the word before, means it no longer marks a token's end.
 */
function holds(doc: Text, { from, to }: TypedToken): boolean {
  if (from >= to || to >= doc.length) return false;
  if (from > 0 && isNonSpace(doc.sliceString(from - 1, from))) return false;
  return !/\s/.test(doc.sliceString(from, to + 1));
}

/**
 * Where a completion token the user typed or pasted in front of a word meets
 * that word. A completion token is the whole whitespace-delimited run around
 * the caret, so without this `/gith` typed against `I found` would take the
 * `I` with it when a completion replaces the token. Typing at the join stays
 * in front of it. A token the caret was moved into records nothing, so
 * re-completing it still replaces all of it.
 *
 * Undo and redo record by the same rule: undoing an accepted completion puts
 * the typed token back in front of the word, which marks it again.
 */
export const completionBoundary = StateField.define<readonly TypedToken[]>({
  create: () => [],
  update(tokens, tr) {
    if (!tr.docChanged) return tokens;
    const next = tokens.map(({ from, to }) => ({
      from: tr.changes.mapPos(from, -1),
      to: tr.changes.mapPos(to, 1),
    }));
    if (
      tr.isUserEvent("input.type") ||
      tr.isUserEvent("input.paste") ||
      tr.isUserEvent("undo") ||
      tr.isUserEvent("redo")
    ) {
      const before = tr.startState.doc;
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (!TRIGGERS.has(inserted.sliceString(0, 1))) return;
        const opensWord = fromA === 0 || !isNonSpace(before.sliceString(fromA - 1, fromA));
        if (opensWord && isNonSpace(before.sliceString(toA, toA + 1))) {
          next.push({ from: fromB, to: toB });
        }
      });
    }
    const kept = next.filter((token) => holds(tr.state.doc, token)).sort((a, b) => a.to - b.to);
    return kept.filter((token, i) => i === 0 || token.to !== kept[i - 1]!.to);
  },
});

/**
 * Where the word starts that a token at `caret` was typed against, for
 * `getActiveCompletionContext` to end the token at: the nearest join at or
 * after the caret. Undefined when there is none or the editor doesn't track
 * them.
 */
export function completionBoundaryAt(state: EditorState, caret: number): number | undefined {
  const tokens = state.field(completionBoundary, false);
  return tokens?.find((token) => token.to >= caret && token.from < caret)?.to;
}
