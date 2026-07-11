// @vitest-environment jsdom
import type { HTMLAttributes, ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";

/**
 * Regression coverage for #11063. Dropping a chip into the dock must land it in
 * its slot the way the macOS dock does — no sibling shuffle. Two independent
 * engines can reflow the row, and both have to stay off: framer-motion's FLIP
 * (the `layout` prop on the wrapper) and dnd-kit's own sort transition
 * (`animateLayoutChanges`). jsdom can't observe animation, so these assert the
 * enablement contract each engine reads, not the frames it would paint.
 *
 * The assertions are deliberately written against framer's own predicate —
 * layout projection is enabled iff `layout` or `layoutId` is truthy — so
 * dropping the prop entirely (behaviorally identical) keeps them green, while
 * restoring `layout="position"` fails them.
 */

type MotionLayout = boolean | "position" | "size" | undefined;

interface MotionDivProps extends HTMLAttributes<HTMLDivElement> {
  layout?: MotionLayout;
  layoutId?: string;
  animate?: { opacity?: number };
  transition?: { duration?: number };
  children?: ReactNode;
}

interface MotionRecord {
  layout: MotionLayout;
  layoutId: string | undefined;
  animate: { opacity?: number } | undefined;
  transition: { duration?: number } | undefined;
  roleDescription: string | undefined;
}

const motionRecords: MotionRecord[] = [];

vi.mock("framer-motion", () => ({
  m: {
    div: ({ layout, layoutId, animate, transition, children, ...rest }: MotionDivProps) => {
      motionRecords.push({
        layout,
        layoutId,
        animate,
        transition,
        roleDescription: rest["aria-roledescription"],
      });
      return <div {...rest}>{children}</div>;
    },
  },
}));

interface SortableOptions {
  id: string;
  animateLayoutChanges?: () => boolean;
}

const sortableCalls: SortableOptions[] = [];
let mockIsDragging = false;

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: (options: SortableOptions) => {
    sortableCalls.push(options);
    return {
      attributes: { role: "button", tabIndex: 0, "aria-describedby": "dnd-describedby" },
      listeners: { onPointerDown: vi.fn() },
      setNodeRef: vi.fn(),
      setActivatorNodeRef: vi.fn(),
      transform: null,
      transition: undefined,
      isDragging: mockIsDragging,
      isOver: false,
      active: null,
      over: null,
    };
  },
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock("../DndProvider", () => ({
  useDndPlaceholder: () => ({ activeTerminal: null, isDragging: false }),
}));

vi.mock("@/utils/terminalChrome", () => ({
  deriveTerminalChrome: () => ({ agentId: null }),
}));

import { SortableDockItem } from "../SortableDockItem";
import { SortableDockPlaceholder } from "../DockPlaceholder";

const terminal: PtyPanelData = {
  id: "t1",
  kind: "terminal",
  title: "Dock Terminal",
  cwd: "/test",
  cols: 80,
  rows: 24,
  worktreeId: "wt1",
  location: "dock",
  isVisible: true,
};

/** Framer enables layout projection iff `layout` or `layoutId` is truthy. */
function projectsLayout(record: MotionRecord): boolean {
  return Boolean(record.layout) || Boolean(record.layoutId);
}

function renderDockItem() {
  return render(
    <SortableDockItem terminal={terminal} sourceIndex={0}>
      <div data-testid="chip" />
    </SortableDockItem>
  );
}

/** The wrapper that forwards dnd-kit's ARIA — the one that used to carry FLIP. */
function chipWrapper(): MotionRecord {
  const wrapper = motionRecords.find((r) => r.roleDescription === "sortable item");
  expect(wrapper).toBeDefined();
  return wrapper!;
}

/** The inner wrapper that fades the dragged chip — a separate animation. */
function fadeWrapper(): MotionRecord {
  const fade = motionRecords.find((r) => r.animate !== undefined);
  expect(fade).toBeDefined();
  return fade!;
}

beforeEach(() => {
  motionRecords.length = 0;
  sortableCalls.length = 0;
  mockIsDragging = false;
});

describe("dock chips snap into place on drop (#11063)", () => {
  it("leaves framer's layout projection off on the chip wrapper", () => {
    renderDockItem();
    expect(projectsLayout(chipWrapper())).toBe(false);
  });

  it("leaves dnd-kit's own reorder transition off on the chip", () => {
    renderDockItem();
    const options = sortableCalls.find((c) => c.id === terminal.id);
    expect(options?.animateLayoutChanges).toBeDefined();
    expect(options!.animateLayoutChanges!()).toBe(false);
  });

  it("keeps the wrapper — and the dnd-kit attributes it forwards — in the tree", () => {
    // Guards the tempting follow-up cleanup: with FLIP off the wrapper looks
    // inert, but it still carries dnd-kit's forwarded attributes, and keeping
    // it separate from the transform node is the #9029 contract.
    const { container } = renderDockItem();
    const wrapper = container.firstChild;
    expect(wrapper).toBeInstanceOf(HTMLElement);
    const el = container.querySelector("[aria-roledescription='sortable item']");
    expect(el).not.toBeNull();
    expect(el?.getAttribute("aria-describedby")).toBe("dnd-describedby");
    expect(el?.getAttribute("role")).toBeNull();
  });

  it("still fades the dragged chip, and animates that fade", () => {
    renderDockItem();
    const idleOpacity = fadeWrapper().animate?.opacity;

    motionRecords.length = 0;
    mockIsDragging = true;
    renderDockItem();
    const dragging = fadeWrapper();

    // Relational, not a copy of DRAG_GHOST_OPACITY: the dragged chip must be
    // more transparent than an idle one, and get there over time rather than
    // snapping — the fade is the one dock animation this issue preserves.
    expect(dragging.animate?.opacity).toBeLessThan(idleOpacity!);
    expect(dragging.transition?.duration).toBeGreaterThan(0);
    // ...and the fade must not have smuggled FLIP back in on its own wrapper.
    expect(projectsLayout(dragging)).toBe(false);
  });
});

describe("empty-dock placeholder snaps too (#11063)", () => {
  it("leaves framer's layout projection off on the placeholder wrapper", () => {
    render(<SortableDockPlaceholder />);
    expect(motionRecords).toHaveLength(1);
    expect(projectsLayout(motionRecords[0]!)).toBe(false);
  });

  it("leaves dnd-kit's own reorder transition off on the placeholder", () => {
    render(<SortableDockPlaceholder />);
    const options = sortableCalls[0];
    expect(options?.animateLayoutChanges).toBeDefined();
    expect(options!.animateLayoutChanges!()).toBe(false);
  });

  it("keeps the sortable drop target mounted inside the motion wrapper", () => {
    const { container } = render(<SortableDockPlaceholder />);
    expect(container.querySelector("[data-placeholder-id]")).not.toBeNull();
  });
});
