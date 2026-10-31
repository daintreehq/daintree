// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
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

function addedDiff(lines: number): string {
  const body: string[] = [];
  for (let i = 1; i <= lines; i++) body.push(`+row ${i} of the added file`);
  return [
    `diff --git a/${PATH} b/${PATH}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${PATH}`,
    `@@ -0,0 +1,${lines} @@`,
    ...body,
    "",
  ].join("\n");
}

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    frames.delete(id);
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  _resetLangStateForTests();
  useDiffNotesStore.setState({ notes: {}, editingIds: {} });
});

afterEach(async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    await _flushLangLoadsForTests();
  });
  useDiffNotesStore.setState({ notes: {}, editingIds: {} });
  vi.unstubAllGlobals();
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

function rowCount(container: HTMLElement): number {
  return container.querySelectorAll("tr.diff-line").length;
}

async function runUntilAllRows(container: HTMLElement, rows = ROWS) {
  for (let i = 0; i < 40 && rowCount(container) < rows; i++) await runFrame();
}

describe("DiffViewer staged rows", () => {
  it("renders a small diff whole on its first commit", () => {
    const { container } = render(
      <TooltipProvider>
        <DiffViewer diff={addedDiff(20)} />
      </TooltipProvider>
    );
    expect(rowCount(container)).toBe(20);
  });

  it("mounts the first batch of a giant hunk, then the rest a batch at a time", async () => {
    const { container } = render(
      <TooltipProvider>
        <DiffViewer diff={addedDiff(ROWS)} />
      </TooltipProvider>
    );
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    expect(container.querySelectorAll(".diff-hunk-header-inner")).toHaveLength(1);

    let previous = rowCount(container);
    for (let i = 0; i < 40 && previous < ROWS; i++) {
      await runFrame();
      const now = rowCount(container);
      expect(now - previous).toBeLessThanOrEqual(DIFF_ROW_BATCH);
      expect(now).toBeGreaterThanOrEqual(previous);
      previous = now;
    }
    expect(previous).toBe(ROWS);
    // Still one logical hunk: its header was never repeated for the batches.
    expect(container.querySelectorAll(".diff-hunk-header-inner")).toHaveLength(1);
    const lastCell = container
      .querySelectorAll("tr.diff-line")
      [ROWS - 1]!.querySelector(".diff-code");
    expect(lastCell?.textContent).toBe(`row ${ROWS} of the added file`);
  });

  it("hands host hunk actions the whole hunk while its body is still partial", () => {
    const seen: number[] = [];
    const { container } = render(
      <TooltipProvider>
        <DiffViewer
          diff={addedDiff(ROWS)}
          renderHunkActions={(hunk) => {
            seen.push(hunk.changes.length);
            return <span data-testid="hunk-size">{hunk.changes.length}</span>;
          }}
        />
      </TooltipProvider>
    );
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    expect(screen.getByTestId("hunk-size").textContent).toBe(String(ROWS));
    expect(seen.every((size) => size === ROWS)).toBe(true);
  });

  it("puts every row in the DOM before Select All selects", () => {
    const { container } = render(
      <TooltipProvider>
        <DiffViewer diff={addedDiff(ROWS)} />
      </TooltipProvider>
    );
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    const region = container.querySelector<HTMLElement>("[role='region']")!;
    region.focus();
    act(() => {
      region.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true })
      );
    });
    expect(rowCount(container)).toBe(ROWS);
    const selection = window.getSelection()!;
    const lastCell = container
      .querySelectorAll("tr.diff-line")
      [ROWS - 1]!.querySelector(".diff-code")!;
    expect(selection.containsNode(lastCell, true)).toBe(true);
    selection.removeAllRanges();
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

    const { container } = render(
      <TooltipProvider>
        <DiffViewer diff={diff} annotations={{ worktreePath: "/repo" }} />
      </TooltipProvider>
    );
    expect(rowCount(container)).toBe(DIFF_ROW_BATCH);
    // Not demoted to the detached list above the table just because its row
    // hasn't mounted yet.
    expect(screen.queryByTestId("diff-file-notes")).toBeNull();

    for (let i = 0; i < 40 && rowCount(container) < ROWS; i++) {
      await runFrame();
      expect(screen.queryByTestId("diff-file-notes")).toBeNull();
    }
    const card = screen.getByTestId("diff-note");
    expect(card.closest("table")).not.toBeNull();
    // Directly under the row it was written on.
    const widgetRow = card.closest("tr")!;
    const anchorRow = widgetRow.previousElementSibling as HTMLElement;
    expect(anchorRow.querySelector(".diff-code")?.textContent).toBe(
      `row ${line} of the added file`
    );
  });

  it("tells a row-set consumer about each slice after it commits", async () => {
    const seen: number[] = [];
    let container!: HTMLElement;
    ({ container } = render(
      <TooltipProvider>
        <DiffViewer
          diff={addedDiff(ROWS)}
          onToggleCollapse={() => seen.push(rowCount(container))}
        />
      </TooltipProvider>
    ));
    // The first commit is the initial render, not a change.
    expect(seen).toEqual([]);
    await runUntilAllRows(container);
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]!);
    expect(seen[seen.length - 1]).toBe(ROWS);
  });
});
