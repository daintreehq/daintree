/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { StagingFileEntry } from "@shared/types";
import {
  resolveDisplacedCursor,
  useReviewHubFileCursor,
  type ReviewHubNavigableItem,
} from "../useReviewHubFileCursor";

function entry(path: string): StagingFileEntry {
  return { path, status: "modified", insertions: 1, deletions: 0 } as StagingFileEntry;
}

function list(staged: string[], unstaged: string[]) {
  const navigableItems: ReviewHubNavigableItem[] = [
    ...staged.map((path) => ({ section: "staged" as const, file: entry(path) })),
    ...unstaged.map((path) => ({ section: "unstaged" as const, file: entry(path) })),
  ];
  return { navigableItems, stagedCount: staged.length, menuReplayBlocked: false };
}

type Lists = ReturnType<typeof list>;

function cursorOn(initial: Lists, key: string) {
  const hook = renderHook((props: Lists) => useReviewHubFileCursor(props), {
    initialProps: initial,
  });
  const index = initial.navigableItems.findIndex(
    (item) => `${item.section}:${item.file.path}` === key
  );
  expect(index).toBeGreaterThanOrEqual(0);
  act(() => hook.result.current.moveCursorTo(index));
  return hook;
}

function focusedKey(hook: ReturnType<typeof cursorOn>, lists: Lists): string | null {
  const item = lists.navigableItems[hook.result.current.focusedIndex];
  return item ? `${item.section}:${item.file.path}` : null;
}

describe("useReviewHubFileCursor — the cursor across a stage or unstage (#16895)", () => {
  afterEach(cleanup);

  it("stays in Unstaged on the row below when a middle unstaged row is staged", () => {
    const before = list(["a"], ["b", "c", "d"]);
    const hook = cursorOn(before, "unstaged:c");
    const after = list(["a", "c"], ["b", "d"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:d");
  });

  it("stays in Unstaged on the row below when the first unstaged row is staged", () => {
    const before = list(["a"], ["b", "c"]);
    const hook = cursorOn(before, "unstaged:b");
    const after = list(["a", "b"], ["c"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:c");
  });

  it("steps up to the row above when the last unstaged row is staged", () => {
    const before = list(["a"], ["b", "c"]);
    const hook = cursorOn(before, "unstaged:c");
    const after = list(["a", "c"], ["b"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:b");
  });

  it("stays in Staged on the row above when the last staged row is unstaged", () => {
    const before = list(["a", "b"], ["c"]);
    const hook = cursorOn(before, "staged:b");
    const after = list(["a"], ["b", "c"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("staged:a");
  });

  it("stays in Staged on the row below when a middle staged row is unstaged", () => {
    const before = list(["a", "b", "c"], ["d"]);
    const hook = cursorOn(before, "staged:b");
    const after = list(["a", "c"], ["b", "d"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("staged:c");
  });

  it("crosses to the nearest staged row only once Unstaged is empty", () => {
    const before = list(["a", "c"], ["b"]);
    const hook = cursorOn(before, "unstaged:b");
    const after = list(["a", "b", "c"], []);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("staged:c");
  });

  it("crosses to the first unstaged row only once Staged is empty", () => {
    const before = list(["b"], ["a", "c"]);
    const hook = cursorOn(before, "staged:b");
    const after = list([], ["a", "b", "c"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:a");
  });

  it("still follows a file that stays in its section across a re-sort", () => {
    const before = list(["a"], ["b", "c", "d"]);
    const hook = cursorOn(before, "unstaged:c");
    const after = list(["a"], ["c", "d", "b"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:c");
  });

  it("lands on the next row that survived when several rows leave together", () => {
    // The same position in the section would be `e`: `c` left with `b`.
    const before = list([], ["a", "b", "c", "d", "e"]);
    const hook = cursorOn(before, "unstaged:b");
    const after = list(["a", "b", "c"], ["d", "e"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:d");
  });

  it("falls back to the nearest row above that survived when nothing below did", () => {
    // The same position in the section would be the newly arrived `x`.
    const before = list(["a", "b"], ["c"]);
    const hook = cursorOn(before, "staged:b");
    const after = list(["a", "x"], ["b", "c"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("staged:a");
  });

  it("does not count the file's own copy in the other section as a neighbour", () => {
    // A partially staged file is listed in both sections; staging the rest of
    // it leaves only its staged copy, which is not the row below the cursor.
    const before = list(["a"], ["a", "b"]);
    const hook = cursorOn(before, "unstaged:a");
    const after = list(["a"], ["b"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:b");
  });

  it("keeps its position in the section when a refresh replaces every row around it", () => {
    // Staged grew too, so the old flat index would name `x`.
    const before = list(["a"], ["b", "c", "d"]);
    const hook = cursorOn(before, "unstaged:c");
    const after = list(["a", "s"], ["x", "y", "z"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:y");
  });

  it("holds that position to the section's new end when the replacement is shorter", () => {
    const before = list(["a"], ["b", "c", "d"]);
    const hook = cursorOn(before, "unstaged:d");
    const after = list(["a"], ["x", "y"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:y");
  });

  it("stays on the row it moved to when the file it left comes back", () => {
    const before = list(["a"], ["b", "c"]);
    const hook = cursorOn(before, "unstaged:b");
    const staged = list(["a", "b"], ["c"]);
    hook.rerender(staged);
    expect(focusedKey(hook, staged)).toBe("unstaged:c");
    const restored = list(["a"], ["b", "c"]);
    hook.rerender(restored);
    expect(focusedKey(hook, restored)).toBe("unstaged:c");
  });

  it("finds its neighbours in the latest order, not the order it first saw", () => {
    const before = list([], ["a", "b", "c"]);
    const hook = cursorOn(before, "unstaged:b");
    hook.rerender(list([], ["c", "b", "a"]));
    const after = list([], ["c", "a"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:a");
  });

  it("clears the cursor when the list empties, and leaves it clear when rows return", () => {
    const before = list([], ["a"]);
    const hook = cursorOn(before, "unstaged:a");
    hook.rerender(list([], []));
    expect(hook.result.current.focusedIndex).toBe(-1);
    hook.rerender(list([], ["a", "b"]));
    expect(hook.result.current.focusedIndex).toBe(-1);
  });
});

describe("resolveDisplacedCursor for a key the previous list never held", () => {
  const { navigableItems: rows } = list(["s"], ["a", "b", "c"]);

  it("starts from the old index and counts the row sitting there", () => {
    expect(resolveDisplacedCursor(rows, 2, "unstaged:missing", rows)).toBe(2);
  });

  it("holds an out-of-range old index to the previous list's ends", () => {
    expect(resolveDisplacedCursor(rows, -1, "unstaged:missing", rows)).toBe(1);
    expect(resolveDisplacedCursor(rows, 99, "unstaged:missing", rows)).toBe(3);
  });
});
