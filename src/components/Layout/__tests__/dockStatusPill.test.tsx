// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { dockStatusScopeDescription, useDockPopoverFocusHandoff } from "../dockStatusPill";

function closeEvent() {
  const event = new Event("focusOutside", { cancelable: true });
  return { event, wasPrevented: () => event.defaultPrevented };
}

describe("useDockPopoverFocusHandoff", () => {
  it("leaves an ordinary close to the shared restore policy", () => {
    const { result } = renderHook(() => useDockPopoverFocusHandoff());
    const close = closeEvent();
    act(() => result.current.onCloseAutoFocus(close.event));
    expect(close.wasPrevented()).toBe(false);
  });

  it("suppresses restoration only for the close that handed focus to a panel", () => {
    const { result } = renderHook(() => useDockPopoverFocusHandoff());
    act(() => result.current.markHandoff());
    const handedOff = closeEvent();
    act(() => result.current.onCloseAutoFocus(handedOff.event));
    expect(handedOff.wasPrevented()).toBe(true);

    const next = closeEvent();
    act(() => result.current.onCloseAutoFocus(next.event));
    expect(next.wasPrevented()).toBe(false);
  });
});

describe("dockStatusScopeDescription", () => {
  it("always names the project-wide scope, and the local share distinguishes its cases", () => {
    const cases = [
      dockStatusScopeDescription(3, 0),
      dockStatusScopeDescription(3, 1),
      dockStatusScopeDescription(3, 3),
    ];
    for (const text of cases) expect(text).toContain("all worktrees");
    expect(new Set(cases).size).toBe(cases.length);
    expect(dockStatusScopeDescription(3, 1)).toContain("1");
  });
});
