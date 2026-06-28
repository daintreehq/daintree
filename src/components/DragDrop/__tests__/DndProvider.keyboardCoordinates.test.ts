// @vitest-environment jsdom
// Regression test for sameContainerKeyboardCoordinates (#10713). The grid panels
// and dock chips are sortables in one shared DndContext, so dnd-kit's stock
// sortableKeyboardCoordinates will resolve an arrow step onto a dock droppable
// when one is the closest candidate in the pressed direction — and handleDragEnd
// then ejects the grid panel into the dock (grid count 3 → 2). The scoped getter
// must keep keyboard reorder within the active item's own SortableContext.
//
// Behavioral, not tautological: we run the REAL stock resolver to prove the dock
// is reachable by default, then assert the scoped resolver refuses the same step.
import { afterEach, describe, expect, it } from "vitest";
import { KeyboardCode } from "@dnd-kit/core";
import type { ClientRect, KeyboardCoordinateGetter } from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { sameContainerKeyboardCoordinates } from "../DndProvider";

// Structural mock of the dnd-kit DroppableContainer surface the keyboard
// coordinate resolvers actually read (id/disabled/data.sortable/node/rect).
// `sortable` is optional so a test can strip it to exercise the no-containerId
// fallback path. Built as a plain interface to keep the mocks assertion-free.
interface MockDroppable {
  id: string;
  key: string;
  disabled: boolean;
  data: { current: { sortable?: { containerId: string; index: number; items: never[] } } };
  node: { current: HTMLElement };
  rect: { current: ClientRect };
}

function rect(left: number, top: number, width = 100, height = 100): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function makeDroppable(
  id: string,
  containerId: string,
  index: number,
  r: ClientRect
): MockDroppable {
  const node = document.createElement("div");
  document.body.appendChild(node);
  return {
    id,
    key: id,
    disabled: false,
    data: { current: { sortable: { containerId, index, items: [] } } },
    node: { current: node },
    rect: { current: r },
  };
}

type GetterArgs = Parameters<KeyboardCoordinateGetter>[1];

function makeContext(active: MockDroppable, droppables: MockDroppable[]): GetterArgs {
  // Object.assign infers the Map & { getEnabled } intersection without a cast;
  // sortableKeyboardCoordinates only reads getEnabled()/get() off this surface.
  const droppableContainers = Object.assign(
    new Map<string, MockDroppable>(droppables.map((d) => [d.id, d])),
    { getEnabled: () => droppables }
  );

  const droppableRects = new Map<string, ClientRect>(droppables.map((d) => [d.id, d.rect.current]));

  const context = {
    activatorEvent: null,
    active: {
      id: active.id,
      data: active.data,
      rect: { current: { initial: active.rect.current, translated: active.rect.current } },
    },
    activeNode: active.node.current,
    collisionRect: active.rect.current,
    collisions: null,
    draggableNodes: new Map(),
    draggingNode: active.node.current,
    draggingNodeRect: active.rect.current,
    droppableRects,
    droppableContainers,
    over: null,
    scrollableAncestors: [],
    scrollAdjustedTranslate: null,
  };

  // Single boundary cast into the dnd-kit getter arg shape — the mock provides
  // exactly the fields the resolvers touch, not the full SensorContext surface.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- test mock intentionally narrows to the resolver-read subset of SensorContext
  return {
    active: active.id,
    currentCoordinates: { x: 0, y: 0 },
    context,
  } as unknown as GetterArgs;
}

describe("sameContainerKeyboardCoordinates", () => {
  // makeDroppable appends nodes to document.body (getScrollableAncestors walks
  // the real DOM); clear them between tests to avoid cross-test bleed.
  afterEach(() => {
    document.body.innerHTML = "";
  });

  // Layout: active grid panel at the origin; its only grid sibling sits to the
  // LEFT (not a candidate for ArrowRight), while a dock chip sits to the RIGHT
  // at (200, 300). ArrowRight therefore has exactly one stock candidate — the
  // dock chip — and for a cross-container target dnd-kit returns its rect origin.
  const DOCK_CHIP_RECT_ORIGIN = { x: 200, y: 300 };
  function scenario() {
    const active = makeDroppable("g0", "grid-container", 0, rect(0, 0));
    const gridSibling = makeDroppable("g1", "grid-container", 1, rect(-200, 0));
    const dockChip = makeDroppable("d0", "dock-container", 0, rect(200, 300));
    return { active, droppables: [active, gridSibling, dockChip] };
  }

  function arrowRight(): KeyboardEvent {
    return new KeyboardEvent("keydown", { code: KeyboardCode.Right });
  }

  it("stock resolver WOULD step the grid panel onto the dock chip (the bug)", () => {
    const { active, droppables } = scenario();
    const result = sortableKeyboardCoordinates(arrowRight(), makeContext(active, droppables));
    // The dock chip is the closest droppable to the right, so the unscoped
    // resolver steps the grid panel onto the dock chip's rect origin — this is
    // the exact cross-container leak the scope fixes.
    expect(result).toEqual(DOCK_CHIP_RECT_ORIGIN);
  });

  it("scoped resolver refuses to step out of the grid container", () => {
    const { active, droppables } = scenario();
    const result = sameContainerKeyboardCoordinates(arrowRight(), makeContext(active, droppables));
    // With dock-container droppables filtered out there is no grid candidate to
    // the right, so the panel stays put rather than ejecting into the dock.
    expect(result).toBeUndefined();
  });

  it("still reorders within the active container (grid sibling to the right)", () => {
    const active = makeDroppable("g0", "grid-container", 0, rect(0, 0));
    const gridSibling = makeDroppable("g1", "grid-container", 1, rect(200, 0));
    const dockChip = makeDroppable("d0", "dock-container", 0, rect(400, 300));
    const result = sameContainerKeyboardCoordinates(
      arrowRight(),
      makeContext(active, [active, gridSibling, dockChip])
    );
    // A same-container neighbour to the right is a valid target, so the scoped
    // resolver still produces a move — scoping narrows candidates, not function.
    expect(result).toBeDefined();
  });

  it("falls back to the stock resolver for draggables outside a SortableContext", () => {
    const active = makeDroppable("free", "grid-container", 0, rect(0, 0));
    // Strip the sortable data so there is no containerId to scope on (the
    // optional `sortable` field makes this a plain assignment, no cast).
    active.data.current = {};
    const target = makeDroppable("t", "grid-container", 1, rect(200, 0));
    const stock = sortableKeyboardCoordinates(arrowRight(), makeContext(active, [active, target]));
    const scoped = sameContainerKeyboardCoordinates(
      arrowRight(),
      makeContext(active, [active, target])
    );
    expect(scoped).toEqual(stock);
  });
});
