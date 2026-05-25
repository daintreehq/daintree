// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SortableWorktreeTerminal } from "../SortableWorktreeTerminal";
import { useDragHandle } from "../DragHandleContext";
import type { PanelInstance } from "@shared/types/panel";

let mockIsDragging = false;
const mockSetActivatorNodeRef = vi.fn();

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button" },
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
  id: "t3",
  kind: "terminal",
  title: "Worktree Terminal",
  cwd: "/test",
  cols: 80,
  rows: 24,
  worktreeId: "wt1",
  location: "grid",
  isVisible: true,
} as PanelInstance;

describe("SortableWorktreeTerminal", () => {
  it("renders children when given a ReactNode", () => {
    mockIsDragging = false;
    const { getByTestId } = render(
      <SortableWorktreeTerminal terminal={terminal} worktreeId="wt1" sourceIndex={0}>
        <div data-testid="child" />
      </SortableWorktreeTerminal>
    );
    expect(getByTestId("child")).toBeTruthy();
  });

  it("renders children through DragHandleProvider", () => {
    mockIsDragging = false;
    const { getByTestId } = render(
      <SortableWorktreeTerminal terminal={terminal} worktreeId="wt1" sourceIndex={0}>
        <div data-testid="inner-child" />
      </SortableWorktreeTerminal>
    );
    expect(getByTestId("inner-child")).toBeTruthy();
  });

  it("forwards setActivatorNodeRef and listeners through DragHandleProvider for keyboard a11y", () => {
    mockIsDragging = false;
    let captured: ReturnType<typeof useDragHandle> = null;
    function Probe() {
      captured = useDragHandle();
      return null;
    }
    render(
      <SortableWorktreeTerminal terminal={terminal} worktreeId="wt1" sourceIndex={0}>
        <Probe />
      </SortableWorktreeTerminal>
    );
    expect(captured).not.toBeNull();
    expect(captured!.setActivatorNodeRef).toBe(mockSetActivatorNodeRef);
    expect(captured!.listeners).toBeDefined();
  });

  it("does not apply opacity-40 class (opacity now driven by framer-motion animate)", () => {
    mockIsDragging = true;
    const { container } = render(
      <SortableWorktreeTerminal terminal={terminal} worktreeId="wt1" sourceIndex={0}>
        <div />
      </SortableWorktreeTerminal>
    );
    const outer = container.firstChild as HTMLElement;
    const inner = outer.firstChild as HTMLElement;
    expect(inner.className).not.toContain("opacity-40");
  });
});
