/**
 * The part of a composer's editor state dictation reads. Structural, so this
 * module stays free of the editor's packages.
 */
export interface ComposerSnapshot {
  doc: { length: number; toString(): string };
  selection: { main: { from: number; to: number } };
}

/**
 * Each composer's latest editor state, kept for as long as the composer has
 * been focused at least once, so dictation can start where the user left the
 * caret. Keyed by draft key (`makeDraftKey`): a pane's composer and an
 * isolated one can type to the same terminal with drafts of their own.
 */
const states = new Map<string, { owner: object; state: ComposerSnapshot }>();

export function recordComposerState(
  draftKey: string,
  owner: object,
  state: ComposerSnapshot
): void {
  states.set(draftKey, { owner, state });
}

/** Forgets the draft's state, unless another composer has recorded one since. */
export function forgetComposerState(draftKey: string, owner: object): void {
  if (states.get(draftKey)?.owner === owner) states.delete(draftKey);
}

/**
 * The composer's selection in `draft`, or null when the composer was never
 * focused or no longer shows that draft: positions in any other text would
 * place the dictation somewhere the user never pointed at.
 */
export function readComposerSelection(
  draftKey: string,
  draft: string
): { from: number; to: number } | null {
  const state = states.get(draftKey)?.state;
  if (!state || state.doc.length !== draft.length || state.doc.toString() !== draft) return null;
  const { from, to } = state.selection.main;
  return { from, to };
}

/**
 * Where a composer's caret goes once it shows `draft`, set by a writer whose
 * text went in at the caret, so the caret follows that text instead of being
 * left wherever mapping puts it.
 */
const pendingSelections = new Map<string, { draft: string; from: number; to: number }>();

export function setPendingComposerSelection(
  draftKey: string,
  draft: string,
  selection: { from: number; to: number }
): void {
  pendingSelections.set(draftKey, { draft, ...selection });
}

/** The selection still waiting for the composer to show `draft`, left in place. */
export function peekPendingComposerSelection(
  draftKey: string,
  draft: string
): { from: number; to: number } | null {
  const pending = pendingSelections.get(draftKey);
  return pending?.draft === draft ? { from: pending.from, to: pending.to } : null;
}

/** The pending selection for `draft`; any pending one is used up either way. */
export function takePendingComposerSelection(
  draftKey: string,
  draft: string
): { from: number; to: number } | null {
  const pending = peekPendingComposerSelection(draftKey, draft);
  pendingSelections.delete(draftKey);
  return pending;
}
