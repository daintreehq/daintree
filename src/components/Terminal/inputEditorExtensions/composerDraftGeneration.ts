import type { EditorView } from "@codemirror/view";

const generations = new WeakMap<EditorView, number>();

/**
 * Which draft `view` holds. Editing the draft never changes it; starting a
 * different one does (a send, a stash, another panel's draft loading), so
 * work that began on one draft can tell, once it is ready, that the draft
 * is gone.
 */
export function composerDraftGeneration(view: EditorView): number {
  return generations.get(view) ?? 0;
}

export function advanceComposerDraft(view: EditorView): void {
  generations.set(view, composerDraftGeneration(view) + 1);
}
