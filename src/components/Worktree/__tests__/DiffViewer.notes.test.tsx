// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventMap, HunkData } from "react-diff-view";
import { DiffViewer, _flushLangLoadsForTests, _resetLangStateForTests } from "../DiffViewer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { PendingFileNotes } from "../DiffNoteWidgets";

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
    expect(screen.getByLabelText("New note on lines 1-3")).toBeTruthy();
  });

  it("keeps typed draft text when shift-click moves the composer to a new row", () => {
    renderViewer();
    clickGutter(0, "new");
    fireEvent.change(screen.getByLabelText("New note on line 1"), {
      target: { value: "Covers both" },
    });
    clickGutter(2, "new", true);
    const extended = screen.getByLabelText("New note on lines 1-3");
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
    expect(detached.textContent).toContain("Stale");
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
    expect(list.textContent).toContain("Not in view");
    expect(list.textContent).not.toContain("Other file");
  });
});
