// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDiff } from "react-diff-view";
import { DiffViewer, _flushLangLoadsForTests, _resetLangStateForTests } from "../DiffViewer";
import { DIFF_ROW_BATCH } from "../diffRowStaging";
import { buildDiffLineIndex, hashLineRange } from "../diffNotes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDiffNotesStore } from "@/store/diffNotesStore";

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn().mockResolvedValue({ ok: true }) },
}));

/**
 * The real react-diff-view table, staged. The other DiffViewer suites mock
 * `Diff`/`Hunk`, so they cannot see which rows actually reached the DOM.
 */

const ROWS = DIFF_ROW_BATCH * 3 + 7;
const PATH = "src/big.txt";

function addedDiff(lines: number, { path = PATH, revision = true } = {}): string {
  const body: string[] = [];
  for (let i = 1; i <= lines; i++) body.push(`+row ${i} of the added file`);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    ...(revision ? ["index 0000000..1111111"] : []),
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...body,
    "",
  ].join("\n");
}

/** Highlightable lines, so token spans are observable in the DOM. */
function addedTypeScript(lines: number): string {
  const body: string[] = [];
  for (let i = 1; i <= lines; i++) body.push(`+export const item${i} = make(${i});`);
  return [
    "diff --git a/src/big.ts b/src/big.ts",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/src/big.ts",
    `@@ -0,0 +1,${lines} @@`,
    ...body,
    "",
  ].join("\n");
}

/** A modify diff: 1,000-line file, a 191-change first hunk and two small ones far below it. */
function gappedModify(): { diff: string; source: string } {
  const newLines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
  const out = [
    "diff --git a/src/gaps.txt b/src/gaps.txt",
    "index 1111111..2222222 100644",
    "--- a/src/gaps.txt",
    "+++ b/src/gaps.txt",
    "@@ -1,190 +1,190 @@",
  ];
  for (let i = 0; i < 189; i++) out.push(` ${newLines[i]}`);
  out.push("-old line 190", `+${newLines[189]}`);
  for (const changed of [303, 503]) {
    out.push(`@@ -${changed - 3},7 +${changed - 3},7 @@`);
    for (let line = changed - 3; line < changed; line++) out.push(` ${newLines[line - 1]}`);
    out.push(`-old line ${changed}`, `+${newLines[changed - 1]}`);
    for (let line = changed + 1; line <= changed + 3; line++) out.push(` ${newLines[line - 1]}`);
  }
  out.push("");
  return { diff: out.join("\n"), source: `${newLines.join("\n")}\n` };
}

/** Over the 256 KiB soft-collapse gate: 100 hunks of 10 long inserted lines below one context line. */
function largeManyHunks(): string {
  const longLine = "x".repeat(300);
  const out = [
    "diff --git a/src/huge.txt b/src/huge.txt",
    "index 1111111..2222222 100644",
    "--- a/src/huge.txt",
    "+++ b/src/huge.txt",
  ];
  for (let h = 0; h < 100; h++) {
    const oldStart = h * 20 + 1;
    out.push(`@@ -${oldStart},1 +${oldStart + h * 10},11 @@`);
    out.push(` context ${h}`);
    for (let i = 0; i < 10; i++) out.push(`+${longLine}${h}-${i}`);
  }
  out.push("");
  return out.join("\n");
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let originalRaf: typeof globalThis.requestAnimationFrame;
let originalCancel: typeof globalThis.cancelAnimationFrame;
const spies: { mockRestore: () => void }[] = [];

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  originalRaf = globalThis.requestAnimationFrame;
  originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };
  spies.push(vi.spyOn(console, "warn").mockImplementation(() => {}));
  spies.push(vi.spyOn(console, "error").mockImplementation(() => {}));
  _resetLangStateForTests();
  useDiffNotesStore.setState({ notes: {}, editingIds: {} });
});

afterEach(async () => {
  // Unmount while the manual frame queue is still installed, so the stage's
  // cleanup cancels into it rather than into whatever comes next.
  cleanup();
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await _flushLangLoadsForTests();
  });
  useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  globalThis.requestAnimationFrame = originalRaf;
  globalThis.cancelAnimationFrame = originalCancel;
  for (const spy of spies.splice(0)) spy.mockRestore();
});

async function runFrame() {
  await act(async () => {
    // Let the in-thread tokenizer land between frames, as the worker would.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = [...frames.values()];
    frames.clear();
    for (const cb of queued) cb(0);
  });
}

/** Runs frames (and waits out the tokenizer between them) until `done`, or fails. */
async function runUntil(done: () => boolean, maxSteps = 300) {
  for (let i = 0; i < maxSteps && !done(); i++) {
    if (frames.size > 0) await runFrame();
    else {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  }
  expect(done()).toBe(true);
}

function rowCount(container: HTMLElement): number {
  return container.querySelectorAll("tr.diff-line").length;
}

function tokenizedRowCount(container: HTMLElement): number {
  let count = 0;
  for (const row of container.querySelectorAll("tr.diff-line")) {
    if (row.querySelector("td.diff-code span")) count++;
  }
  return count;
}

function codeText(row: Element | undefined): string | null | undefined {
  return row?.querySelector(".diff-code")?.textContent;
}

function renderViewer(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe("DiffViewer staged rows", () => {
  it("renders a small diff whole on its first commit", () => {
    const { container } = renderViewer(<DiffViewer diff={addedDiff(20)} />);
    expect(rowCount(container)).toBe(20);
  });

  it("mounts the first batch of a giant hunk, then the rest a batch at a time", async () => {
    const { container } = renderViewer(<DiffViewer diff={addedDiff(ROWS)} />);
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    expect(container.querySelectorAll(".diff-hunk-header-inner")).toHaveLength(1);

    let previous = rowCount(container);
    await runUntil(() => {
      const now = rowCount(container);
      expect(now - previous).toBeLessThanOrEqual(DIFF_ROW_BATCH);
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
      return now === ROWS;
    });
    // Still one logical hunk: its header was never repeated for the batches.
    expect(container.querySelectorAll(".diff-hunk-header-inner")).toHaveLength(1);
    const rows = container.querySelectorAll("tr.diff-line");
    expect(codeText(rows[ROWS - 1])).toBe(`row ${ROWS} of the added file`);
  });

  it("hands host hunk actions the whole hunk while its body is still partial", () => {
    const seen: number[] = [];
    const { container } = renderViewer(
      <DiffViewer
        diff={addedDiff(ROWS)}
        renderHunkActions={(hunk) => {
          seen.push(hunk.changes.length);
          return <span data-testid="hunk-size">{hunk.changes.length}</span>;
        }}
      />
    );
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    expect(screen.getByTestId("hunk-size").textContent).toBe(String(ROWS));
    expect(seen.every((size) => size === ROWS)).toBe(true);
  });

  it("copies the whole hunk from its header while only the first batch is mounted", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const { container } = renderViewer(<DiffViewer diff={addedDiff(ROWS)} />);
      expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Copy hunk"));
      });
      const expected = Array.from(
        { length: ROWS },
        (_, i) => `row ${i + 1} of the added file`
      ).join("\n");
      expect(writeText).toHaveBeenCalledWith(expected);
    } finally {
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("puts every row in the DOM before Select All selects", () => {
    const { container } = renderViewer(<DiffViewer diff={addedDiff(ROWS)} />);
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    const rowsAtSelect: number[] = [];
    const original = Selection.prototype.selectAllChildren;
    const spy = vi.spyOn(Selection.prototype, "selectAllChildren").mockImplementation(function (
      this: Selection,
      node: Node
    ) {
      rowsAtSelect.push(rowCount(container));
      original.call(this, node);
    });
    try {
      const region = container.querySelector<HTMLElement>("[role='region']")!;
      region.focus();
      act(() => {
        region.dispatchEvent(
          new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true })
        );
      });
      // Counted inside the selection call itself: the rows were there before it ran.
      expect(rowsAtSelect).toEqual([ROWS]);
      const lastCell = container
        .querySelectorAll("tr.diff-line")
        [ROWS - 1]!.querySelector(".diff-code")!;
      expect(window.getSelection()!.containsNode(lastCell, true)).toBe(true);
    } finally {
      spy.mockRestore();
      window.getSelection()!.removeAllRanges();
    }
  });

  it("keeps a note on a row past the first batch anchored while its row waits to mount", async () => {
    const diff = addedDiff(ROWS);
    const line = DIFF_ROW_BATCH + 50;
    const index = buildDiffLineIndex(parseDiff(diff)[0]!.hunks);
    const contentHash = hashLineRange(index, "new", line, line);
    expect(contentHash).not.toBeNull();
    act(() => {
      useDiffNotesStore.getState().addNote({
        worktreePath: "/repo",
        filePath: PATH,
        anchor: {
          kind: "lines",
          side: "new",
          startLine: line,
          endLine: line,
          contentHash: contentHash!,
        },
        body: "Check this row",
      });
    });

    const { container } = renderViewer(
      <DiffViewer diff={diff} annotations={{ worktreePath: "/repo" }} />
    );
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    // Not demoted to the detached list above the table just because its row
    // hasn't mounted yet.
    expect(screen.queryByTestId("diff-file-notes")).toBeNull();

    await runUntil(() => {
      expect(screen.queryByTestId("diff-file-notes")).toBeNull();
      return rowCount(container) === ROWS;
    });
    const card = screen.getByTestId("diff-note");
    // Directly under the row it was written on.
    const widgetRow = card.closest("tr")!;
    expect(widgetRow.closest("table")).not.toBeNull();
    expect(codeText(widgetRow.previousElementSibling ?? undefined)).toBe(
      `row ${line} of the added file`
    );
  });

  it("tells a row-set consumer about every staged batch, after it commits", async () => {
    const seen: number[] = [];
    const observed: number[] = [];
    const ref: { container: HTMLElement | null } = { container: null };
    const { container } = renderViewer(
      <DiffViewer
        diff={addedDiff(ROWS)}
        onToggleCollapse={() => seen.push(rowCount(ref.container!))}
      />
    );
    ref.container = container;
    // The first commit is the initial render, not a change.
    expect(seen).toEqual([]);
    let last = rowCount(container);
    await runUntil(() => {
      const now = rowCount(container);
      if (now !== last) observed.push(now);
      last = now;
      return now === ROWS;
    });
    // One notification per change in the rendered rows, each seeing that change.
    expect(seen).toEqual(observed);
    expect(seen[seen.length - 1]).toBe(ROWS);
  });

  it("tells a token consumer about every highlighted batch, the last with every row done", async () => {
    const seen: number[] = [];
    const ref: { container: HTMLElement | null } = { container: null };
    const { container } = renderViewer(
      <DiffViewer
        diff={addedTypeScript(ROWS)}
        onTokensRendered={() => {
          if (ref.container) seen.push(tokenizedRowCount(ref.container));
        }}
      />
    );
    ref.container = container;
    await runUntil(
      () =>
        rowCount(container) === ROWS && tokenizedRowCount(container) === ROWS && frames.size === 0
    );
    // Staged: several notifications, each after more rows were highlighted.
    const progress = seen.filter((count) => count > 0);
    expect(progress.length).toBeGreaterThan(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThan(progress[i - 1]!);
    }
    expect(seen[seen.length - 1]).toBe(ROWS);
  });

  it("starts a fresh stage when the layout changes", async () => {
    const { container, rerender } = renderViewer(
      <DiffViewer diff={addedDiff(ROWS)} viewType="split" />
    );
    await runUntil(() => rowCount(container) === ROWS);
    // Every row is a new element in the other layout, so it is staged again
    // rather than committed whole.
    rerender(
      <TooltipProvider>
        <DiffViewer diff={addedDiff(ROWS)} viewType="unified" />
      </TooltipProvider>
    );
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    await runUntil(() => rowCount(container) === ROWS);
  });

  it("stages a refreshed patch that grew from small to giant under the same key", async () => {
    // No index line, so the file has no revision and keeps its index key.
    const small = addedDiff(20, { revision: false });
    const giant = addedDiff(ROWS, { revision: false });
    const { container, rerender } = renderViewer(<DiffViewer diff={small} />);
    expect(rowCount(container)).toBe(20);
    rerender(
      <TooltipProvider>
        <DiffViewer diff={giant} />
      </TooltipProvider>
    );
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    await runUntil(() => rowCount(container) === ROWS);
  });

  it("holds Show more back until every row is in, then stages the hunks it reveals", async () => {
    const { container } = renderViewer(<DiffViewer diff={largeManyHunks()} />);
    // Over the soft-collapse gate: opened by hand.
    fireEvent.click(screen.getByText("Show diff"));
    const firstBatch = rowCount(container);
    expect(firstBatch).toBe(DIFF_ROW_BATCH);
    expect(screen.queryByText(/more hunks/)).toBeNull();

    await runUntil(() => frames.size === 0 && rowCount(container) === 30 * 11);
    const revealed = rowCount(container);
    fireEvent.click(screen.getByText(/Show 60 more hunks/));
    // The 60 revealed hunks (660 rows) join behind the mounted ones a batch at a time.
    expect(rowCount(container)).toBe(revealed + DIFF_ROW_BATCH);
    expect(screen.queryByText(/more hunks/)).toBeNull();
    await runUntil(() => rowCount(container) === 90 * 11);
    expect(screen.getByText(/Show 10 more hunks/)).not.toBeNull();
  });

  it("records the column a split selection started in, for rows mounted after it", () => {
    const { diff, source } = gappedModify();
    const { container } = renderViewer(<DiffViewer diff={diff} source={source} />);
    const region = container.querySelector<HTMLElement>("[role='region']")!;
    const row = container.querySelector("tr.diff-line")!;
    fireEvent.mouseDown(row.children[3]!, { button: 0 });
    expect(region.dataset.diffSelectSide).toBe("new");
    fireEvent.mouseDown(row.children[1]!, { button: 0 });
    expect(region.dataset.diffSelectSide).toBe("old");
    // A gutter press scopes nothing, as in react-diff-view itself.
    fireEvent.mouseDown(row.children[0]!, { button: 0 });
    expect(region.dataset.diffSelectSide).toBe("old");
  });

  it("hands focus to the expanded hunk's header once a later batch mounts it", async () => {
    const { diff, source } = gappedModify();
    const { container } = renderViewer(<DiffViewer diff={diff} source={source} />);
    // Mid-stage: the budget counts changes, and a split row can hold two.
    expect(frames.size).toBeGreaterThan(0);
    const headers = () => container.querySelectorAll<HTMLElement>(".diff-hunk-header-inner");
    expect(headers().length).toBe(3);
    const expandDown = Array.from(headers()[1]!.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Expand down")
    )!;
    expandDown.focus();
    act(() => {
      fireEvent.click(expandDown);
    });
    // The first hunk grew past the mounted prefix and took the second header with it.
    expect(headers().length).toBe(1);
    await runUntil(() => frames.size === 0);
    // All three hunks, plus the trailing expander that waits for the last row.
    expect(headers().length).toBe(4);
    expect(headers()[1]!.contains(document.activeElement)).toBe(true);
  });
});
