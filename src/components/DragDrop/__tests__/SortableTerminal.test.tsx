// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SortableTerminal } from "../SortableTerminal";
import type { TerminalInstance } from "@/store";

let mockIsDragging = false;
const useSortableSpy = vi.fn();

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: (args: unknown) => {
    useSortableSpy(args);
    return {
      attributes: { role: "button" },
      listeners: undefined,
      setNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: mockIsDragging,
    };
  },
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

const terminal: TerminalInstance = {
  id: "t1",
  title: "Terminal 1",
  cwd: "/test",
  cols: 80,
  rows: 24,
  worktreeId: "wt1",
  location: "grid",
  isVisible: true,
};

describe("SortableTerminal", () => {
  it("renders contain-layout and contain-style on the inner sortable div", () => {
    mockIsDragging = false;
    const { container } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div data-testid="child" />
      </SortableTerminal>
    );
    const outer = container.firstChild as HTMLElement;
    const inner = outer.firstChild as HTMLElement;
    expect(inner.className).toContain("contain-layout");
    expect(inner.className).toContain("contain-style");
    // Outer motion wrapper must NOT carry containment — it would scope the FLIP
    // measurement boundary and break getBoundingClientRect-based layout reads.
    expect(outer.className).not.toContain("contain-layout");
  });

  it("includes drag-state classes on the inner div alongside containment when dragging", () => {
    mockIsDragging = true;
    const { container } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div />
      </SortableTerminal>
    );
    const inner = (container.firstChild as HTMLElement).firstChild as HTMLElement;
    expect(inner.className).toContain("contain-layout");
    expect(inner.className).toContain("contain-style");
    expect(inner.className).toContain("opacity-40");
  });

  it("renders children through DragHandleProvider", () => {
    mockIsDragging = false;
    const { getByTestId } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div data-testid="inner-child" />
      </SortableTerminal>
    );
    expect(getByTestId("inner-child")).toBeTruthy();
  });

  it("sets data-terminal-id on the outer motion wrapper", () => {
    mockIsDragging = false;
    const { container } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div />
      </SortableTerminal>
    );
    const outer = container.firstChild as HTMLElement;
    expect(outer.getAttribute("data-terminal-id")).toBe("t1");
  });

  it("disables dnd-kit's built-in layout animation so framer-motion owns FLIP", () => {
    mockIsDragging = false;
    useSortableSpy.mockClear();
    render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div />
      </SortableTerminal>
    );
    expect(useSortableSpy).toHaveBeenCalled();
    const args = useSortableSpy.mock.calls[0]![0] as { animateLayoutChanges?: () => boolean };
    expect(typeof args.animateLayoutChanges).toBe("function");
    expect(args.animateLayoutChanges!()).toBe(false);
  });
});
