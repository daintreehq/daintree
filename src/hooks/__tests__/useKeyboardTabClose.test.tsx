// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isTabCloseKey, useKeyboardTabClose } from "../useKeyboardTabClose";

function setup(initial: { ids: string[]; activeId: string | null }) {
  const focusTab = vi.fn();
  const onEmpty = vi.fn();
  const hook = renderHook(
    (props: { ids: string[]; activeId: string | null }) =>
      useKeyboardTabClose({ ...props, focusTab, onEmpty }),
    { initialProps: initial }
  );
  return { ...hook, focusTab, onEmpty };
}

describe("useKeyboardTabClose", () => {
  it("waits for the closing tab to be gone before moving focus", () => {
    const { result, rerender, focusTab } = setup({ ids: ["a", "b", "c"], activeId: "a" });
    act(() => result.current.armKeyboardClose("b"));
    // The list rebuilt for another reason — the close has not landed.
    rerender({ ids: ["a", "b", "c"], activeId: "a" });
    expect(focusTab).not.toHaveBeenCalled();
    rerender({ ids: ["a", "c"], activeId: "a" });
    expect(focusTab).toHaveBeenCalledWith("c");
  });

  it("falls back to the preceding tab when the last one closes", () => {
    const { result, rerender, focusTab } = setup({ ids: ["a", "b"], activeId: "a" });
    act(() => result.current.armKeyboardClose("b"));
    rerender({ ids: ["a"], activeId: "a" });
    expect(focusTab).toHaveBeenCalledWith("a");
  });

  it("follows the host's new selection when the selected tab closes", () => {
    const { result, rerender, focusTab } = setup({ ids: ["a", "b", "c"], activeId: "b" });
    act(() => result.current.armKeyboardClose("b"));
    rerender({ ids: ["a", "c"], activeId: "a" });
    expect(focusTab).toHaveBeenCalledWith("a");
  });

  it("stands down when disarmed for the closing tab", () => {
    const { result, rerender, focusTab } = setup({ ids: ["a", "b", "c"], activeId: "a" });
    act(() => result.current.armKeyboardClose("b"));
    act(() => result.current.disarmKeyboardClose("b"));
    rerender({ ids: ["a", "c"], activeId: "a" });
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("ignores a disarm aimed at another tab", () => {
    const { result, rerender, focusTab } = setup({ ids: ["a", "b", "c"], activeId: "a" });
    act(() => result.current.armKeyboardClose("b"));
    act(() => result.current.disarmKeyboardClose("c"));
    rerender({ ids: ["a", "c"], activeId: "a" });
    expect(focusTab).toHaveBeenCalledWith("c");
  });

  it("hands off to onEmpty when the last tab closes", () => {
    const { result, rerender, focusTab, onEmpty } = setup({ ids: ["a"], activeId: "a" });
    act(() => result.current.armKeyboardClose("a"));
    rerender({ ids: [], activeId: null });
    expect(onEmpty).toHaveBeenCalledTimes(1);
    expect(focusTab).not.toHaveBeenCalled();
  });

  it("treats Delete and Backspace as the close keys, and nothing else", () => {
    expect(["Delete", "Backspace", "Enter", " ", "x"].filter(isTabCloseKey)).toEqual([
      "Delete",
      "Backspace",
    ]);
  });
});
