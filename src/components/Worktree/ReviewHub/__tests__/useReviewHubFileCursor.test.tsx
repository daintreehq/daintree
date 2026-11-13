/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { StagingFileEntry } from "@shared/types";
import { useReviewHubFileCursor, type ReviewHubNavigableItem } from "../useReviewHubFileCursor";

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
    const after = list(["a"], ["d", "c", "b"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:c");
  });

  it("lands on the next row that survived when several rows leave together", () => {
    const before = list([], ["a", "b", "c", "d", "e"]);
    const hook = cursorOn(before, "unstaged:b");
    const after = list(["b", "c"], ["a", "d", "e"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:d");
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
    const before = list(["a"], ["b", "c", "d"]);
    const hook = cursorOn(before, "unstaged:c");
    const after = list(["a"], ["x", "y", "z"]);
    hook.rerender(after);
    expect(focusedKey(hook, after)).toBe("unstaged:y");
  });

  it("clears the cursor when the list empties", () => {
    const before = list([], ["a"]);
    const hook = cursorOn(before, "unstaged:a");
    hook.rerender(list([], []));
    expect(hook.result.current.focusedIndex).toBe(-1);
  });
});
