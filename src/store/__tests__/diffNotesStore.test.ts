// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  mergeDiffNotesPersistedWrite,
  selectDiffNotes,
  useDiffNotesStore,
} from "../diffNotesStore";
import type { DiffNoteAnchor } from "@/components/Worktree/diffNotes";

const LINE: DiffNoteAnchor = {
  kind: "lines",
  side: "new",
  startLine: 3,
  endLine: 3,
  contentHash: "abc",
};

function add(filePath = "src/a.ts", worktreePath = "/repo", body = "Fix this") {
  return useDiffNotesStore.getState().addNote({ worktreePath, filePath, anchor: LINE, body })!;
}

describe("diffNotesStore", () => {
  beforeEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  });

  it("adds a trimmed note and ignores a blank one", () => {
    const note = add("src/a.ts", "/repo", "  Fix this  ");
    expect(note.body).toBe("Fix this");
    expect(
      useDiffNotesStore.getState().addNote({
        worktreePath: "/repo",
        filePath: "src/a.ts",
        anchor: LINE,
        body: "   ",
      })
    ).toBeNull();
    expect(Object.keys(useDiffNotesStore.getState().notes)).toEqual([note.id]);
  });

  it("scopes selection by worktree and file", () => {
    const a = add("src/a.ts");
    add("src/b.ts");
    add("src/a.ts", "/other");
    const state = useDiffNotesStore.getState();
    expect(selectDiffNotes(state, "/repo")).toHaveLength(2);
    expect(selectDiffNotes(state, "/repo", "src/a.ts").map((n) => n.id)).toEqual([a.id]);
    expect(selectDiffNotes(state, "")).toHaveLength(0);
  });

  it("edits in place and deletes a note saved empty", () => {
    const note = add();
    useDiffNotesStore.getState().saveNote(note, "Rename it");
    expect(useDiffNotesStore.getState().notes[note.id]?.body).toBe("Rename it");
    useDiffNotesStore.getState().saveNote(note, "  ");
    expect(useDiffNotesStore.getState().notes[note.id]).toBeUndefined();
  });

  it("keeps an edit to a note that was sent while its editor was open", () => {
    const note = add();
    useDiffNotesStore.getState().deleteNote(note.id);
    useDiffNotesStore.getState().saveNote(note, "Still relevant");
    const remaining = Object.values(useDiffNotesStore.getState().notes);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.body).toBe("Still relevant");
    expect(remaining[0]!.id).not.toBe(note.id);
  });

  it("clears only the sent notes that are unchanged since the send began", () => {
    const sentAsIs = add("src/a.ts");
    const editedAfter = add("src/b.ts");
    const snapshot = [sentAsIs, editedAfter];
    useDiffNotesStore.getState().saveNote(editedAfter, "Changed my mind");

    const cleared = useDiffNotesStore.getState().clearSent(snapshot);

    expect(cleared).toBe(1);
    const notes = useDiffNotesStore.getState().notes;
    expect(notes[sentAsIs.id]).toBeUndefined();
    expect(notes[editedAfter.id]?.body).toBe("Changed my mind");
  });

  it("tracks open editors per note without persisting them", () => {
    const note = add();
    const { setEditing } = useDiffNotesStore.getState();
    setEditing(note.id, true);
    setEditing(note.id, true);
    setEditing(note.id, false);
    // A second pane still has it open, so the guard holds.
    expect(useDiffNotesStore.getState().editingIds[note.id]).toBe(1);
    const partialize = useDiffNotesStore.persist.getOptions().partialize!;
    expect(Object.keys(partialize(useDiffNotesStore.getState()) as object)).toEqual(["notes"]);
    setEditing(note.id, false);
    expect(useDiffNotesStore.getState().editingIds[note.id]).toBeUndefined();
  });

  it("doesn't let a stale view's send erase a sibling's newer revision", () => {
    const original = add();
    const rewritten = {
      ...original,
      body: "Rewritten elsewhere",
      updatedAt: original.updatedAt + 1,
    };
    const other = add("src/b.ts");
    const merged = mergeDiffNotesPersistedWrite({
      baseline: { version: 0, state: { notes: { [original.id]: original, [other.id]: other } } },
      incoming: { version: 0, state: { notes: {} } },
      onDisk: { version: 0, state: { notes: { [original.id]: rewritten, [other.id]: other } } },
    });
    expect(merged.state.notes).toEqual({ [original.id]: rewritten });
  });

  it("keeps a sibling's rewrite saved in the same millisecond as the stale baseline", () => {
    const original = add();
    const rewritten = { ...original, body: "Same tick, new words" };
    const merged = mergeDiffNotesPersistedWrite({
      baseline: { version: 0, state: { notes: { [original.id]: original } } },
      incoming: { version: 0, state: { notes: {} } },
      onDisk: { version: 0, state: { notes: { [original.id]: rewritten } } },
    });
    expect(merged.state.notes[original.id]?.body).toBe("Same tick, new words");
  });

  it("lets a deletion land when disk still holds the revision the writer saw", () => {
    const original = add();
    const merged = mergeDiffNotesPersistedWrite({
      baseline: { version: 0, state: { notes: { [original.id]: original } } },
      incoming: { version: 0, state: { notes: {} } },
      onDisk: { version: 0, state: { notes: { [original.id]: original } } },
    });
    expect(merged.state.notes).toEqual({});
  });
});
