import { Transaction, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { ownsComposerState } from "@/lib/composerCaret";
import { keepComposerSnapshot, type ComposerRemountSnapshot } from "@/lib/composerRemount";
import { addFileDropChip, fileDropChipField } from "./fileDropChip";
import { addImageChip, imageChipField } from "./imageChip";

/**
 * Keeps `view`'s image and file chips and its selection for the next editor
 * over `draftKey` (#16883), when it shows the stored draft: text the store
 * doesn't hold goes with the editor, and so do chips on it.
 */
export function keepComposerRemount(view: EditorView, draftKey: string, storedDraft: string): void {
  const draft = view.state.doc.toString();
  if (draft === "" || draft !== storedDraft) return;
  const { anchor, head } = view.state.selection.main;
  keepComposerSnapshot(draftKey, {
    draft,
    images: view.state.field(imageChipField, false) ?? [],
    files: view.state.field(fileDropChipField, false) ?? [],
    selection: { anchor, head },
    caretPublished: ownsComposerState(draftKey, view),
  });
}

/** `state`, showing the snapshot's draft, with its chips and selection put back. */
export function restoreComposerRemount(
  state: EditorState,
  snapshot: ComposerRemountSnapshot
): EditorState {
  return state.update({
    selection: snapshot.selection,
    effects: [
      ...snapshot.images.map((entry) => addImageChip.of({ ...entry })),
      ...snapshot.files.map((entry) => addFileDropChip.of({ ...entry })),
    ],
    annotations: Transaction.addToHistory.of(false),
  }).state;
}
