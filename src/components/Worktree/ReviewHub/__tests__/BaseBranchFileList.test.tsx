/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ForwardedRef, ReactNode } from "react";
import type { VirtuosoHandle } from "react-virtuoso";
import type { CrossWorktreeFile } from "@shared/types/ipc/git";
import type { FileDecoration } from "@shared/types/forge";
import { FILE_LIST_VIRTUALIZATION_THRESHOLD } from "@/lib/fileListWindowing";
import { BaseBranchFileList } from "../BaseBranchFileList";

/** The rows the stub has mounted; `null` mounts every row. */
const mountedRange = { current: null as { start: number; end: number } | null };
const scrollToIndexMock = vi.fn<(location: { index: number; align?: string }) => void>();

/**
 * A `Virtuoso` that mounts only `mountedRange`, and renders again when asked
 * to scroll, as the real one does once the scroll moves its window. Where the
 * window lands is each test's own call, through `scrollToIndexMock`.
 */
vi.mock("react-virtuoso", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-virtuoso")>();
  const { forwardRef, useImperativeHandle, useReducer } = await import("react");
  return {
    ...actual,
    Virtuoso: forwardRef(function VirtuosoStub(
      props: {
        data: unknown[];
        context: unknown;
        itemContent: (index: number, item: unknown, context: unknown) => ReactNode;
        computeItemKey?: (index: number, item: unknown, context: unknown) => string;
      },
      ref: ForwardedRef<Pick<VirtuosoHandle, "scrollToIndex">>
    ) {
      const [, renderAgain] = useReducer((n: number) => n + 1, 0);
      useImperativeHandle(
        ref,
        () => ({
          scrollToIndex: (location) => {
            scrollToIndexMock(location as { index: number; align?: string });
            renderAgain();
          },
        }),
        []
      );
      const range = mountedRange.current;
      return (
        <div>
          {props.data.map((item, index) => {
            if (range && (index < range.start || index > range.end)) return null;
            return (
              <div key={props.computeItemKey?.(index, item, props.context) ?? index}>
                {props.itemContent(index, item, props.context)}
              </div>
            );
          })}
        </div>
      );
    }),
  };
});

function files(count: number): CrossWorktreeFile[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `src/file-${String(i).padStart(3, "0")}.ts`,
    status: "M",
  })) as CrossWorktreeFile[];
}

function renderList(
  list: CrossWorktreeFile[],
  decorations: Record<string, FileDecoration | undefined> = {}
) {
  const scrollParent = document.createElement("div");
  const props = {
    files: list,
    decorations,
    onOpenFile: vi.fn(),
    onOpenDecorationUrl: vi.fn(),
    scrollParent,
  };
  const view = render(
    <div>
      <BaseBranchFileList {...props} />
      <button type="button">Outside</button>
    </div>
  );
  return {
    ...view,
    rerenderList: (next: Partial<typeof props>) =>
      view.rerender(
        <div>
          <BaseBranchFileList {...props} {...next} />
          <button type="button">Outside</button>
        </div>
      ),
  };
}

function row(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(name.replace(/\./g, "\\.")) });
}

/** Presses `key` on whatever has focus; true when the list consumed it. */
function press(key: string, init: Partial<KeyboardEventInit> = {}): boolean {
  const target = document.activeElement ?? document.body;
  return !fireEvent.keyDown(target, { key, ...init });
}

describe("BaseBranchFileList keyboard rows (#16895)", () => {
  beforeEach(() => {
    mountedRange.current = null;
    scrollToIndexMock.mockReset();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  afterEach(cleanup);

  describe("static list", () => {
    it("steps focus down and up through the rows", () => {
      renderList(files(3));
      row("file-000.ts").focus();

      expect(press("ArrowDown")).toBe(true);
      expect(document.activeElement).toBe(row("file-001.ts"));
      expect(press("ArrowDown")).toBe(true);
      expect(document.activeElement).toBe(row("file-002.ts"));
      expect(press("ArrowUp")).toBe(true);
      expect(document.activeElement).toBe(row("file-001.ts"));
    });

    it("jumps to either end with Home and End and holds there, since a file list never wraps", () => {
      renderList(files(3));
      row("file-001.ts").focus();

      expect(press("End")).toBe(true);
      expect(document.activeElement).toBe(row("file-002.ts"));
      expect(press("ArrowDown")).toBe(true);
      expect(document.activeElement).toBe(row("file-002.ts"));
      expect(press("Home")).toBe(true);
      expect(document.activeElement).toBe(row("file-000.ts"));
      expect(press("ArrowUp")).toBe(true);
      expect(document.activeElement).toBe(row("file-000.ts"));
    });

    it("scrolls the row it moves to into view", () => {
      renderList(files(3));
      row("file-000.ts").focus();
      press("ArrowDown");
      const scrolled = vi.mocked(HTMLElement.prototype.scrollIntoView).mock.contexts;
      expect(scrolled.at(-1)).toBe(row("file-001.ts"));
    });

    it("leaves a modified arrow to whatever binding owns that chord", () => {
      renderList(files(3));
      row("file-000.ts").focus();
      for (const modifier of ["shiftKey", "altKey", "metaKey", "ctrlKey"] as const) {
        expect(press("ArrowDown", { [modifier]: true })).toBe(false);
        expect(document.activeElement).toBe(row("file-000.ts"));
      }
    });

    it("leaves keys on a review-thread badge alone", () => {
      const list = files(3);
      renderList(list, {
        [list[0]!.path]: { badge: "2", tooltip: "2 unresolved threads", url: "https://x.test" },
      });
      const badge = screen.getByRole("button", { name: "2 unresolved threads" });
      badge.focus();

      expect(press("ArrowDown")).toBe(false);
      expect(document.activeElement).toBe(badge);
    });
  });

  describe("windowed list", () => {
    const count = FILE_LIST_VIRTUALIZATION_THRESHOLD + 40;
    const last = count - 1;
    const lastName = `file-${String(last).padStart(3, "0")}.ts`;

    it("asks the virtualizer for a row it has not mounted and focuses it once it mounts", () => {
      mountedRange.current = { start: 0, end: 9 };
      scrollToIndexMock.mockImplementation(({ index }) => {
        mountedRange.current = { start: index - 9, end: index };
      });
      renderList(files(count));
      row("file-000.ts").focus();

      expect(press("End")).toBe(true);
      expect(scrollToIndexMock).toHaveBeenCalledWith(
        expect.objectContaining({ index: last, align: "start" })
      );
      expect(document.activeElement).toBe(row(lastName));
    });

    it("moves to a mounted row natively without asking the virtualizer", () => {
      mountedRange.current = { start: 0, end: 9 };
      renderList(files(count));
      row("file-003.ts").focus();

      press("ArrowDown");
      expect(document.activeElement).toBe(row("file-004.ts"));
      expect(scrollToIndexMock).not.toHaveBeenCalled();
    });

    it("keeps stepping from the requested row while it is still on its way", () => {
      mountedRange.current = { start: 0, end: 9 };
      renderList(files(count));
      row("file-000.ts").focus();

      // The window has not moved yet: focus waits on the list, not the document.
      expect(press("End")).toBe(true);
      expect(document.activeElement).toBe(screen.getByTestId("base-branch-file-list"));

      scrollToIndexMock.mockImplementation(({ index }) => {
        mountedRange.current = { start: index - 9, end: index };
      });
      expect(press("ArrowUp")).toBe(true);
      expect(scrollToIndexMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ index: last - 1 })
      );
      expect(document.activeElement).toBe(row(`file-${String(last - 1).padStart(3, "0")}.ts`));
    });

    it("never takes focus back once the user has left the list", () => {
      mountedRange.current = { start: 0, end: 9 };
      const view = renderList(files(count));
      row("file-000.ts").focus();
      press("End");

      const outside = screen.getByRole("button", { name: "Outside" });
      outside.focus();
      // The window arrives late, after focus has gone elsewhere.
      mountedRange.current = { start: last - 9, end: last };
      view.rerenderList({ decorations: {} });

      expect(row(lastName)).toBeTruthy();
      expect(document.activeElement).toBe(outside);
    });
  });
});
