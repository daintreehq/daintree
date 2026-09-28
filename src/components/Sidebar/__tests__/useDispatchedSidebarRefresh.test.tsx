// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useDispatchedSidebarRefresh } from "../useDispatchedSidebarRefresh";

const start = () =>
  act(() => {
    window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
  });
const settle = () =>
  act(() => {
    window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar-settled"));
  });

const strict = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;

describe.each([
  ["plain", undefined],
  ["StrictMode", strict],
])("useDispatchedSidebarRefresh (%s)", (_label, wrapper) => {
  afterEach(cleanup);

  it("stays in flight until the last overlapping refresh settles", () => {
    const { result } = renderHook(() => useDispatchedSidebarRefresh(), { wrapper });
    expect(result.current).toBe(false);
    start();
    start();
    expect(result.current).toBe(true);
    settle();
    expect(result.current).toBe(true);
    settle();
    expect(result.current).toBe(false);
  });

  it("ignores a settle it never saw start, so a later refresh still shows", () => {
    const { result } = renderHook(() => useDispatchedSidebarRefresh(), { wrapper });
    settle();
    expect(result.current).toBe(false);
    start();
    expect(result.current).toBe(true);
    settle();
    expect(result.current).toBe(false);
  });

  it("removes every listener it adds once unmounted", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useDispatchedSidebarRefresh(), { wrapper });
    unmount();
    const ours = (calls: unknown[][]) =>
      calls.filter(([type]) => String(type).startsWith("daintree:refresh-sidebar"));
    const added = ours(add.mock.calls);
    expect(added.length).toBeGreaterThan(0);
    for (const [type, handler] of added) {
      expect(remove).toHaveBeenCalledWith(type, handler);
    }
    add.mockRestore();
    remove.mockRestore();
  });
});
