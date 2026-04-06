// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SortableGridPlaceholder } from "../GridPlaceholder";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button" },
    listeners: undefined,
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

vi.mock("../DndProvider", () => ({
  GRID_PLACEHOLDER_ID: "__grid-placeholder__",
  useDndPlaceholder: () => ({ activeTerminal: null }),
}));

describe("SortableGridPlaceholder", () => {
  it("renders contain-layout and contain-style on the wrapper", () => {
    const { container } = render(<SortableGridPlaceholder />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("contain-layout");
    expect(wrapper.className).toContain("contain-style");
  });

  it("sets data-placeholder-id on the wrapper", () => {
    const { container } = render(<SortableGridPlaceholder />);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.getAttribute("data-placeholder-id")).toBe("__grid-placeholder__");
  });
});
