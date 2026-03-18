// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SortableTerminal } from "../SortableTerminal";
import type { TerminalInstance } from "@/store";

let mockIsDragging = false;

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button" },
    listeners: undefined,
    setNodeRef: vi.fn(),
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

const terminal: TerminalInstance = {
  id: "t1",
  type: "terminal",
  title: "Terminal 1",
  cwd: "/test",
  cols: 80,
  rows: 24,
  worktreeId: "wt1",
  location: "grid",
  isVisible: true,
};

describe("SortableTerminal", () => {
  it("always renders contain-layout on the wrapper", () => {
    mockIsDragging = false;
    const { container } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div data-testid="child" />
      </SortableTerminal>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("contain-layout");
  });

  it("includes contain-layout alongside drag-state classes when dragging", () => {
    mockIsDragging = true;
    const { container } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div />
      </SortableTerminal>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("contain-layout");
    expect(wrapper.className).toContain("opacity-40");
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

  it("sets data-terminal-id on the wrapper", () => {
    mockIsDragging = false;
    const { container } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div />
      </SortableTerminal>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.getAttribute("data-terminal-id")).toBe("t1");
  });
});
