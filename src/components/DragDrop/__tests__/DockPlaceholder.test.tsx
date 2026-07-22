// @vitest-environment jsdom
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

const mockUseDndPlaceholder = vi.fn();
vi.mock("../DndProvider", () => ({
  useDndPlaceholder: () => mockUseDndPlaceholder(),
}));
vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({ agentId: null }),
}));

const { sortableListeners, setNodeRefSpy } = vi.hoisted(() => ({
  sortableListeners: {
    onPointerDown: vi.fn(),
    onMouseDown: vi.fn(),
    onTouchStart: vi.fn(),
    onKeyDown: vi.fn(),
  },
  setNodeRefSpy: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button", tabIndex: 0, "aria-describedby": "dnd-describedby" },
    listeners: sortableListeners,
    setNodeRef: setNodeRefSpy,
    transform: null,
    transition: undefined,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock("framer-motion", () => ({
  m: { div: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
}));

import { DockPlaceholder, SortableDockPlaceholder, DOCK_PLACEHOLDER_ID } from "../DockPlaceholder";

// The mock's return value is untyped (any), so a plain literal stands in for the
// active panel without an unsafe cast — DockPlaceholder only reads `kind`.
function ghostPanel(kind: string) {
  return { id: "p1", kind, title: "Ghost", location: "dock", isVisible: true };
}

/**
 * Regression coverage for #11055. The dock renders the placeholder in compact
 * mode; browser/dev-preview panels used to overflow --dock-item-height and grow
 * the whole dock bar during a drag. jsdom can't measure heights, so we assert
 * the two structural properties that produce the fix: the box is no longer
 * content-height-driven, and the overflowing body is dropped on the dock path.
 */
describe("DockPlaceholder height containment (#11055)", () => {
  it("renders an invisible spacer with no ghost art when not dragging", () => {
    mockUseDndPlaceholder.mockReturnValue({ activeTerminal: null, isDragging: false });
    const { container } = render(<DockPlaceholder />);
    const root = container.querySelector("[aria-hidden='true']");
    expect(root).not.toBeNull();
    expect(container.querySelector("[data-placeholder-body]")).toBeNull();
  });

  it("clamps the ghost to a definite height and drops the browser body while dragging", () => {
    mockUseDndPlaceholder.mockReturnValue({
      activeTerminal: ghostPanel("browser"),
      isDragging: true,
    });
    const { container } = render(<DockPlaceholder />);
    const root = container.querySelector("[aria-hidden='true']");
    // Guard against a false pass on an empty render: the ghost must exist before
    // the class/body assertions below are meaningful.
    expect(root).not.toBeNull();
    // The #11055 bug was `h-full` resolving to auto height that grew with the
    // ghost content. The box must be pinned to a definite height instead.
    expect(root?.className ?? "").not.toContain("h-full");
    // And the tall browser body must be absent on the compact dock path.
    expect(container.querySelector("[data-placeholder-body]")).toBeNull();
  });

  it("drops the dev-preview split body while dragging", () => {
    mockUseDndPlaceholder.mockReturnValue({
      activeTerminal: ghostPanel("dev-preview"),
      isDragging: true,
    });
    const { container } = render(<DockPlaceholder />);
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(container.querySelector("[data-placeholder-body]")).toBeNull();
  });
});

/**
 * Regression coverage for #11291. The empty-dock placeholder used to spread
 * useSortable's activator attributes/listeners, making the invisible strip a
 * drag source whose terminal-less drag data threw inside cancelDrop and
 * wedged dnd-kit app-wide. It must stay registered as a drop target
 * (setNodeRef) but never activate a drag.
 */
describe("SortableDockPlaceholder is a drop target, not a drag source (#11291)", () => {
  function renderPlaceholder() {
    mockUseDndPlaceholder.mockReturnValue({ activeTerminal: null, isDragging: false });
    const { container } = render(<SortableDockPlaceholder />);
    const node = container.querySelector<HTMLElement>(
      `[data-placeholder-id="${DOCK_PLACEHOLDER_ID}"]`
    );
    expect(node).not.toBeNull();
    return node!;
  }

  it("stays registered as a droppable via setNodeRef", () => {
    const node = renderPlaceholder();
    expect(setNodeRefSpy).toHaveBeenCalledWith(node);
  });

  it("does not forward sortable activator attributes", () => {
    const node = renderPlaceholder();
    expect(node.getAttribute("role")).toBeNull();
    expect(node.hasAttribute("tabindex")).toBe(false);
    expect(node.hasAttribute("aria-describedby")).toBe(false);
  });

  it("does not forward drag activator listeners", () => {
    const node = renderPlaceholder();
    fireEvent.pointerDown(node);
    fireEvent.mouseDown(node);
    fireEvent.touchStart(node);
    fireEvent.keyDown(node, { code: "Enter" });
    expect(sortableListeners.onPointerDown).not.toHaveBeenCalled();
    expect(sortableListeners.onMouseDown).not.toHaveBeenCalled();
    expect(sortableListeners.onTouchStart).not.toHaveBeenCalled();
    expect(sortableListeners.onKeyDown).not.toHaveBeenCalled();
  });
});
