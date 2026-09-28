// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelpPanelResizeHandle } from "../HelpPanelResizeHandle";

function renderHandle(overrides: Partial<Parameters<typeof HelpPanelResizeHandle>[0]> = {}) {
  const props = {
    width: 500,
    isResizing: false,
    isVisible: true,
    controlsId: "panel",
    onMouseDown: vi.fn(),
    onKeyDown: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  const { unmount } = render(<HelpPanelResizeHandle {...props} />);
  return { props, handle: screen.getByRole("separator"), unmount };
}

describe("HelpPanelResizeHandle", () => {
  it("resets on double-click", () => {
    const { props, handle } = renderHandle();
    fireEvent.doubleClick(handle);
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });

  it("names the reset gesture alongside the resize", () => {
    const { handle } = renderHandle();
    const label = handle.getAttribute("aria-label") ?? "";
    expect(label).toMatch(/^Resize /);
    expect(label).toMatch(/double-click to reset/i);
  });

  it("is reachable by keyboard only while the panel is visible", () => {
    const { handle } = renderHandle({ isVisible: false });
    expect(handle.tabIndex).toBe(-1);
  });

  it("keeps the grip neutral in every state — the accent belongs to the focus outline", () => {
    for (const isResizing of [false, true]) {
      const { handle, unmount } = renderHandle({ isResizing });
      const grip = handle.firstElementChild;
      expect(grip).not.toBeNull();
      expect(grip?.getAttribute("class")).not.toMatch(/accent/);
      unmount();
    }
  });

  it("does not let hover styling outrank the drag state", () => {
    const { handle } = renderHandle({ isResizing: true });
    expect(handle.className).not.toMatch(/hover:/);
  });
});
