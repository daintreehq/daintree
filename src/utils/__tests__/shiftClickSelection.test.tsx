// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { suppressShiftClickTextSelection } from "../shiftClickSelection";

afterEach(cleanup);

function renderSurface() {
  const { getByTestId } = render(
    <div data-testid="surface" onMouseDown={suppressShiftClickTextSelection}>
      <span data-testid="text">Worktree</span>
      <button type="button" data-testid="button">
        <span data-testid="button-label">Toggle</span>
      </button>
      <input data-testid="input" />
      <div contentEditable suppressContentEditableWarning data-testid="editable">
        editable
      </div>
    </div>
  );
  return getByTestId;
}

describe("suppressShiftClickTextSelection (#12926)", () => {
  it("cancels a primary-button Shift+mousedown", () => {
    const get = renderSurface();
    expect(fireEvent.mouseDown(get("text"), { shiftKey: true, button: 0 })).toBe(false);
  });

  it.each([
    ["plain", {}],
    ["Meta", { metaKey: true }],
    ["Ctrl", { ctrlKey: true }],
    ["secondary button", { shiftKey: true, button: 2 }],
    ["middle button", { shiftKey: true, button: 1 }],
  ])("leaves a %s mousedown alone", (_label, init) => {
    const get = renderSurface();
    expect(fireEvent.mouseDown(get("text"), { button: 0, ...init })).toBe(true);
  });

  it("leaves text fields with native Shift+click behaviour", () => {
    const get = renderSurface();
    expect(fireEvent.mouseDown(get("input"), { shiftKey: true, button: 0 })).toBe(true);
    expect(fireEvent.mouseDown(get("editable"), { shiftKey: true, button: 0 })).toBe(true);
  });

  it("moves focus to the focusable element the cancelled mousedown would have focused", () => {
    const get = renderSurface();
    expect(fireEvent.mouseDown(get("button-label"), { shiftKey: true, button: 0 })).toBe(false);
    expect(document.activeElement).toBe(get("button"));
  });

  it("does not focus anything when the target has no focusable ancestor in the surface", () => {
    const get = renderSurface();
    const before = document.activeElement;
    fireEvent.mouseDown(get("text"), { shiftKey: true, button: 0 });
    expect(document.activeElement).toBe(before);
  });

  it("does not reach past the surface for a focusable ancestor", () => {
    const { getByTestId } = render(
      <div tabIndex={0} data-testid="outer">
        <div onMouseDown={suppressShiftClickTextSelection}>
          <span data-testid="inner">Row</span>
        </div>
      </div>
    );
    fireEvent.mouseDown(getByTestId("inner"), { shiftKey: true, button: 0 });
    expect(document.activeElement).not.toBe(getByTestId("outer"));
  });
});
