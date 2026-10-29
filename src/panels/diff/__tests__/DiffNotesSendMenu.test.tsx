// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffNote } from "@/components/Worktree/diffNotes";

const { notifyMock } = vi.hoisted(() => ({ notifyMock: vi.fn() }));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
vi.mock("@/hooks/useDiffNoteDelivery", () => ({
  deliverDiffNotes: vi.fn(),
  useDiffNoteTargets: () => [],
}));
vi.mock("@/components/Terminal/TerminalIcon", () => ({ TerminalIcon: () => null }));

import { offerSentNotesUndo } from "../DiffNotesSendMenu";
import { useDiffNotesStore } from "@/store/diffNotesStore";

function add(filePath: string, body = "Fix this"): DiffNote {
  return useDiffNotesStore.getState().addNote({
    worktreePath: "/repo",
    filePath,
    anchor: { kind: "lines", side: "new", startLine: 2, endLine: 5, contentHash: "h" },
    body,
  })!;
}

function send(notes: DiffNote[], kept = 0) {
  const cleared = useDiffNotesStore.getState().clearSent(notes);
  offerSentNotesUndo({ ok: true, sent: cleared.length, kept, targetTitle: "Claude", cleared });
  const payload = notifyMock.mock.calls.at(-1)![0];
  return { payload, undo: () => payload.action.onClick() };
}

describe("offerSentNotesUndo", () => {
  beforeEach(() => {
    notifyMock.mockReset();
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  });

  it("puts every note a send cleared back exactly, anchors and timestamps included", () => {
    const first = add("src/a.ts");
    const second = add("src/b.ts");
    const { undo } = send([first, second]);
    expect(useDiffNotesStore.getState().notes).toEqual({});

    undo();

    expect(useDiffNotesStore.getState().notes).toEqual({
      [first.id]: first,
      [second.id]: second,
    });
  });

  it("names how many went where, and that Undo leaves the paste behind", () => {
    const { payload } = send([add("src/a.ts"), add("src/b.ts")], 1);
    expect(payload.title).toBe("Notes sent");
    expect(payload.message).toBe(
      "Pasted 2 notes into Claude. Undo restores them but leaves the pasted text in place."
    );
    expect(send([add("src/c.ts")]).payload.title).toBe("Note sent");
  });

  it("offers nothing when the send cleared nothing", () => {
    offerSentNotesUndo({ ok: true, sent: 0, kept: 1, targetTitle: "Claude", cleared: [] });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("lets only the newest toast holding a note bring it back", () => {
    const note = add("src/a.ts", "First words");
    const older = send([note]);
    // Back and rewritten, then sent again: the first toast's snapshot is stale.
    useDiffNotesStore.getState().restoreNotes([note]);
    useDiffNotesStore.getState().saveNote(note, "Second words");
    const rewritten = useDiffNotesStore.getState().notes[note.id]!;
    const newer = send([rewritten]);

    older.undo();
    expect(useDiffNotesStore.getState().notes).toEqual({});

    newer.undo();
    expect(useDiffNotesStore.getState().notes[note.id]?.body).toBe("Second words");
  });
});
