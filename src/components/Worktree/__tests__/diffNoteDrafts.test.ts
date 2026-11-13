import { afterEach, describe, expect, it, vi } from "vitest";
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("carries a line draft's text when it moves, and drops it when it closes", () => {
    const session = createDiffNoteDraftSession();
    session.openLine(FILE, LINES);
    session.writeBody(lineDraftBodyKey(FILE), "Moving with it");

    session.openLine(FILE, { ...LINES, endLine: 4 });
    expect(session.readBody(lineDraftBodyKey(FILE))).toBe("Moving with it");

    session.closeLine(FILE);
    expect(session.getState().lines[FILE]).toBeUndefined();
    expect(session.readBody(lineDraftBodyKey(FILE))).toBeUndefined();
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
    expect(session.getState().lines[FILE]).toBe(LINES);
    expect(session.getState().edits["note-1"]).toBe(true);
    expect(session.readBody(lineDraftBodyKey(FILE))).toBe("line");
    expect(session.readBody(editDraftBodyKey("note-1"))).toBe("edit");
  });

  it("tells subscribers when a draft opens or closes, but not on every keystroke", () => {
    const session = createDiffNoteDraftSession();
    const listener = vi.fn();
    session.subscribe(listener);

    session.openFile(FILE);
    session.writeBody(fileDraftBodyKey(FILE), "typing");
    session.openFile(FILE);
    session.closeFile(FILE);

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("lets a focus request lapse once the task that made it is over", () => {
    vi.useFakeTimers();
    const session = createDiffNoteDraftSession();
    session.requestFocus(fileDraftBodyKey(FILE));
    expect(session.wantsFocus(fileDraftBodyKey(FILE))).toBe(true);

    vi.advanceTimersByTime(0);
    expect(session.wantsFocus(fileDraftBodyKey(FILE))).toBe(false);
  });
});
