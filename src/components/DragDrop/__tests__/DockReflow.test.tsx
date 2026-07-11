// @vitest-environment jsdom
import type { HTMLAttributes, ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { PtyPanelData } from "@shared/types/panel";

/**
 * Regression coverage for #11063. Dropping a chip into the dock must land it in
 * its slot the way the macOS dock does — no sibling shuffle. The reflow came
 * from framer-motion's FLIP, which a motion node opts into via the raw
 * `layout`/`layoutId` predicate: truthy either one and framer measures and
 * animates the node between layouts. jsdom can't observe painted frames, so
 * these assert that opt-in predicate across every motion node the dock renders,
 * in both the idle and dragging states.
 *
 * Asserting the predicate rather than the literal prop is deliberate: dropping
 * `layout` entirely is behaviorally identical and stays green, while any truthy
 * `layout`/`layoutId` — on either wrapper, in either state — fails.
 */

/** Framer's own layout union; anything truthy here opts the node into FLIP. */
type MotionLayout = boolean | "position" | "size" | "preserve-aspect" | "x" | "y" | undefined;

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
}

const motionRecords: MotionRecord[] = [];

vi.mock("framer-motion", () => ({
  m: {
    div: ({ layout, layoutId, animate, transition, children, ...rest }: MotionDivProps) => {
      motionRecords.push({ layout, layoutId, animate, transition });
      return <div {...rest}>{children}</div>;
    },
  },
}));

/** The element dnd-kit puts its drag transform on — must stay a separate node. */
let transformNode: HTMLElement | null = null;
let mockIsDragging = false;

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button", tabIndex: 0, "aria-describedby": "dnd-describedby" },
    listeners: { onPointerDown: vi.fn() },
    setNodeRef: (el: HTMLElement | null) => {
      if (el) transformNode = el;
    },
    setActivatorNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: mockIsDragging,
    isOver: false,
    active: null,
    over: null,
  }),
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

/** Framer opts a node into FLIP iff `layout` or `layoutId` is truthy. */
function projectsLayout(record: MotionRecord): boolean {
  return Boolean(record.layout) || Boolean(record.layoutId);
}

/**
 * No motion node the dock rendered may opt into FLIP. Checking every record —
 * rather than the one wrapper the issue named — is what catches reflow coming
 * back on a different node, or only in one drag state.
 */
function expectNothingProjectsLayout() {
  expect(motionRecords.length).toBeGreaterThan(0);
  expect(motionRecords.filter(projectsLayout)).toEqual([]);
}

function renderDockItem() {
  return render(
    <SortableDockItem terminal={terminal} sourceIndex={0}>
      <div data-testid="chip" />
    </SortableDockItem>
  );
}

/** The inner wrapper that fades the dragged chip — a separate animation. */
function fadeWrapper(): MotionRecord {
  const fade = motionRecords.find((r) => r.animate !== undefined);
  expect(fade).toBeDefined();
  return fade!;
}

beforeEach(() => {
  motionRecords.length = 0;
  transformNode = null;
  mockIsDragging = false;
});

describe("dock chips snap into place on drop (#11063)", () => {
  it("opts no chip motion node into FLIP while idle", () => {
    renderDockItem();
    expectNothingProjectsLayout();
  });

  it("opts no chip motion node into FLIP while dragging", () => {
    mockIsDragging = true;
    renderDockItem();
    expectNothingProjectsLayout();
  });

  it("still fades the dragged chip, and animates that fade", () => {
    renderDockItem();
    const idleOpacity = fadeWrapper().animate?.opacity;

    motionRecords.length = 0;
    mockIsDragging = true;
    renderDockItem();
    const dragging = fadeWrapper();

    // Relational, not a copy of DRAG_GHOST_OPACITY: the dragged chip must be
    // more transparent than an idle one and get there over time rather than
    // snapping. This fade is the one dock animation #11063 preserves, so it has
    // to survive turning FLIP off.
    expect(dragging.animate?.opacity).toBeLessThan(idleOpacity!);
    expect(dragging.transition?.duration).toBeGreaterThan(0);
  });

  it("keeps the ARIA wrapper wrapped around — not merged into — the transform node", () => {
    // With FLIP off the outer wrapper looks inert, and the tempting follow-up is
    // to delete it. It still forwards dnd-kit's attributes, and collapsing it
    // into the transform node would put framer's and dnd-kit's transforms on one
    // element — the exact pairing #9029 separated.
    const { container } = renderDockItem();

    const ariaWrapper = container.querySelector("[aria-roledescription='sortable item']");
    expect(ariaWrapper).not.toBeNull();
    expect(ariaWrapper?.getAttribute("aria-describedby")).toBe("dnd-describedby");

    expect(transformNode).not.toBeNull();
    expect(ariaWrapper).not.toBe(transformNode);
    expect(ariaWrapper?.contains(transformNode)).toBe(true);
  });
});

describe("empty-dock placeholder snaps too (#11063)", () => {
  it("opts no placeholder motion node into FLIP", () => {
    render(<SortableDockPlaceholder />);
    expectNothingProjectsLayout();
  });

  it("keeps the sortable drop target mounted inside the motion wrapper", () => {
    // Positive control: without it, the negative assertion above would also pass
    // on a placeholder that rendered nothing at all.
    const { container } = render(<SortableDockPlaceholder />);
    const dropTarget = container.querySelector("[data-placeholder-id]");
    expect(dropTarget).not.toBeNull();
    expect(dropTarget).toBe(transformNode);

    // Same split as the chip: the motion wrapper stays wrapped around the
    // sortable node rather than being merged into it.
    const motionWrapper = container.firstChild;
    expect(motionWrapper).not.toBe(dropTarget);
    expect(motionWrapper?.contains(dropTarget)).toBe(true);
  });
});
