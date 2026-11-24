import { describe, expect, it, vi } from "vitest";
import {
  createDiffNoteDraftSession,
  diffNoteFileKey,
  editDraftBodyKey,
  fileDraftBodyKey,
  lineDraftBodyKey,
} from "../diffNoteDrafts";

const FILE = diffNoteFileKey("/repo", "src/a.ts");
const LINES = {
  kind: "lines",
  side: "new",
  startLine: 2,
  endLine: 2,
  contentHash: "h",
} as const;

describe("diff note draft session", () => {
  it("carries a line draft's text when it moves, and drops it when it closes", () => {
    const session = createDiffNoteDraftSession();
    session.openLine(FILE, LINES);
    expect(session.getState().lines[FILE]).toEqual(LINES);
    session.writeBody(lineDraftBodyKey(FILE), "Moving with it");

    session.openLine(FILE, { ...LINES, endLine: 4, contentHash: "h2" });
    expect(session.getState().lines[FILE]).toEqual({ ...LINES, endLine: 4, contentHash: "h2" });
    expect(session.readBody(lineDraftBodyKey(FILE))).toBe("Moving with it");

    session.closeLine(FILE);
    expect(session.getState().lines[FILE]).toBeUndefined();
    expect(session.readBody(lineDraftBodyKey(FILE))).toBeUndefined();
  });

  it("keys drafts by worktree as well as path", () => {
    const session = createDiffNoteDraftSession();
    const elsewhere = diffNoteFileKey("/other", "src/a.ts");
    session.openFile(FILE);
    session.writeBody(fileDraftBodyKey(FILE), "here");

    expect(session.getState().files[elsewhere]).toBeUndefined();
    expect(session.readBody(fileDraftBodyKey(elsewhere))).toBeUndefined();
  });

  it("closes one kind of draft without touching the others", () => {
    const session = createDiffNoteDraftSession();
    session.openLine(FILE, LINES);
    session.openFile(FILE);
    session.openEdit("note-1");
    session.writeBody(lineDraftBodyKey(FILE), "line");
    session.writeBody(fileDraftBodyKey(FILE), "file");
    session.writeBody(editDraftBodyKey("note-1"), "edit");

    session.closeFile(FILE);

    expect(session.getState().files[FILE]).toBeUndefined();
    expect(session.readBody(fileDraftBodyKey(FILE))).toBeUndefined();
    expect(session.getState().lines[FILE]).toBe(LINES);
    expect(session.getState().edits["note-1"]).toBe(true);
    expect(session.readBody(lineDraftBodyKey(FILE))).toBe("line");
    expect(session.readBody(editDraftBodyKey("note-1"))).toBe("edit");

    session.closeEdit("note-1");
    expect(session.getState().edits["note-1"]).toBeUndefined();
    expect(session.readBody(editDraftBodyKey("note-1"))).toBeUndefined();
    expect(session.readBody(lineDraftBodyKey(FILE))).toBe("line");
  });

  it("tells subscribers when a draft opens or closes, but not on every keystroke", () => {
    const session = createDiffNoteDraftSession();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    session.openFile(FILE);
    expect(listener).toHaveBeenCalledTimes(1);
    session.writeBody(fileDraftBodyKey(FILE), "typing");
    expect(listener).toHaveBeenCalledTimes(1);
    session.openFile(FILE);
    expect(listener).toHaveBeenCalledTimes(1);
    session.closeFile(FILE);
    expect(listener).toHaveBeenCalledTimes(2);
    session.closeFile(FILE);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    session.openFile(FILE);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("holds a focus request for the view that made it until its editor takes it, or its draft closes", () => {
    const session = createDiffNoteDraftSession();
    const view = {};
    session.openFile(FILE);
    session.requestFocus(fileDraftBodyKey(FILE), view);
    expect(session.getState().focus).toEqual({ key: fileDraftBodyKey(FILE), owner: view });

    session.consumeFocus(lineDraftBodyKey(FILE));
    expect(session.getState().focus?.key).toBe(fileDraftBodyKey(FILE));
    session.consumeFocus(fileDraftBodyKey(FILE));
    expect(session.getState().focus).toBeNull();

    session.requestFocus(fileDraftBodyKey(FILE), view);
    session.closeLine(FILE);
    expect(session.getState().focus?.key).toBe(fileDraftBodyKey(FILE));
    session.closeFile(FILE);
    expect(session.getState().focus).toBeNull();
  });
});
