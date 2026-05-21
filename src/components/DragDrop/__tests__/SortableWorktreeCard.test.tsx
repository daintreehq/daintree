// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { SortableWorktreeCard } from "../SortableWorktreeCard";

interface MockSortableState {
  isDragging?: boolean;
  isOver?: boolean;
  active?: {
    data: { current: { type?: string } };
    rect: { current: { translated: { top: number; height: number } | null } };
  } | null;
  over?: { rect: { top: number; height: number } } | null;
}

let mockState: MockSortableState = { isDragging: false };

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "listitem" },
    listeners: undefined,
    setNodeRef: vi.fn(),
    setActivatorNodeRef: vi.fn(),
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

describe("SortableWorktreeCard", () => {
  it("isolates the card at idle so the flash overlay's blend mode anchors to the active background", () => {
    mockState = { isDragging: false };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.isolation).toBe("isolate");
    // content-visibility:auto is intentionally NOT set on the card — Virtuoso
    // owns row windowing and content-visibility:auto would break dnd-kit
    // transforms on the dragged row (lesson #4438 + issue #8393).
    expect(wrapper.style.contentVisibility).toBe("");
  });

  it("clears isolation during drag so dnd-kit transforms compose with the card root", () => {
    mockState = { isDragging: true };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.style.isolation).toBe("auto");
    expect(wrapper.style.contentVisibility).toBe("");
  });

  it("keeps data-worktree-row and tabIndex on the inner div for roving focus compatibility", () => {
    mockState = { isDragging: false };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.getAttribute("data-worktree-row")).toBe("wt1");
    expect(wrapper.getAttribute("tabindex")).toBe("-1");
    expect(wrapper.getAttribute("role")).toBe("row");
  });

  it("applies opacity-40 to the inner gridcell wrapper while dragging", () => {
    mockState = { isDragging: true };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).not.toContain("opacity-40");
    const ghost = wrapper.querySelector("[role='gridcell'] > div") as HTMLElement;
    expect(ghost.className).toContain("opacity-40");
    expect(ghost.className).toContain("transition-opacity");
  });

  it("marks the outer wrapper relative so the drop indicator can position absolutely against it", () => {
    mockState = { isDragging: false };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain("relative");
  });

  it("advertises Alt+Arrow keyboard reorder via aria-keyshortcuts when sortable", () => {
    mockState = { isDragging: false };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
  });

  it("omits aria-keyshortcuts when the row is sort-disabled (pinned or grouped)", () => {
    mockState = { isDragging: false };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
        disabled
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("renders an above-edge insertion line when the dragged row midpoint is above the hovered row midpoint", () => {
    mockState = {
      isDragging: false,
      isOver: true,
      active: {
        data: { current: { type: "worktree-sort" } },
        rect: { current: { translated: { top: 10, height: 60 } } }, // midpoint 40
      },
      over: { rect: { top: 100, height: 60 } }, // midpoint 130 — 40 < 130 → above
    };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1", "wt2"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const indicator = container.querySelector("[data-worktree-drop-indicator]") as HTMLElement;
    expect(indicator).not.toBeNull();
    expect(indicator.getAttribute("data-worktree-drop-indicator")).toBe("above");
    expect(indicator.className).toContain("-top-px");
    expect(indicator.className).toContain("bg-border-strong");
  });

  it("renders a below-edge insertion line when the dragged row midpoint is below the hovered row midpoint", () => {
    mockState = {
      isDragging: false,
      isOver: true,
      active: {
        data: { current: { type: "worktree-sort" } },
        rect: { current: { translated: { top: 200, height: 60 } } }, // midpoint 230
      },
      over: { rect: { top: 100, height: 60 } }, // midpoint 130 — 230 > 130 → below
    };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1", "wt2"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    const indicator = container.querySelector("[data-worktree-drop-indicator]") as HTMLElement;
    expect(indicator).not.toBeNull();
    expect(indicator.getAttribute("data-worktree-drop-indicator")).toBe("below");
    expect(indicator.className).toContain("-bottom-px");
  });

  it("suppresses the insertion line for non-worktree-sort drags (terminal/browser drops)", () => {
    mockState = {
      isDragging: false,
      isOver: true,
      active: {
        data: { current: { type: "terminal-panel" } },
        rect: { current: { translated: { top: 10, height: 60 } } },
      },
      over: { rect: { top: 100, height: 60 } },
    };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    expect(container.querySelector("[data-worktree-drop-indicator]")).toBeNull();
  });

  it("suppresses the insertion line until dnd-kit measures the dragged rect", () => {
    mockState = {
      isDragging: false,
      isOver: true,
      active: {
        data: { current: { type: "worktree-sort" } },
        rect: { current: { translated: null } },
      },
      over: { rect: { top: 100, height: 60 } },
    };
    const { container } = render(
      <SortableWorktreeCard
        worktreeId="wt1"
        dragStartOrder={["wt1"]}
        ariaRowIndex={1}
        isActive={false}
      >
        {() => <div data-testid="child" />}
      </SortableWorktreeCard>
    );
    expect(container.querySelector("[data-worktree-drop-indicator]")).toBeNull();
  });
});
