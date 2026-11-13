// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventMap, HunkData } from "react-diff-view";
import { DiffViewer, _flushLangLoadsForTests, _resetLangStateForTests } from "../DiffViewer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { PendingFileNotes } from "../DiffNoteWidgets";
import { DiffNoteDraftContext, useOwnDiffNoteDraftSession } from "../diffNoteDrafts";

const { captured } = vi.hoisted(() => ({
  captured: {} as {
    hunks?: HunkData[];
    widgets?: Record<string, React.ReactNode>;
    gutterEvents?: EventMap;
    selectedChanges?: string[];
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
          {Object.entries(props.widgets ?? {}).map(([key, node]) => (
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

/**
 * Stands in for the diff pane: it owns the draft session above whatever body
 * is showing, the way the pane holds it above the table, its loading skeleton,
 * rendered Markdown and the fallback list.
 */
function Pane({ body, diff = DIFF }: { body: "table" | "list" | "loading"; diff?: string }) {
  const session = useOwnDiffNoteDraftSession();
  return (
    <TooltipProvider>
      <DiffNoteDraftContext value={session}>
        {body === "table" && <DiffViewer diff={diff} annotations={{ worktreePath: "/repo" }} />}
        {body === "list" && <PendingFileNotes worktreePath="/repo" filePath="src/a.ts" />}
      </DiffNoteDraftContext>
    </TooltipProvider>
  );
}

function textOf(label: string): string {
  const field = screen.getByLabelText(label);
  if (!(field instanceof HTMLTextAreaElement)) throw new Error(`${label} isn't a textarea`);
  return field.value;
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
  });

  afterEach(() => {
    useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  });

  it("keeps an open line draft and its text through a refresh that unmounts the table", async () => {
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    fireEvent.change(screen.getByLabelText("New note on line 2"), {
      target: { value: "Half a thought" },
    });
    // The refresh lands in a later task than the click that opened the draft.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    rerender(<Pane body="loading" />);
    expect(screen.queryByTestId("diff-note-composer")).toBeNull();
    rerender(<Pane body="table" />);

    expect(textOf("New note on line 2")).toBe("Half a thought");
    expect(captured.widgets?.I2).toBeDefined();
    // Restored where it was, not handed focus the reviewer has since taken elsewhere.
    expect(document.activeElement).not.toBe(screen.getByLabelText("New note on line 2"));
  });

  it("lists a draft whose rows changed under a refresh as outdated, and saves it against what was read", () => {
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    fireEvent.change(screen.getByLabelText("New note on line 2"), {
      target: { value: "Why add this?" },
    });

    // A new revision of the file: the table remounts, and line 2 now reads differently.
    rerender(<Pane body="loading" />);
    rerender(<Pane body="table" diff={REFRESHED_DIFF} />);

    expect(captured.widgets).toBeUndefined();
    const detached = screen.getByTestId("diff-file-notes");
    expect(detached.textContent).toContain("Outdated");
    expect(textOf("New note on line 2")).toBe("Why add this?");

    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    const [note] = Object.values(useDiffNotesStore.getState().notes);
    expect(note?.body).toBe("Why add this?");
    // Still marked outdated once saved: it was written against the old line 2.
    expect(screen.getByTestId("diff-file-notes").textContent).toContain("Outdated");
  });

  it("keeps a file's drafts while another file is on screen", () => {
    const { rerender } = render(<Pane body="table" />);
    fireEvent.click(screen.getByLabelText("Add file note"));
    fireEvent.change(screen.getByLabelText("New file note"), {
      target: { value: "Split this file" },
    });

    rerender(<Pane body="table" diff={OTHER_FILE_DIFF} />);
    expect(screen.queryByLabelText("New file note")).toBeNull();

    rerender(<Pane body="table" />);
    expect(textOf("New file note")).toBe("Split this file");
  });

  it("keeps a line draft and a file draft apart", () => {
    render(<Pane body="table" />);
    clickGutter(1, "new");
    fireEvent.change(screen.getByLabelText("New note on line 2"), {
      target: { value: "About this line" },
    });

    fireEvent.click(screen.getByLabelText("Add file note"));

    expect(textOf("New file note")).toBe("");
    expect(textOf("New note on line 2")).toBe("About this line");
    expect(document.activeElement).toBe(screen.getByLabelText("New file note"));

    fireEvent.change(screen.getByLabelText("New file note"), {
      target: { value: "About the file" },
    });
    const fileComposer = screen
      .getByLabelText("New file note")
      .closest<HTMLElement>("[data-testid='diff-note-composer']")!;
    fireEvent.click(within(fileComposer).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("New file note")).toBeNull();
    expect(textOf("New note on line 2")).toBe("About this line");
  });

  it("lists unsaved drafts with the notes where the layout has no table", () => {
    const { rerender } = render(<Pane body="table" />);
    clickGutter(1, "new");
    fireEvent.change(screen.getByLabelText("New note on line 2"), {
      target: { value: "Line draft" },
    });
    fireEvent.click(screen.getByLabelText("Add file note"));
    fireEvent.change(screen.getByLabelText("New file note"), {
      target: { value: "File draft" },
    });

    rerender(<Pane body="list" />);

    const list = screen.getByTestId("diff-pending-file-notes");
    expect(textOf("New note on line 2")).toBe("Line draft");
    expect(textOf("New file note")).toBe("File draft");
    expect(list.textContent).toContain("Not shown");

    rerender(<Pane body="table" />);
    expect(captured.widgets?.I2).toBeDefined();
    expect(textOf("New note on line 2")).toBe("Line draft");
  });

  it("keeps a note's rewrite open, and held back from sending, while its card is gone", () => {
    const id = addFileNote("First");
    const { rerender, unmount } = render(<Pane body="table" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.change(screen.getByLabelText("Edit file note"), { target: { value: "Second" } });

    rerender(<Pane body="loading" />);
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);

    // Back in the fallback list, a different card picks up the same rewrite.
    rerender(<Pane body="list" />);
    expect(textOf("Edit file note")).toBe("Second");
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);

    rerender(<Pane body="table" />);
    expect(textOf("Edit file note")).toBe("Second");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useDiffNotesStore.getState().notes[id]?.body).toBe("Second");
    expect(useDiffNotesStore.getState().editingIds[id]).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(useDiffNotesStore.getState().editingIds[id]).toBe(1);
    // Closing the pane drops its drafts, and with them the send guard.
    unmount();
    expect(useDiffNotesStore.getState().editingIds[id]).toBeUndefined();
  });

  it("starts an edit from the saved note once the last one was cancelled", () => {
    addFileNote("Saved words");
    render(<Pane body="table" />);
    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.change(screen.getByLabelText("Edit file note"), { target: { value: "Discarded" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    expect(textOf("Edit file note")).toBe("Saved words");
  });
});
