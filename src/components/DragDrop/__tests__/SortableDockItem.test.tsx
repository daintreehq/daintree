// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SortableDockItem } from "../SortableDockItem";
import { useDragHandle } from "../DragHandleContext";
import type { PanelInstance } from "@shared/types/panel";

interface MockSortableState {
  isDragging?: boolean;
  isOver?: boolean;
  active?: {
    data: { current: { sourceLocation?: string; origin?: string } };
    rect: { current: { translated: { left: number; width: number } | null } };
  } | null;
  over?: { rect: { left: number; width: number } } | null;
}

let mockState: MockSortableState = { isDragging: false };
const mockSetActivatorNodeRef = vi.fn();

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button", tabIndex: 0 },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: vi.fn(),
    setActivatorNodeRef: mockSetActivatorNodeRef,
    transform: null,
    transition: undefined,
    isDragging: mockState.isDragging ?? false,
    isOver: mockState.isOver ?? false,
    active: mockState.active ?? null,
    over: mockState.over ?? null,
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
    mockState = { isDragging: false };
    const { getByTestId } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div data-testid="child" />
      </SortableDockItem>
    );
    expect(getByTestId("child")).toBeTruthy();
  });

  it("does not render role=button on the outer m.div (stripped from dnd-kit attributes)", () => {
    mockState = { isDragging: false };
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    const outer = container.firstChild as HTMLElement;
    expect(outer.getAttribute("role")).toBeNull();
  });

  it("does not apply opacity-40 class (opacity now driven by framer-motion animate)", () => {
    mockState = { isDragging: true };
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
    mockState = { isDragging: false };
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

  it("renders no insertion indicator when idle", () => {
    mockState = { isDragging: false };
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    expect(container.querySelector("[data-dock-drop-indicator]")).toBeNull();
  });

  it("shows a 'before' indicator on the left when the dragged midpoint is left of the hovered chip", () => {
    mockState = {
      isOver: true,
      active: {
        data: { current: { sourceLocation: "dock" } },
        rect: { current: { translated: { left: 0, width: 40 } } },
      },
      over: { rect: { left: 100, width: 40 } },
    };
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    const indicator = container.querySelector("[data-dock-drop-indicator]");
    expect(indicator?.getAttribute("data-dock-drop-indicator")).toBe("before");
    expect(indicator?.className).toContain("-left-px");
    expect(indicator?.className).not.toContain("-right-px");
  });

  it("shows an 'after' indicator on the right when the dragged midpoint is right of the hovered chip", () => {
    mockState = {
      isOver: true,
      active: {
        data: { current: { sourceLocation: "dock" } },
        rect: { current: { translated: { left: 200, width: 40 } } },
      },
      over: { rect: { left: 100, width: 40 } },
    };
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    const indicator = container.querySelector("[data-dock-drop-indicator]");
    expect(indicator?.getAttribute("data-dock-drop-indicator")).toBe("after");
    expect(indicator?.className).toContain("-right-px");
    expect(indicator?.className).not.toContain("-left-px");
  });

  it("renders no indicator for a cross-container grid drag even when hovered", () => {
    mockState = {
      isOver: true,
      active: {
        data: { current: { sourceLocation: "grid" } },
        rect: { current: { translated: { left: 0, width: 40 } } },
      },
      over: { rect: { left: 100, width: 40 } },
    };
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    expect(container.querySelector("[data-dock-drop-indicator]")).toBeNull();
  });

  it("renders no indicator for an accordion-origin drag of a docked terminal", () => {
    mockState = {
      isOver: true,
      active: {
        data: { current: { sourceLocation: "dock", origin: "accordion" } },
        rect: { current: { translated: { left: 0, width: 40 } } },
      },
      over: { rect: { left: 100, width: 40 } },
    };
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    expect(container.querySelector("[data-dock-drop-indicator]")).toBeNull();
  });

  it("renders no indicator before dnd-kit has measured the dragged rect", () => {
    mockState = {
      isOver: true,
      active: {
        data: { current: { sourceLocation: "dock" } },
        rect: { current: { translated: null } },
      },
      over: { rect: { left: 100, width: 40 } },
    };
    const { container } = render(
      <SortableDockItem terminal={terminal} sourceIndex={0}>
        <div />
      </SortableDockItem>
    );
    expect(container.querySelector("[data-dock-drop-indicator]")).toBeNull();
  });
});
