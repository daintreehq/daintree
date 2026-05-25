// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SortableDockItem } from "../SortableDockItem";
import { useDragHandle } from "../DragHandleContext";
import type { PanelInstance } from "@shared/types/panel";

let mockIsDragging = false;
const mockSetActivatorNodeRef = vi.fn();

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button", tabIndex: 0 },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    setActivatorNodeRef: mockSetActivatorNodeRef,
    transform: null,
    transition: undefined,
    isDragging: mockIsDragging,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

const terminal: PanelInstance = {
  id: "t2",
  kind: "terminal",
  title: "Dock Terminal",
  cwd: "/test",
  cols: 80,
  rows: 24,
  worktreeId: "wt1",
  location: "dock",
  isVisible: true,
} as PanelInstance;

describe("SortableDockItem", () => {
  it("renders children through DragHandleProvider", () => {
    mockIsDragging = false;
    const { getByTestId } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div data-testid="child" />
      </SortableDockItem>
    );
    expect(getByTestId("child")).toBeTruthy();
  });

  it("does not render role=button on the outer m.div (stripped from dnd-kit attributes)", () => {
    mockIsDragging = false;
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    const outer = container.firstChild as HTMLElement;
    expect(outer.getAttribute("role")).toBeNull();
  });

  it("does not apply opacity-40 class (opacity now driven by framer-motion animate)", () => {
    mockIsDragging = true;
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    const outer = container.firstChild as HTMLElement;
    const inner = outer.firstChild as HTMLElement;
    expect(inner.className).not.toContain("opacity-40");
  });

  it("forwards setActivatorNodeRef through DragHandleProvider for keyboard a11y", () => {
    mockIsDragging = false;
    let captured: ReturnType<typeof useDragHandle> = null;
    function Probe() {
      captured = useDragHandle();
      return null;
    }
    render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <Probe />
      </SortableDockItem>
    );
    expect(captured).not.toBeNull();
    expect(captured!.setActivatorNodeRef).toBe(mockSetActivatorNodeRef);
    expect(captured!.listeners).toBeDefined();
  });
});
