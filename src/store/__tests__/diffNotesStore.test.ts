// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { selectDiffNotes, useDiffNotesStore } from "../diffNotesStore";
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

  it("tracks open editors without persisting them", () => {
    const note = add();
    useDiffNotesStore.getState().setEditing(note.id, true);
    expect(useDiffNotesStore.getState().editingIds[note.id]).toBe(true);
    const partialize = useDiffNotesStore.persist.getOptions().partialize!;
    expect(Object.keys(partialize(useDiffNotesStore.getState()) as object)).toEqual(["notes"]);
    useDiffNotesStore.getState().setEditing(note.id, false);
    expect(useDiffNotesStore.getState().editingIds[note.id]).toBeUndefined();
  });
});
