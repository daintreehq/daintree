/**
 * A reference only parses at a boundary: `look at this@a.ts` carries no `@file`
 * token, and an absolute path glued to a word is no path at all. Every way of
 * inserting one at the caret (attach button, drop, paste) leads with this.
 */
export function referenceSeparatorAt(
  state: { doc: { sliceString(from: number, to: number): string } },
  cursor: number
): string {
  return cursor > 0 && !/[\s([{]/.test(state.doc.sliceString(cursor - 1, cursor)) ? " " : "";
}
