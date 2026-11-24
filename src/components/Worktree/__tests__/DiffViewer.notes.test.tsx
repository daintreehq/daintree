// @vitest-environment jsdom
import React, { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventMap, HunkData } from "react-diff-view";
import { DiffViewer, _flushLangLoadsForTests, _resetLangStateForTests } from "../DiffViewer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { PendingFileNotes } from "../DiffNoteWidgets";
import { DiffNoteDraftContext, useOwnDiffNoteDraftSession } from "../diffNoteDrafts";
import { buildDiffLineIndex, hashLineRange } from "../diffNotes";
import { parseDiff } from "react-diff-view";

const { captured } = vi.hoisted(() => ({
  captured: {} as {
    hunks?: HunkData[];
    widgets?: Record<string, React.ReactNode>;
    gutterEvents?: EventMap;
    selectedChanges?: string[];
    /** Holds row widgets back, as a large table does while its rows stage in. */
    holdWidgets?: boolean;
  },
}));

vi.mock("react-diff-view", async () => {
  const actual = await vi.importActual<typeof import("react-diff-view")>("react-diff-view");
  return {
    ...actual,
    Diff: (props: {
      children: (hunks: unknown[]) => React.ReactNode;
      hunks: HunkData[];
      widgets?: Record<string, React.ReactNode>;
      gutterEvents?: EventMap;
      selectedChanges?: string[];
    }) => {
      captured.hunks = props.hunks;
      captured.widgets = props.widgets;
      captured.gutterEvents = props.gutterEvents;
      captured.selectedChanges = props.selectedChanges;
      return (
        <div data-testid="diff-element">
          {props.children(props.hunks)}
          {props.hunks.flatMap((hunk, hunkIndex) =>
            hunk.changes.flatMap((change, changeIndex) =>
              (["old", "new"] as const).map((side) => (
                <button
                  key={`${hunkIndex}-${changeIndex}-${side}`}
                  type="button"
                  data-testid={`gutter-${changeIndex}-${side}`}
                  onClick={(event) => props.gutterEvents?.onClick?.({ change, side }, event)}
                />
              ))
            )
          )}
          {Object.entries(captured.holdWidgets ? {} : (props.widgets ?? {})).map(([key, node]) => (
            <div key={key} data-widget-key={key}>
              {node}
            </div>
          ))}
        </div>
      );
    },
    Hunk: () => <div data-testid="hunk" />,
    tokenize: vi.fn(),
    markEdits: vi.fn(() => vi.fn()),
  };
});

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 0123456..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+added
 line2
-line3`;

const REFRESHED_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 0123456..1234567 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 line1
+rewritten
 line2
-line3`;

function renderViewer(diff = DIFF, withNotes = true) {
  return render(
    <TooltipProvider>
      <DiffViewer diff={diff} annotations={withNotes ? { worktreePath: "/repo" } : undefined} />
    </TooltipProvider>
  );
}

function clickGutter(changeIndex: number, side: "old" | "new", shiftKey = false) {
  fireEvent.click(screen.getByTestId(`gutter-${changeIndex}-${side}`), { shiftKey });
}

// Same settling as DiffViewer.test.tsx: in-thread tokenization logs and sets
// state after a test ends, which trips vitest's teardown RPC unless the console
// noise is silenced and the queue drained inside act().
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  _resetLangStateForTests();
});
afterEach(async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await _flushLangLoadsForTests();
  });
});

describe("DiffViewer review notes", () => {
  beforeEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    captured.hunks = undefined;
    captured.widgets = undefined;
    captured.gutterEvents = undefined;
    captured.selectedChanges = undefined;
  });

  afterEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  });

  it("takes no gutter clicks when notes aren't enabled", () => {
    renderViewer(DIFF, false);
    expect(captured.gutterEvents).toBeUndefined();
    expect(screen.queryByLabelText("Add file note")).toBeNull();
  });

  it("adds a line note from a gutter click and shows it under that line", () => {
    renderViewer();
    clickGutter(1, "new");

    expect(captured.selectedChanges).toEqual(["I2"]);
    const textarea = screen.getByLabelText("New note on line 2");
    fireEvent.change(textarea, { target: { value: "Why add this?" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    const notes = Object.values(useDiffNotesStore.getState().notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      worktreePath: "/repo",
      filePath: "src/a.ts",
      body: "Why add this?",
      anchor: { kind: "lines", side: "new", startLine: 2, endLine: 2 },
    });
    expect(captured.widgets?.I2).toBeDefined();
    expect(screen.getByText("Why add this?")).toBeTruthy();
  });

  it("extends a draft across a contiguous range with shift-click", () => {
    renderViewer();
    clickGutter(0, "new");
    clickGutter(2, "new", true);
    expect(captured.selectedChanges).toEqual(["N1", "I2", "N2"]);
    expect(screen.getByLabelText("New note on lines 1–3")).toBeTruthy();
  });

  it("keeps typed draft text when shift-click moves the composer to a new row", () => {
    renderViewer();
    clickGutter(0, "new");
    fireEvent.change(screen.getByLabelText("New note on line 1"), {
      target: { value: "Covers both" },
    });
    clickGutter(2, "new", true);
    const extended = screen.getByLabelText("New note on lines 1–3");
    expect(extended instanceof HTMLTextAreaElement && extended.value).toBe("Covers both");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    clickGutter(0, "new");
    const fresh = screen.getByLabelText("New note on line 1");
    expect(fresh instanceof HTMLTextAreaElement && fresh.value).toBe("");
  });

  it("anchors a removed line to the old side", () => {
    renderViewer();
    clickGutter(3, "new");
    expect(captured.selectedChanges).toEqual(["D3"]);
    expect(screen.getByLabelText("New note on line 3 (removed lines)")).toBeTruthy();
  });

  it("adds a file note from the header", () => {
    renderViewer();
    fireEvent.click(screen.getByLabelText("Add file note"));
    fireEvent.change(screen.getByLabelText("New file note"), {
      target: { value: "Split this file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(Object.values(useDiffNotesStore.getState().notes)[0]?.anchor).toEqual({ kind: "file" });
    expect(screen.getByTestId("diff-file-notes").textContent).toContain("Split this file");
  });

  it("keeps a note visible and marked stale when the diff changes under it", () => {
    const { rerender } = renderViewer();
    clickGutter(1, "new");
    fireEvent.change(screen.getByLabelText("New note on line 2"), {
      target: { value: "Check this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    rerender(
      <TooltipProvider>
        <DiffViewer diff={REFRESHED_DIFF} annotations={{ worktreePath: "/repo" }} />
      </TooltipProvider>
    );

    expect(captured.widgets).toBeUndefined();
    const detached = screen.getByTestId("diff-file-notes");
    expect(detached.textContent).toContain("Check this");
    expect(detached.textContent).toContain("Outdated");
    expect(Object.values(useDiffNotesStore.getState().notes)).toHaveLength(1);
  });

  it("edits and deletes a note in place", () => {
    renderViewer();
    fireEvent.click(screen.getByLabelText("Add file note"));
    fireEvent.change(screen.getByLabelText("New file note"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    const editor = screen.getByLabelText("Edit file note");
    const id = Object.keys(useDiffNotesStore.getState().notes)[0]!;
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);
    fireEvent.change(editor, { target: { value: "Second" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useDiffNotesStore.getState().notes[id]?.body).toBe("Second");
    expect(useDiffNotesStore.getState().editingIds[id]).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(useDiffNotesStore.getState().notes).toEqual({});
  });

  it("lists a file's notes where there is no diff table to hold them", () => {
    const { addNote } = useDiffNotesStore.getState();
    addNote({
      worktreePath: "/repo",
      filePath: "src/a.ts",
      anchor: { kind: "lines", side: "new", startLine: 2, endLine: 2, contentHash: "h" },
      body: "Still needed",
    });
    addNote({
      worktreePath: "/repo",
      filePath: "src/b.ts",
      anchor: { kind: "file" },
      body: "Other file",
    });
    render(
      <TooltipProvider>
        <PendingFileNotes worktreePath="/repo" filePath="src/a.ts" />
      </TooltipProvider>
    );
    const list = screen.getByTestId("diff-pending-file-notes");
    expect(list.textContent).toContain("Still needed");
    expect(list.textContent).toContain("Not shown");
    expect(list.textContent).not.toContain("Other file");
  });
});

const OTHER_FILE_DIFF = `diff --git a/src/b.ts b/src/b.ts
index 1111111..2222222 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
 keep
-old
+new`;

// The same file, edited far below: line 2 is no longer in any hunk.
const DISTANT_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 0123456..7654321 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -20,2 +20,2 @@
 keep
-before
+after`;

function line2Hash(diff: string): string | null {
  const [file] = parseDiff(diff);
  return hashLineRange(buildDiffLineIndex(file!.hunks), "new", 2, 2);
}

/**
 * Stands in for the diff pane: it owns the draft session above whatever body
 * is showing, the way the pane holds it above the table, its loading skeleton,
 * rendered Markdown and the fallback list. The path pill outlives every body,
 * as the pane's toolbar does.
 */
function Pane({
  body,
  diff = DIFF,
  worktreePath = "/repo",
  listFile = "src/a.ts",
  wrap = false,
}: {
  body: "table" | "list" | "loading";
  diff?: string;
  worktreePath?: string;
  listFile?: string;
  /** Any prop change that re-renders the table, as more rows staging in would. */
  wrap?: boolean;
}) {
  const session = useOwnDiffNoteDraftSession();
  return (
    <TooltipProvider>
      <div data-panel-id="pane">
        <button type="button" data-toolbar-path="">
          src/a.ts
        </button>
        <DiffNoteDraftContext value={session}>
          {body === "table" && (
            <DiffViewer diff={diff} annotations={{ worktreePath }} wrapLines={wrap} />
          )}
          {body === "list" && <PendingFileNotes worktreePath={worktreePath} filePath={listFile} />}
        </DiffNoteDraftContext>
      </div>
    </TooltipProvider>
  );
}

function field(label: string): HTMLTextAreaElement {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`${label} isn't a textarea`);
  return element;
}

function type(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

function composerOf(label: string): HTMLElement {
  return field(label).closest<HTMLElement>("[data-testid='diff-note-composer']")!;
}

function pathPill(): HTMLElement {
  return screen.getByRole("button", { name: "src/a.ts" });
}

function addFileNote(body: string): string {
  const note = useDiffNotesStore.getState().addNote({
    worktreePath: "/repo",
    filePath: "src/a.ts",
    anchor: { kind: "file" },
    body,
  });
  return note!.id;
}

describe("unsaved note drafts", () => {
  beforeEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    captured.widgets = undefined;
    captured.holdWidgets = false;
  });

  afterEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
    captured.holdWidgets = false;
  });

  it("keeps an open line draft and its text through a refresh that unmounts the table", () => {
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    expect(document.activeElement).toBe(field("New note on line 2"));
    type("New note on line 2", "Half a thought");

    // The reviewer moves on before the refresh lands.
    pathPill().focus();
    rerender(<Pane body="loading" />);
    expect(screen.queryByTestId("diff-note-composer")).toBeNull();
    rerender(<Pane body="table" />);

    expect(field("New note on line 2").value).toBe("Half a thought");
    expect(captured.widgets?.I2).toBeDefined();
    // Restored where it was, without taking focus back from where the reviewer went.
    expect(document.activeElement).toBe(pathPill());
  });

  it("focuses a composer whose row mounts after the gesture that opened it", () => {
    captured.holdWidgets = true;
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    expect(screen.queryByLabelText("New note on line 2")).toBeNull();

    captured.holdWidgets = false;
    rerender(<Pane body="table" wrap />);

    expect(document.activeElement).toBe(field("New note on line 2"));
  });

  it("never hands a gesture's waiting focus to an editor another view restores", () => {
    captured.holdWidgets = true;
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    pathPill().focus();

    // Straight to a layout without the table, before the row ever mounted.
    rerender(<Pane body="list" />);
    expect(field("New note on line 2")).toBeTruthy();
    expect(document.activeElement).toBe(pathPill());

    captured.holdWidgets = false;
    rerender(<Pane body="table" />);
    expect(captured.widgets?.I2).toBeDefined();
    expect(document.activeElement).toBe(pathPill());
  });

  it("hands focus to the diff when a restored line draft closes, having no opener to return to", () => {
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    rerender(<Pane body="loading" />);
    rerender(<Pane body="table" />);

    field("New note on line 2").focus();
    fireEvent.keyDown(field("New note on line 2"), { key: "Escape" });

    expect(screen.queryByTestId("diff-note-composer")).toBeNull();
    expect(document.activeElement?.getAttribute("role")).toBe("region");
  });

  it("lists a draft whose rows changed under a new revision as outdated, and saves it against what was read", () => {
    const originalHash = line2Hash(DIFF);
    expect(originalHash).not.toBe(line2Hash(REFRESHED_DIFF));

    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    expect(captured.widgets?.I2).toBeDefined();
    const before = field("New note on line 2");
    type("New note on line 2", "Why add this?");

    // No loading step: the new revision remounts the file view in place.
    rerender(<Pane body="table" diff={REFRESHED_DIFF} />);

    expect(before.isConnected).toBe(false);
    expect(captured.widgets).toBeUndefined();
    expect(screen.getAllByTestId("diff-note-composer")).toHaveLength(1);
    expect(screen.getByTestId("diff-file-notes").textContent).toContain("Outdated");
    expect(field("New note on line 2").value).toBe("Why add this?");

    fireEvent.click(screen.getByRole("button", { name: "Add note" }));

    const notes = Object.values(useDiffNotesStore.getState().notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toBe("Why add this?");
    expect(notes[0]!.anchor).toEqual({
      kind: "lines",
      side: "new",
      startLine: 2,
      endLine: 2,
      contentHash: originalHash,
    });
    expect(screen.queryByTestId("diff-note-composer")).toBeNull();
  });

  it("lists a draft whose rows a new revision doesn't show as not shown", () => {
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    type("New note on line 2", "Still here");

    rerender(<Pane body="table" diff={DISTANT_DIFF} />);

    const detached = screen.getByTestId("diff-file-notes");
    expect(detached.textContent).toContain("Not shown");
    expect(detached.textContent).not.toContain("Outdated");
    expect(field("New note on line 2").value).toBe("Still here");

    rerender(<Pane body="table" />);
    expect(captured.widgets?.I2).toBeDefined();
    expect(field("New note on line 2").value).toBe("Still here");
  });

  it("keeps each file's drafts while another file is on screen", () => {
    const { rerender } = render(<Pane body="table" />);
    fireEvent.click(screen.getByLabelText("Add file note"));
    type("New file note", "About a.ts");

    rerender(<Pane body="table" diff={OTHER_FILE_DIFF} />);
    expect(screen.queryByLabelText("New file note")).toBeNull();
    fireEvent.click(screen.getByLabelText("Add file note"));
    type("New file note", "About b.ts");

    rerender(<Pane body="table" />);
    expect(field("New file note").value).toBe("About a.ts");
    rerender(<Pane body="table" diff={OTHER_FILE_DIFF} />);
    expect(field("New file note").value).toBe("About b.ts");

    // The same path in another worktree is another file.
    rerender(<Pane body="table" worktreePath="/other" />);
    expect(screen.queryByLabelText("New file note")).toBeNull();
  });

  it("keeps a line draft and a file draft apart", () => {
    render(<Pane body="table" />);
    clickGutter(1, "new");
    type("New note on line 2", "About this line");

    fireEvent.click(screen.getByLabelText("Add file note"));

    expect(field("New file note").value).toBe("");
    expect(field("New note on line 2").value).toBe("About this line");
    expect(document.activeElement).toBe(field("New file note"));

    type("New file note", "About the file");
    fireEvent.click(within(composerOf("New file note")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("New file note")).toBeNull();
    expect(field("New note on line 2").value).toBe("About this line");

    // Cancelled text is gone; the other draft is untouched either way round.
    fireEvent.click(screen.getByLabelText("Add file note"));
    expect(field("New file note").value).toBe("");
    type("New file note", "Second go");
    fireEvent.click(
      within(composerOf("New note on line 2")).getByRole("button", { name: "Cancel" })
    );
    expect(screen.queryByLabelText("New note on line 2")).toBeNull();
    expect(field("New file note").value).toBe("Second go");
  });

  it("lists unsaved drafts with the notes where the layout has no table, and keeps writing them there", () => {
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    type("New note on line 2", "Line draft");
    fireEvent.click(screen.getByLabelText("Add file note"));
    type("New file note", "File draft");

    rerender(<Pane body="list" />);

    const list = screen.getByTestId("diff-pending-file-notes");
    expect(field("New note on line 2").value).toBe("Line draft");
    expect(field("New file note").value).toBe("File draft");
    expect(list.textContent).toContain("Not shown");
    type("New note on line 2", "Line draft, revised");
    type("New file note", "File draft, revised");

    rerender(<Pane body="table" />);
    expect(captured.widgets?.I2).toBeDefined();
    expect(field("New note on line 2").value).toBe("Line draft, revised");
    expect(field("New file note").value).toBe("File draft, revised");
  });

  it("shows each file's own draft in a fallback list that stays mounted across files", () => {
    const { rerender } = render(<Pane body="table" />);
    fireEvent.click(screen.getByLabelText("Add file note"));
    type("New file note", "About a.ts");
    rerender(<Pane body="table" diff={OTHER_FILE_DIFF} />);
    fireEvent.click(screen.getByLabelText("Add file note"));
    type("New file note", "About b.ts");

    rerender(<Pane body="list" />);
    expect(field("New file note").value).toBe("About a.ts");
    rerender(<Pane body="list" listFile="src/b.ts" />);
    expect(field("New file note").value).toBe("About b.ts");
    type("New file note", "About b.ts, revised");

    rerender(<Pane body="list" />);
    expect(field("New file note").value).toBe("About a.ts");
  });

  it("hands focus to the path pill when a draft closes in the fallback list", () => {
    const { rerender } = render(<Pane body="table" />);
    fireEvent.click(screen.getByLabelText("Add file note"));
    rerender(<Pane body="list" />);

    field("New file note").focus();
    fireEvent.keyDown(field("New file note"), { key: "Escape" });

    expect(screen.queryByLabelText("New file note")).toBeNull();
    expect(document.activeElement).toBe(pathPill());
  });

  it("keeps a note's rewrite open, and held back from sending, while its card is gone", () => {
    const id = addFileNote("First");
    const { rerender, unmount } = render(<Pane body="table" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(document.activeElement).toBe(field("Edit file note"));
    type("Edit file note", "Second");

    rerender(<Pane body="loading" />);
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);

    // Back in the fallback list, a different card picks up the same rewrite.
    rerender(<Pane body="list" />);
    expect(field("Edit file note").value).toBe("Second");
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);

    rerender(<Pane body="table" />);
    expect(field("Edit file note").value).toBe("Second");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useDiffNotesStore.getState().notes[id]?.body).toBe("Second");
    expect(useDiffNotesStore.getState().editingIds[id]).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);
    // Closing the pane drops its drafts, and with them the send guard.
    unmount();
    expect(useDiffNotesStore.getState().editingIds[id]).toBeUndefined();
  });

  it("holds one send guard per pane editing a note, in StrictMode too", () => {
    const id = addFileNote("Shared");
    const first = render(
      <StrictMode>
        <Pane body="table" />
      </StrictMode>
    );
    fireEvent.click(within(first.container).getByRole("button", { name: "Edit note" }));
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);

    const second = render(<Pane body="table" />);
    fireEvent.click(within(second.container).getByRole("button", { name: "Edit note" }));
    fireEvent.change(within(second.container).getByLabelText("Edit file note"), {
      target: { value: "Second pane's words" },
    });
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(2);

    first.rerender(
      <StrictMode>
        <Pane body="loading" />
      </StrictMode>
    );
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(2);
    first.unmount();
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);
    const left = within(second.container).getByLabelText("Edit file note");
    expect(left instanceof HTMLTextAreaElement && left.value).toBe("Second pane's words");

    fireEvent.click(within(second.container).getByRole("button", { name: "Cancel" }));
    expect(useDiffNotesStore.getState().editingIds[id]).toBeUndefined();
  });

  it("starts an edit from the saved note once the last one was cancelled", () => {
    addFileNote("Saved words");
    render(<Pane body="table" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    type("Edit file note", "Discarded");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(field("Edit file note").value).toBe("Saved words");
  });
});
