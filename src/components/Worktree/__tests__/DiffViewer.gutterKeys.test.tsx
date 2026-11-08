// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffViewer, _flushLangLoadsForTests, _resetLangStateForTests } from "../DiffViewer";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
import { useDiffNotesStore } from "@/store/diffNotesStore";
import { readDiffViewerCss } from "@/__tests__/support/cssManifest";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

/**
 * The real react-diff-view table: which cells draw a number, which fire a click
 * and what a split row pairs are the library's, and DiffViewer.notes.test.tsx
 * mocks all of it.
 *
 * Reading order: new 1, old 2 (removed), new 2 (added), new 3, then past a gap of
 * hidden lines new 40, new 41 (added), new 42.
 */
const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 0123456..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 line1
-removed
+added
 line3
@@ -40,2 +40,3 @@
 line40
+added41
 line42
`;

const ANNOTATIONS = { worktreePath: "/repo" };

function renderDiff(ui: ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function renderUnified(diff = DIFF) {
  return renderDiff(<DiffViewer diff={diff} viewType="unified" annotations={ANNOTATIONS} />);
}

function renderSplit(diff = DIFF) {
  return renderDiff(<DiffViewer diff={diff} viewType="split" annotations={ANNOTATIONS} />);
}

function lineNumber(container: HTMLElement, side: "old" | "new", line: number): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    `[data-note-side="${side}"][data-note-line="${line}"]`
  );
  if (!found) throw new Error(`no ${side} line number ${line}`);
  return found;
}

function focusedLine(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active.dataset.noteLine === undefined) return null;
  return `${active.dataset.noteSide} ${active.dataset.noteLine}`;
}

function press(key: string, init: { shiftKey?: boolean } = {}): boolean {
  const active = document.activeElement;
  if (!active) throw new Error("nothing focused");
  return fireEvent.keyDown(active, { key, ...init });
}

function tabStops(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-note-line][tabindex="0"]')).map(
    (element) => `${element.dataset.noteSide} ${element.dataset.noteLine}`
  );
}

function selectedNewLines(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("tr.diff-line"))
    .filter((row) => row.querySelector("td.diff-gutter-selected"))
    .map((row) => row.querySelector('[data-note-side="new"]')?.textContent ?? "");
}

function savedAnchor() {
  return Object.values(useDiffNotesStore.getState().notes)[0]?.anchor;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  _resetLangStateForTests();
  useDiffNotesStore.setState({ notes: {}, editingIds: {} });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await _flushLangLoadsForTests();
  });
  useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  vi.restoreAllMocks();
});

describe("line numbers with notes off", () => {
  it("adds nothing to the gutter", () => {
    const { container } = renderDiff(<DiffViewer diff={DIFF} viewType="unified" />);
    const number = container.querySelector(".diff-line-number");
    expect(number?.textContent).toBe("1");
    expect(number?.hasAttribute("tabindex")).toBe(false);
    expect(number?.hasAttribute("role")).toBe(false);
    expect(number?.hasAttribute("title")).toBe(false);
    expect(container.querySelector("[data-note-line]")).toBeNull();
    expect(container.querySelector("[data-notes-enabled]")).toBeNull();
    expect(container.querySelector(".diff-note-keys")).toBeNull();

    const cell = container.querySelector("td.diff-gutter");
    if (!cell) throw new Error("no gutter cell");
    fireEvent.mouseEnter(cell);
    expect(container.querySelector(".diff-note-gutter-glyph")).toBeNull();
  });
});

describe("hovering a line number with notes on", () => {
  it("draws the note glyph on the hovered row only", () => {
    const { container } = renderUnified();
    const rows = container.querySelectorAll("tr.diff-line");
    const cell = rows[1]?.querySelector("td.diff-gutter");
    if (!cell) throw new Error("no gutter cell");

    expect(container.querySelector(".diff-note-gutter-glyph")).toBeNull();
    fireEvent.mouseEnter(cell);
    // Both of a unified row's cells take the click, so both can show it; CSS
    // picks the one under the pointer.
    expect(rows[1]?.querySelectorAll(".diff-note-gutter-glyph")).toHaveLength(2);
    expect(rows[0]?.querySelector(".diff-note-gutter-glyph")).toBeNull();
    fireEvent.mouseLeave(cell);
    expect(container.querySelector(".diff-note-gutter-glyph")).toBeNull();
  });

  it("says what a click does on every number, including one that isn't a keyboard target", () => {
    const { container } = renderUnified();
    const [oldNumber, newNumber] = Array.from(
      container.querySelectorAll<HTMLElement>("tr.diff-line:first-child .diff-line-number")
    );
    expect(oldNumber?.dataset.noteLine).toBeUndefined();
    expect(oldNumber?.title).toBe(newNumber?.title);
    expect(newNumber?.title).toMatch(/click/i);
  });

  it("opens a note from a click on the number itself, which is also how a screen reader activates it", () => {
    const { container } = renderUnified();
    fireEvent.click(lineNumber(container, "new", 2));
    expect(screen.getByLabelText("New note on line 2")).toBeTruthy();
  });

  it("gates the pointer on notes being on, and leaves split's placeholders out", () => {
    const css = readDiffViewerCss();
    const pointer = /([^{}]+)\{\s*cursor:\s*pointer;?\s*\}/.exec(css)?.[1]?.trim() ?? "";
    expect(pointer).toContain("[data-notes-enabled]");
    expect(pointer).toContain(":not(.diff-gutter-omit)");
    expect(css).toMatch(/\.diff-viewer\s+\.diff-gutter\s*\{[^}]*cursor:\s*default/);
  });
});

describe("explaining the gestures", () => {
  it("tells an open line note how to extend, and a file note nothing of the kind", () => {
    const { container } = renderUnified();
    fireEvent.click(lineNumber(container, "new", 2));
    expect(screen.getByTestId("diff-note-composer").textContent).toMatch(/shift-click/i);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByLabelText("Add file note"));
    expect(screen.getByTestId("diff-note-composer").textContent).not.toMatch(/shift-click/i);
  });

  it("describes every target from one element that stays in the DOM while hidden", () => {
    const { container } = renderUnified();
    const hint = container.querySelector<HTMLElement>(".diff-note-keys");
    expect(hint?.id).toBeTruthy();
    for (const target of container.querySelectorAll("[data-note-line]")) {
      expect(target.getAttribute("aria-describedby")).toBe(hint?.id);
    }
  });

  it("shows the keys to keyboard focus but not to a click's, and offers extend only with a draft open", () => {
    const { container } = renderUnified();
    const hint = container.querySelector<HTMLElement>(".diff-note-keys");
    const first = lineNumber(container, "new", 1);

    const matches = vi.spyOn(first, "matches").mockImplementation((selector) => {
      if (selector === ":focus-visible") return false;
      return selector === "[data-note-line]";
    });
    first.focus();
    expect(hint?.hasAttribute("data-active")).toBe(false);
    first.blur();
    matches.mockRestore();

    const keyboardFocused = vi.spyOn(first, "matches").mockReturnValue(true);
    first.focus();
    expect(hint?.hasAttribute("data-active")).toBe(true);
    expect(hint?.textContent).not.toMatch(/shift\+enter/i);
    keyboardFocused.mockRestore();

    press("Enter");
    // Focus went to the composer, so the keys are no longer in play.
    expect(hint?.hasAttribute("data-active")).toBe(false);
    expect(hint?.textContent).toMatch(/shift\+enter/i);
  });
});

describe("the line number tab stop", () => {
  it("is one stop for the whole file, on the first line", () => {
    const { container } = renderUnified();
    expect(tabStops(container)).toEqual(["new 1"]);
    const targets = container.querySelectorAll("[data-note-line]");
    expect(targets.length).toBe(7);
    for (const target of targets) {
      expect(target.getAttribute("role")).toBe("button");
      if (target.getAttribute("tabindex") !== "0") {
        expect(target.getAttribute("tabindex")).toBe("-1");
      }
    }
  });

  it("makes only the cell a note would anchor to a target, so a context line isn't two stops", () => {
    const { container } = renderUnified();
    const contextRow = container.querySelector("tr.diff-line");
    const targets = contextRow?.querySelectorAll("[data-note-line]");
    expect(targets).toHaveLength(1);
    expect(targets?.[0]?.getAttribute("data-note-side")).toBe("new");
  });

  it("names the line, and says when it was removed", () => {
    const { container } = renderUnified();
    expect(lineNumber(container, "new", 2).getAttribute("aria-label")).toBe("Add note on line 2");
    expect(lineNumber(container, "old", 2).getAttribute("aria-label")).toBe(
      "Add note on line 2 (removed lines)"
    );
  });

  it("follows the focus, so Tab comes back to the line it left", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    press("ArrowDown");
    press("ArrowDown");
    expect(focusedLine()).toBe("new 2");
    expect(tabStops(container)).toEqual(["new 2"]);
  });

  it("finds a new home when a refresh takes its row away", () => {
    const { container, rerender } = renderUnified();
    lineNumber(container, "new", 41).focus();
    expect(tabStops(container)).toEqual(["new 41"]);

    rerender(
      <TooltipProvider>
        <DiffViewer
          diff={`diff --git a/src/a.ts b/src/a.ts
index 0123456..1234567 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -7,1 +7,2 @@
 line7
+added8
`}
          viewType="unified"
          annotations={ANNOTATIONS}
        />
      </TooltipProvider>
    );

    expect(tabStops(container)).toEqual(["new 7"]);
  });

  it("gets a stop back when notes go off and on, though the same nodes stay", () => {
    const { container, rerender } = renderUnified();
    const ui = (annotations?: typeof ANNOTATIONS) => (
      <TooltipProvider>
        <DiffViewer diff={DIFF} viewType="unified" annotations={annotations} />
      </TooltipProvider>
    );
    rerender(ui());
    expect(container.querySelector("[data-note-line]")).toBeNull();
    expect(container.querySelector(".diff-line-number[tabindex]")).toBeNull();
    rerender(ui(ANNOTATIONS));
    expect(tabStops(container)).toEqual(["new 1"]);
  });
});

describe("moving between line numbers", () => {
  it("walks both sides in reading order in unified, across a gap", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    const walked: (string | null)[] = [];
    for (let i = 0; i < 6; i++) {
      press("ArrowDown");
      walked.push(focusedLine());
    }
    expect(walked).toEqual(["old 2", "new 2", "new 3", "new 40", "new 41", "new 42"]);
    press("ArrowUp");
    expect(focusedLine()).toBe("new 41");
  });

  it("stays put at the edges without letting the keypress scroll the page", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    expect(press("ArrowUp")).toBe(false);
    expect(focusedLine()).toBe("new 1");
  });

  it("leaves unified's Left and Right to the browser", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    expect(press("ArrowRight")).toBe(true);
    expect(focusedLine()).toBe("new 1");
  });

  it("keeps Up and Down to a column in split, and crosses with Left and Right", () => {
    const { container } = renderSplit();
    lineNumber(container, "new", 1).focus();
    press("ArrowDown");
    expect(focusedLine()).toBe("new 2");

    expect(press("ArrowLeft")).toBe(false);
    expect(focusedLine()).toBe("old 2");
    // The old column has no other removed line to reach.
    press("ArrowDown");
    expect(focusedLine()).toBe("old 2");

    press("ArrowRight");
    expect(focusedLine()).toBe("new 2");
  });

  it("crosses to the nearest number when a split row has nothing beside it", () => {
    const { container } = renderSplit();
    lineNumber(container, "new", 3).focus();
    press("ArrowLeft");
    expect(focusedLine()).toBe("old 2");
  });

  it("has nowhere to cross to in a one-sided file, and leaves the key alone", () => {
    const { container } = renderSplit(`diff --git a/src/n.ts b/src/n.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/n.ts
@@ -0,0 +1,2 @@
+one
+two
`);
    lineNumber(container, "new", 1).focus();
    expect(press("ArrowRight")).toBe(true);
    expect(focusedLine()).toBe("new 1");
  });

  it("ignores chords, which belong to global shortcuts", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    expect(fireEvent.keyDown(document.activeElement!, { key: "ArrowDown", metaKey: true })).toBe(
      true
    );
    expect(focusedLine()).toBe("new 1");
    expect(fireEvent.keyDown(document.activeElement!, { key: "Enter", ctrlKey: true })).toBe(true);
    expect(screen.queryByTestId("diff-note-composer")).toBeNull();
  });
});

describe("starting a note from the keyboard", () => {
  it.each(["Enter", " "])("opens the composer on the focused line with %j", (key) => {
    const { container } = renderUnified();
    lineNumber(container, "new", 2).focus();

    // Default prevented, or the key lands in the textarea that just took focus.
    expect(press(key)).toBe(false);

    const textarea = screen.getByLabelText("New note on line 2");
    expect(document.activeElement).toBe(textarea);
  });

  it("notes a removed line on the old side", () => {
    const { container } = renderUnified();
    lineNumber(container, "old", 2).focus();
    press("Enter");
    expect(screen.getByLabelText("New note on line 2 (removed lines)")).toBeTruthy();
  });

  it("hands focus back to the line number when the composer closes", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 2).focus();
    press("Enter");
    press("Escape");
    expect(screen.queryByTestId("diff-note-composer")).toBeNull();
    expect(focusedLine()).toBe("new 2");

    press("Enter");
    fireEvent.change(screen.getByLabelText("New note on line 2"), { target: { value: "Why?" } });
    fireEvent.keyDown(screen.getByLabelText("New note on line 2"), {
      key: "Enter",
      metaKey: true,
    });
    expect(savedAnchor()).toMatchObject({ side: "new", startLine: 2, endLine: 2 });
    expect(focusedLine()).toBe("new 2");
  });
});

describe("selecting a range from the keyboard", () => {
  it("grows from the anchor, highlights as it goes, and opens on the whole range", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    press("ArrowDown", { shiftKey: true });
    // Over the removed row between them: a range is lines of one side.
    expect(focusedLine()).toBe("new 2");
    expect(selectedNewLines(container)).toEqual(["1", "2"]);

    press("ArrowDown", { shiftKey: true });
    expect(focusedLine()).toBe("new 3");
    expect(selectedNewLines(container)).toEqual(["1", "2", "3"]);
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Lines 1–3 selected");

    // Shift is usually still down from selecting, which must not read as "extend".
    press("Enter", { shiftKey: true });
    const textarea = screen.getByLabelText("New note on lines 1–3");
    expect(document.activeElement).toBe(textarea);

    fireEvent.change(textarea, { target: { value: "All three" } });
    fireEvent.click(screen.getByRole("button", { name: "Add note" }));
    expect(savedAnchor()).toMatchObject({ side: "new", startLine: 1, endLine: 3 });
    // Anchored under its rows, so the hash matched the lines it was written on.
    expect(screen.getByTestId("diff-note").textContent).not.toMatch(/outdated|not shown/i);
    expect(focusedLine()).toBe("new 3");
  });

  it("shrinks when it reverses, and grows the other way past the anchor", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 2).focus();
    press("ArrowDown", { shiftKey: true });
    expect(selectedNewLines(container)).toEqual(["2", "3"]);

    press("ArrowUp", { shiftKey: true });
    expect(selectedNewLines(container)).toEqual(["2"]);

    press("ArrowUp", { shiftKey: true });
    expect(focusedLine()).toBe("new 1");
    expect(selectedNewLines(container)).toEqual(["1", "2"]);

    press("Enter");
    expect(screen.getByLabelText("New note on lines 1–2")).toBeTruthy();
  });

  it("stops at hidden lines and says why, keeping the selection it has", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 2).focus();
    press("ArrowDown", { shiftKey: true });
    press("ArrowDown", { shiftKey: true });

    expect(focusedLine()).toBe("new 3");
    expect(selectedNewLines(container)).toEqual(["2", "3"]);
    expect(useAnnouncerStore.getState().polite?.msg).toBe("Hidden lines stop this selection");
  });

  it("selects removed lines on their own side", () => {
    const { container } = renderUnified(`diff --git a/src/a.ts b/src/a.ts
index 0123456..abcdefg 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,1 @@
 keep
-gone1
-gone2
`);
    lineNumber(container, "old", 2).focus();
    press("ArrowDown", { shiftKey: true });
    expect(focusedLine()).toBe("old 3");
    press("Enter");
    expect(screen.getByLabelText("New note on lines 2–3 (removed lines)")).toBeTruthy();
  });

  it("drops the selection on a plain move", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    press("ArrowDown", { shiftKey: true });
    press("ArrowDown");
    expect(focusedLine()).toBe("new 3");
    expect(selectedNewLines(container)).toEqual([]);
    press("Enter");
    expect(screen.getByLabelText("New note on line 3")).toBeTruthy();
  });

  it("drops the selection when focus leaves the gutter", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    press("ArrowDown", { shiftKey: true });
    act(() => screen.getByLabelText("Add file note").focus());
    expect(selectedNewLines(container)).toEqual([]);
  });

  it("keeps the selection out of the way of a click that opens a draft elsewhere", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    press("ArrowDown", { shiftKey: true });
    lineNumber(container, "new", 41).focus();
    fireEvent.click(lineNumber(container, "new", 41));
    expect(screen.getByLabelText("New note on line 41")).toBeTruthy();
    expect(selectedNewLines(container)).toEqual(["41"]);
  });

  it("clears with Escape, and only then lets Escape reach the host", () => {
    const onHostKeyDown = vi.fn();
    const { container } = renderDiff(
      <div onKeyDown={onHostKeyDown}>
        <DiffViewer diff={DIFF} viewType="unified" annotations={ANNOTATIONS} />
      </div>
    );
    const escapesSeen = () =>
      onHostKeyDown.mock.calls.filter(([event]) => event.key === "Escape").length;

    lineNumber(container, "new", 1).focus();
    press("ArrowDown", { shiftKey: true });

    press("Escape");
    expect(selectedNewLines(container)).toEqual([]);
    expect(escapesSeen()).toBe(0);

    press("Escape");
    expect(escapesSeen()).toBe(1);
  });
});

describe("extending an open draft from the keyboard", () => {
  it("does what shift-click does: moves the composer to the wider range, typed text intact", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 1).focus();
    press("Enter");
    fireEvent.change(screen.getByLabelText("New note on line 1"), {
      target: { value: "Covers both" },
    });

    // Back to the gutter, the way Shift+Tab from the composer lands on the stop.
    lineNumber(container, "new", 1).focus();
    press("ArrowDown");
    press("ArrowDown");
    expect(focusedLine()).toBe("new 2");
    press("Enter", { shiftKey: true });

    const extended = screen.getByLabelText("New note on lines 1–2");
    expect(extended instanceof HTMLTextAreaElement && extended.value).toBe("Covers both");
    expect(document.activeElement).toBe(extended);
  });

  it("starts fresh when there is no draft to extend", () => {
    const { container } = renderUnified();
    lineNumber(container, "new", 2).focus();
    press("Enter", { shiftKey: true });
    expect(screen.getByLabelText("New note on line 2")).toBeTruthy();
  });
});
