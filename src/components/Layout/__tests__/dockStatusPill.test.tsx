// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createPortal } from "react-dom";
import { act, createEvent, fireEvent, render, renderHook, screen } from "@testing-library/react";
import {
  DockPopoverList,
  dockStatusScopeDescription,
  useDockPopoverFocusHandoff,
} from "../dockStatusPill";

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

describe("DockPopoverList keyboard model", () => {
  function renderList() {
    const view = render(
      <DockPopoverList>
        <div data-dock-row="">
          <button>a-main</button>
          <button>a-kill</button>
        </div>
        <div data-dock-row="">
          <button>b-watch</button>
          <button data-dock-row-target="">b-restore</button>
          <button>b-kill</button>
        </div>
        <div>
          <div data-dock-row="">
            <button>c-header</button>
          </div>
          <div data-dock-row="">
            <button>d-member</button>
            <button disabled>d-disabled</button>
          </div>
        </div>
        <button data-dock-row="">e-row</button>
      </DockPopoverList>
    );
    const list = view.container.querySelector<HTMLElement>("[data-dock-popover-list]")!;
    return { list };
  }
  const button = (name: string) => screen.getByRole("button", { name });
  const tabbable = (list: HTMLElement) =>
    Array.from(list.querySelectorAll<HTMLElement>("button:not([disabled])"))
      .filter((b) => b.tabIndex === 0)
      .map((b) => b.textContent);

  it("is one Tab stop: the first row's primary control, and nothing else", () => {
    const { list } = renderList();
    expect(tabbable(list)).toEqual(["a-main"]);
  });

  it("moves between rows onto each row's primary control, and to the ends", () => {
    renderList();
    button("a-main").focus();
    fireEvent.keyDown(button("a-main"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(button("b-restore"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(button("c-header"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(button("d-member"));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(button("e-row"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(button("e-row"));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(button("a-main"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(button("a-main"));
  });

  it("moves across a row's own controls with Left/Right, never into another row", () => {
    renderList();
    button("b-restore").focus();
    fireEvent.keyDown(button("b-restore"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(button("b-kill"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(button("b-kill"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(button("b-watch"));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(button("b-watch"));
  });

  it("hands the one Tab stop to whichever control focus lands on, pointer or key", () => {
    const { list } = renderList();
    act(() => button("b-kill").focus());
    expect(tabbable(list)).toEqual(["b-kill"]);
    act(() => button("d-member").focus());
    expect(tabbable(list)).toEqual(["d-member"]);
  });

  it("leaves keys from portalled content (a row's menu) alone", () => {
    function WithPortal() {
      return (
        <DockPopoverList>
          <div data-dock-row="">
            <button>row</button>
            {createPortal(
              <div data-dock-row="">
                <button>menu item</button>
              </div>,
              document.body
            )}
          </div>
          <div data-dock-row="">
            <button>next</button>
          </div>
        </DockPopoverList>
      );
    }
    render(<WithPortal />);
    const item = button("menu item");
    item.focus();
    const event = createEvent.keyDown(item, { key: "ArrowDown" });
    fireEvent(item, event);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(item);
  });
});

describe("useDockPopoverFocusHandoff — keyboard entry", () => {
  function autoFocusEvent(target: HTMLElement) {
    const event = new Event("focusScope.autoFocusOnMount", { cancelable: true });
    Object.defineProperty(event, "currentTarget", { value: target });
    return event;
  }

  it("takes focus to the popover only when the pill was opened from the keyboard", () => {
    const { result } = renderHook(() => useDockPopoverFocusHandoff());
    const content = document.createElement("div");
    content.tabIndex = -1;
    document.body.appendChild(content);

    act(() => result.current.onTriggerClick({ detail: 1 }));
    act(() => result.current.onOpenAutoFocus(autoFocusEvent(content)));
    expect(document.activeElement).not.toBe(content);

    act(() => result.current.onTriggerClick({ detail: 0 }));
    const keyboardOpen = autoFocusEvent(content);
    act(() => result.current.onOpenAutoFocus(keyboardOpen));
    expect(document.activeElement).toBe(content);
    expect(keyboardOpen.defaultPrevented).toBe(true);
    content.remove();
  });

  it("enters the list from the popover root on the first arrow press", () => {
    function Harness() {
      const handoff = useDockPopoverFocusHandoff();
      return (
        <div data-testid="root" tabIndex={-1} onKeyDown={handoff.onContentKeyDown}>
          <DockPopoverList>
            <div data-dock-row="">
              <button>first</button>
            </div>
            <div data-dock-row="">
              <button>last</button>
            </div>
          </DockPopoverList>
        </div>
      );
    }
    render(<Harness />);
    const root = screen.getByTestId("root");
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "first" }));
    root.focus();
    fireEvent.keyDown(root, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "last" }));
  });
});
