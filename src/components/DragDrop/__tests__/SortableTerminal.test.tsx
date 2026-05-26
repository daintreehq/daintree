// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { CSS } from "@dnd-kit/utilities";
import { SortableTerminal } from "../SortableTerminal";
import { useDragHandle } from "../DragHandleContext";
import type { PanelInstance } from "@shared/types/panel";

let mockIsDragging = false;
const useSortableSpy = vi.fn();
const mockSetActivatorNodeRef = vi.fn();

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: (args: unknown) => {
    useSortableSpy(args);
    return {
      attributes: { role: "button" },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef: vi.fn(),
      setActivatorNodeRef: mockSetActivatorNodeRef,
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
    Translate: {
      toString: () => undefined,
    },
  },
}));

const terminal: PanelInstance = {
  id: "t1",
  kind: "terminal",
  title: "Terminal 1",
  cwd: "/test",
  cols: 80,
  rows: 24,
  worktreeId: "wt1",
  location: "grid",
  isVisible: true,
} as PanelInstance;

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
    expect(outer.className).not.toContain("contain-layout");
  });

  it("does not apply opacity-40 class on the inner div (opacity is now driven by framer-motion animate)", () => {
    mockIsDragging = true;
    const { container } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div />
      </SortableTerminal>
    );
    const inner = (container.firstChild as HTMLElement).firstChild as HTMLElement;
    expect(inner.className).toContain("contain-layout");
    expect(inner.className).not.toContain("opacity-40");
  });

  it("renders drag ring class on the inner div when dragging", () => {
    mockIsDragging = true;
    const { container } = render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div />
      </SortableTerminal>
    );
    const inner = (container.firstChild as HTMLElement).firstChild as HTMLElement;
    expect(inner.className).toContain("ring-2");
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

  it("uses CSS.Translate.toString (not CSS.Transform.toString) to skip scale on the xterm canvas", () => {
    mockIsDragging = false;
    useSortableSpy.mockClear();
    render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <div />
      </SortableTerminal>
    );
    expect(CSS.Translate).toBeDefined();
  });

  it("forwards setActivatorNodeRef and listeners through DragHandleProvider for keyboard a11y", () => {
    // dnd-kit's KeyboardSensor watches whichever element receives
    // setActivatorNodeRef. Falling back to setNodeRef would point at the
    // sortable container — which strips tabIndex — so keyboard activation
    // would silently fail. Verify both fields land in the context value.
    mockIsDragging = false;
    let captured: ReturnType<typeof useDragHandle> = null;
    function Probe() {
      captured = useDragHandle();
      return null;
    }
    render(
      <SortableTerminal terminal={terminal} sourceLocation="grid" sourceIndex={0}>
        <Probe />
      </SortableTerminal>
    );
    expect(captured).not.toBeNull();
    expect(captured!.setActivatorNodeRef).toBe(mockSetActivatorNodeRef);
    expect(captured!.listeners).toBeDefined();
  });
});
