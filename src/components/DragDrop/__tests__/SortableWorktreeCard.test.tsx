// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SortableWorktreeCard } from "../SortableWorktreeCard";

let mockIsDragging = false;

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "listitem" },
    listeners: undefined,
    setNodeRef: vi.fn(),
    setActivatorNodeRef: vi.fn(),
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

describe("SortableWorktreeCard", () => {
  it("isolates the card at idle so the flash overlay's blend mode anchors to the active background", () => {
    mockIsDragging = false;
    const { container } = render(
      <SortableWorktreeCard worktreeId="wt1" dragStartOrder={["wt1"]}>
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild;
    if (!(wrapper instanceof HTMLElement)) throw new Error("Expected wrapper to be an HTMLElement");
    expect(wrapper.style.isolation).toBe("isolate");
    expect(wrapper.style.contentVisibility).toBe("auto");
  });

  it("clears isolation during drag so dnd-kit transforms compose with the card root", () => {
    mockIsDragging = true;
    const { container } = render(
      <SortableWorktreeCard worktreeId="wt1" dragStartOrder={["wt1"]}>
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild;
    if (!(wrapper instanceof HTMLElement)) throw new Error("Expected wrapper to be an HTMLElement");
    expect(wrapper.style.isolation).toBe("auto");
    expect(wrapper.style.contentVisibility).toBe("");
  });
});
