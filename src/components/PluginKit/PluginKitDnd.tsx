import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type SyntheticEvent,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type DropAnimation,
  type KeyboardCoordinateGetter,
  type Modifier,
  type MouseSensorOptions,
  type TouchSensorOptions,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { ChevronsLeftRight, ChevronsRightLeft, GripVertical } from "lucide-react";
import type {
  PluginDragDropProviderProps,
  PluginDragEvent,
  PluginDragId,
  PluginKanbanColumn,
  PluginKanbanProps,
  PluginSortableListProps,
} from "@shared/types/plugin-sdk-react";
import { PLUGIN_STYLE_ROOT_ATTRIBUTE } from "@shared/types/plugin";
import { Button } from "@/components/ui/button";
import { DRAG_GRIP_CLASS, DRAG_GRIP_ICON_CLASS } from "@/components/ui/dragGripStyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { MOUSE_SENSOR_OPTIONS, TOUCH_SENSOR_OPTIONS } from "@/components/DragDrop/dragActivation";
import { DROP_INDICATOR_LINE, DROP_TARGET_FRAME } from "@/components/DragDrop/dropIndicator";
import { useShouldSkipMotion } from "@/hooks/useShouldSkipMotion";
import {
  DRAG_GHOST_OPACITY,
  EASE_SNAPPY,
  getUiAnimationDuration,
  UI_ANIMATION_DURATION,
} from "@/lib/animationUtils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import {
  content,
  field,
  fn,
  hasContent,
  node,
  nonEmpty,
  oneOf,
  pickRootProps,
  str,
  useKitOwnerAttributes,
} from "./kitProps";
import { useKitOverlayZClass } from "./kitScope";
import { isDragId, KitDragScopeContext } from "@/pluginUi/dnd";

// Kit drags run on the host's own @dnd-kit, in a DndContext per kit component,
// so a view's drag never reaches the panel grid's context and the host's never
// reaches the view's. They move with pointer events, never the system
// drag-and-drop, so no host drop target (an agent terminal taking a
// `daintree-context` payload, the tab strip) sees them either. None of the
// library's types cross the public contract.

type DragKey = PluginDragId;

/**
 * Runs a plugin callback. One that throws is reported and treated as having
 * returned `fallback`: a bad callback costs its own output, never the view.
 */
function attempt<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch (error) {
    globalThis.reportError?.(error);
    return fallback;
  }
}

/** React keys for drag ids, which keep `1` and `"1"` apart. */
function reactKey(key: DragKey): string {
  return `${typeof key}:${String(key)}`;
}

// A press that starts on a button, link or field inside a handle belongs to
// that control: a card's "Assign" button must not lift the card. So does one
// on an element the view made natively draggable, such as a grip that hands
// the card to an agent.
const NESTED_CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "[contenteditable='']",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='menuitem']",
  "[role='tab']",
].join(",");

function startsOnNestedControl(event: SyntheticEvent): boolean {
  const target = event.target;
  const handle = event.currentTarget;
  if (!(target instanceof Element) || !(handle instanceof Element)) return false;
  // A handle the view made natively draggable belongs to the system drag too.
  const native = target.closest("[draggable='true']");
  if (native !== null && (native === handle || handle.contains(native))) return true;
  const control = target.closest(NESTED_CONTROL_SELECTOR);
  return control !== null && control !== handle && handle.contains(control);
}

const PRIMARY_BUTTON = 0;

class KitMouseSensor extends MouseSensor {
  static activators: {
    eventName: "onMouseDown";
    handler: (event: ReactMouseEvent, options: MouseSensorOptions) => boolean;
  }[] = [
    {
      eventName: "onMouseDown",
      handler: (event, { onActivation }) => {
        if (event.nativeEvent.button !== PRIMARY_BUTTON || startsOnNestedControl(event))
          return false;
        onActivation?.({ event: event.nativeEvent });
        return true;
      },
    },
  ];
}

class KitTouchSensor extends TouchSensor {
  static activators: {
    eventName: "onTouchStart";
    handler: (event: ReactTouchEvent, options: TouchSensorOptions) => boolean;
  }[] = [
    {
      eventName: "onTouchStart",
      handler: (event, { onActivation }) => {
        if (event.nativeEvent.touches.length > 1 || startsOnNestedControl(event)) return false;
        onActivation?.({ event: event.nativeEvent });
        return true;
      },
    },
  ];
}

// Module-level so useSensor's [sensor, options] memo holds across renders.
const ARROWS = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

/**
 * Arrow keys jump the held item to the nearest drop target in that direction.
 * dnd-kit's sortable getter assumes the item is also a drop target, which a
 * `useDraggable` item is not.
 */
const toNearestTarget: KeyboardCoordinateGetter = (event, { context }) => {
  if (!ARROWS.includes(event.code)) return undefined;
  event.preventDefault();
  const { active, collisionRect, droppableRects, droppableContainers } = context;
  if (!active || !collisionRect) return undefined;
  const cx = collisionRect.left + collisionRect.width / 2;
  const cy = collisionRect.top + collisionRect.height / 2;
  let best: { x: number; y: number; distance: number } | null = null;
  for (const container of droppableContainers.getEnabled()) {
    if (container.id === active.id) continue;
    const rect = droppableRects.get(container.id);
    if (!rect) continue;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const ahead =
      event.code === "ArrowDown"
        ? y > cy + 1
        : event.code === "ArrowUp"
          ? y < cy - 1
          : event.code === "ArrowRight"
            ? x > cx + 1
            : x < cx - 1;
    if (!ahead) continue;
    const distance = Math.hypot(x - cx, y - cy);
    if (!best || distance < best.distance) best = { x, y, distance };
  }
  if (!best) return undefined;
  return { x: best.x - collisionRect.width / 2, y: best.y - collisionRect.height / 2 };
};

// Module-level so useSensor's [sensor, options] memo holds across renders.
const KEYBOARD_SENSOR_OPTIONS = { coordinateGetter: toNearestTarget };

// The pointer is what the user aims with, so the target under it wins; off
// every target, the nearest one keeps the drag somewhere sensible.
const pointerFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

// The provider's targets: under the pointer, or none, so a release over no
// target reports `overId: null`. The keyboard has no pointer and lands on the
// target it jumped to.
const pointerOrNearest: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

function useAutoScroll(axes: "y" | "xy") {
  // JS-driven scrolling ignores CSS reduced motion, so halve it here as the
  // host's DndProvider does.
  const skipMotion = useShouldSkipMotion();
  return useMemo(
    () => ({
      threshold: { x: axes === "xy" ? 0.1 : 0, y: 0.1 },
      acceleration: skipMotion ? 5 : 10,
    }),
    [axes, skipMotion]
  );
}

function useDropAnimation(): DropAnimation {
  // Reduced motion lands the lifted copy at once rather than dropping it: a
  // zero duration, not `null`, so dnd-kit still scrolls a moved item back
  // into view.
  const skipMotion = useShouldSkipMotion();
  return {
    duration: skipMotion ? 0 : getUiAnimationDuration(),
    easing: EASE_SNAPPY,
    sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0" } } }),
  };
}

/** Keeps the lifted copy inside the element `find` returns, so a drag never appears to leave the view. */
function clampToBoundary(find: () => HTMLElement | null): Modifier {
  return ({ transform, draggingNodeRect }) => {
    const element = find();
    if (!element || !draggingNodeRect) return transform;
    const box = element.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return transform;
    const clamp = (start: number, size: number, offset: number, low: number, high: number) => {
      if (size >= high - low) return low - start;
      return Math.min(Math.max(offset, low - start), high - size - start);
    };
    return {
      ...transform,
      x: clamp(draggingNodeRect.left, draggingNodeRect.width, transform.x, box.left, box.right),
      y: clamp(draggingNodeRect.top, draggingNodeRect.height, transform.y, box.top, box.bottom),
    };
  };
}

const BOUNDARY_ATTRIBUTE = "data-kit-dnd-boundary";

/** The element marked with `id`, looked up when the drag moves rather than held from render. */
function boundaryElement(id: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(`[${BOUNDARY_ATTRIBUTE}]`)) {
    if (element.getAttribute(BOUNDARY_ATTRIBUTE) === id) return element;
  }
  return null;
}

// The lift's slight scale, as a keyframe: the copy mounts already lifted, so a
// transition would never run. Skipped outright under reduced motion.
const LIFT_SCALE = 1.02;

function liftOnMount(element: HTMLElement | null, skipMotion: boolean) {
  if (!element) return;
  if (skipMotion || typeof element.animate !== "function") {
    element.style.scale = String(LIFT_SCALE);
    return;
  }
  element.animate([{ scale: "1" }, { scale: String(LIFT_SCALE) }], {
    duration: UI_ANIMATION_DURATION,
    easing: EASE_SNAPPY,
    fill: "forwards",
  });
}

/**
 * The lifted copy under the pointer. Portalled to the body because the panel a
 * view renders in is a containing block for fixed elements (`contain:
 * content`), which would offset the copy from the pointer; re-marked as the
 * view's style root so its classes still apply.
 */
function KitDragOverlay({ children, modifiers }: { children: ReactNode; modifiers: Modifier[] }) {
  const owner = useKitOwnerAttributes();
  const skipMotion = useShouldSkipMotion();
  const dropAnimation = useDropAnimation();
  if (typeof document === "undefined") return null;
  return createPortal(
    <DragOverlay modifiers={modifiers} dropAnimation={dropAnimation}>
      {hasContent(children) ? (
        <div
          {...{ [PLUGIN_STYLE_ROOT_ATTRIBUTE]: "" }}
          {...owner}
          data-kit-drag-overlay=""
          ref={(element) => liftOnMount(element, skipMotion)}
          className="h-full w-full cursor-grabbing"
        >
          {children}
        </div>
      ) : null}
    </DragOverlay>,
    document.body
  );
}

// dnd-kit's own live region stays silent under the reorder components: they
// speak through their own, which knows positions and column names.
const SILENT_ANNOUNCEMENTS: Announcements = {
  onDragStart: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};
const SILENT_ACCESSIBILITY = {
  announcements: SILENT_ANNOUNCEMENTS,
  screenReaderInstructions: { draggable: "" },
};

function LiveRegion({ message }: { message: string }) {
  return (
    <div className="sr-only" role="status" aria-live="assertive" aria-atomic="true">
      {message}
    </div>
  );
}

// The primitives.

const PROVIDER_INSTRUCTIONS =
  "Press Space to pick this up. While it is held, the arrow keys move it between drop targets, Space drops it and Escape cancels.";

function KitDragDropProvider({
  children,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDragCancel,
  renderOverlay,
  getLabel,
  className,
}: PluginDragDropProviderProps) {
  const [activeId, setActiveId] = useState<DragKey | null>(null);
  const sensors = useSensors(
    useSensor(KitMouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(KitTouchSensor, TOUCH_SENSOR_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS)
  );
  const autoScroll = useAutoScroll("xy");
  const boundaryId = useId();
  const hasBox = Boolean(str(className));
  const labelOf = fn(getLabel);
  const overlay = fn(renderOverlay);
  const start = fn(onDragStart);
  const over = fn(onDragOver);
  const end = fn(onDragEnd);
  const cancel = fn(onDragCancel);

  const describe = (id: UniqueIdentifier): string => {
    const label = labelOf ? str(attempt(() => labelOf(id), undefined)) : undefined;
    return label && label.trim() !== "" ? label : String(id);
  };
  const accessibility = {
    announcements: {
      onDragStart: ({ active }) => `Picked up ${describe(active.id)}.`,
      onDragOver: ({ active, over: target }) =>
        target
          ? `${describe(active.id)} is over ${describe(target.id)}.`
          : `${describe(active.id)} is not over a drop target.`,
      onDragEnd: ({ active, over: target }) =>
        target
          ? `Dropped ${describe(active.id)} on ${describe(target.id)}.`
          : `${describe(active.id)} was dropped outside any target.`,
      onDragCancel: ({ active }) => `Cancelled. ${describe(active.id)} was put back.`,
    } satisfies Announcements,
    screenReaderInstructions: { draggable: PROVIDER_INSTRUCTIONS },
  };

  const eventOf = (event: DragStartEvent | DragOverEvent | DragEndEvent): PluginDragEvent => ({
    activeId: event.active.id,
    overId: "over" in event ? (event.over?.id ?? null) : null,
  });

  const hasOverlay = overlay !== undefined;
  const scope = useMemo(
    () => ({ placeholderStyle: hasOverlay ? { opacity: DRAG_GHOST_OPACITY } : null }),
    [hasOverlay]
  );
  // The view's own root is the boundary, so a drag stays inside the view it
  // started in.
  const modifiers = useMemo(
    () => [
      clampToBoundary(() => {
        const root = boundaryElement(boundaryId);
        return (
          root?.closest<HTMLElement>(`[${PLUGIN_STYLE_ROOT_ATTRIBUTE}]`) ?? (hasBox ? root : null)
        );
      }),
    ],
    [boundaryId, hasBox]
  );

  return (
    <div
      {...{ [BOUNDARY_ATTRIBUTE]: boundaryId }}
      data-no-dnd=""
      className={str(className)}
      style={hasBox ? undefined : { display: "contents" }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={pointerOrNearest}
        autoScroll={autoScroll}
        accessibility={accessibility}
        onDragStart={(event) => {
          setActiveId(event.active.id);
          if (start) attempt(() => start(eventOf(event)), undefined);
        }}
        onDragOver={(event) => {
          if (over) attempt(() => over(eventOf(event)), undefined);
        }}
        onDragEnd={(event) => {
          setActiveId(null);
          if (end) attempt(() => end(eventOf(event)), undefined);
        }}
        onDragCancel={(event) => {
          setActiveId(null);
          if (cancel) attempt(() => cancel({ activeId: event.active.id, overId: null }), undefined);
        }}
      >
        <KitDragScopeContext.Provider value={scope}>{children}</KitDragScopeContext.Provider>
        {overlay ? (
          <KitDragOverlay modifiers={modifiers}>
            {activeId !== null ? (
              <div className={cn("h-full w-full rounded-[var(--radius-md)]", LIFTED_SURFACE)}>
                {node(attempt(() => overlay(activeId), null))}
              </div>
            ) : null}
          </KitDragOverlay>
        ) : null}
      </DndContext>
    </div>
  );
}

// The reorder engine behind SortableList and Kanban. A lane is a list of item
// keys (a column, or the list itself). Pointer drags go through dnd-kit for
// pickup, the lifted copy and auto-scroll, and land where the pointer is
// against the lane's item midpoints; keyboard drags are the kit's own, a step
// per key, so a screen-reader user hears exact positions.

interface Lane {
  id: string;
  keys: DragKey[];
  /** The axis the lane's items run along. */
  axis: "x" | "y";
  /** A folded Kanban column: it takes drops at its end and is skipped by keyboard moves. */
  folded: boolean;
  /** Spoken after a position ("in Review"). */
  name?: string;
}

interface Spot {
  lane: string;
  index: number;
}

interface Held {
  key: DragKey;
  /** Read at pickup, so the drag can still name an item that has since gone. */
  label: string;
  mode: "pointer" | "keyboard";
  from: Spot;
  to: Spot;
}

interface EngineOptions {
  lanes: Lane[];
  /** How lanes sit relative to each other: Kanban columns run along `x`. */
  laneAxis: "x" | "y";
  isDisabled(key: DragKey): boolean;
  labelOf(key: DragKey): string;
  onCommit(held: Held): void;
  /** Items draw a grip, which a disabled item leaves out: it has no stop to focus. */
  handleMode: boolean;
}

function spotOf(lanes: Lane[], key: DragKey): Spot | null {
  for (const lane of lanes) {
    const index = lane.keys.indexOf(key);
    if (index >= 0) return { lane: lane.id, index };
  }
  return null;
}

function sameSpot(a: Spot, b: Spot): boolean {
  return a.lane === b.lane && a.index === b.index;
}

function distanceToRect(x: number, y: number, rect: DOMRect): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  return Math.hypot(dx, dy);
}

function pointOf(event: Event | null): { x: number; y: number } | null {
  if (!event) return null;
  if (typeof TouchEvent !== "undefined" && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }
  if (event instanceof MouseEvent) return { x: event.clientX, y: event.clientY };
  return null;
}

/**
 * `held` against the lanes as they are now: the item's current spot, and its
 * target kept inside a lane that still exists (and, for a keyboard move, is
 * not folded). Null once the item is gone. The same object when nothing moved.
 */
function reconcile(held: Held | null, lanes: Lane[]): Held | null {
  if (!held) return null;
  const from = spotOf(lanes, held.key);
  if (!from) return null;
  const toLane = lanes.find(
    (lane) => lane.id === held.to.lane && !(held.mode === "keyboard" && lane.folded)
  );
  const room = toLane ? toLane.keys.filter((k) => k !== held.key).length : 0;
  const to = toLane ? { lane: toLane.id, index: Math.min(held.to.index, room) } : from;
  return sameSpot(from, held.from) && sameSpot(to, held.to) ? held : { ...held, from, to };
}

function useReorderEngine({
  lanes,
  laneAxis,
  isDisabled,
  labelOf,
  onCommit,
  handleMode,
}: EngineOptions) {
  const [held, setHeld] = useState<Held | null>(null);
  const [message, setMessage] = useState("");
  const [tabStop, setTabStop] = useState<DragKey | null>(null);
  const heldRef = useRef<Held | null>(null);
  const lanesRef = useRef(lanes);
  const itemEls = useRef(new Map<DragKey, HTMLElement>());
  const handleEls = useRef(new Map<DragKey, HTMLElement>());
  const laneEls = useRef(new Map<string, HTMLElement>());
  const pointRef = useRef<{ x: number; y: number } | null>(null);
  const refocusRef = useRef<DragKey | null>(null);

  // Items and cards can change under a drag. The drag follows its item to
  // wherever it now sits, and ends if the item is gone, so a drop never
  // commits indices from before the change.
  const liveHeld = reconcile(held, lanes);
  useLayoutEffect(() => {
    lanesRef.current = lanes;
    const current = heldRef.current;
    const next = reconcile(current, lanes);
    if (!current || next === current) return;
    heldRef.current = next;
    setHeld(next);
    if (!next) setMessage(`${current.label} was removed. The drag was cancelled.`);
  }, [lanes]);

  const update = (next: Held | null) => {
    heldRef.current = next;
    setHeld(next);
  };

  const laneById = (id: string) => lanesRef.current.find((lane) => lane.id === id);

  const describeSpot = (key: DragKey, spot: Spot): string => {
    const lane = laneById(spot.lane);
    const others = lane ? lane.keys.filter((k) => k !== key).length : 0;
    const where = lane?.name ? ` in ${lane.name}` : "";
    return `position ${spot.index + 1} of ${others + 1}${where}`;
  };

  const lift = (key: DragKey, mode: Held["mode"]) => {
    const from = spotOf(lanesRef.current, key);
    if (!from) return;
    const label = labelOf(key);
    update({ key, label, mode, from, to: from });
    if (mode === "keyboard") refocusRef.current = key;
    const hint =
      mode === "keyboard"
        ? laneAxis === "x"
          ? " Up and Down move it, Left and Right move it to another column, Space drops it, Escape cancels."
          : " The arrow keys move it, Space drops it, Escape cancels."
        : "";
    setMessage(`Picked up ${label}, ${describeSpot(key, from)}.${hint}`);
  };

  /** `restoreFocus` is false when the drag ends because focus went somewhere else. */
  const finish = (commit: boolean, restoreFocus = true) => {
    const current = heldRef.current;
    if (!current) return;
    update(null);
    if (current.mode === "keyboard" && restoreFocus) refocusRef.current = current.key;
    const label = current.label;
    if (commit && !sameSpot(current.from, current.to)) {
      setMessage(`Dropped ${label}, ${describeSpot(current.key, current.to)}.`);
      onCommit(current);
    } else if (commit) {
      setMessage(`Dropped ${label}. It stayed at ${describeSpot(current.key, current.from)}.`);
    } else {
      setMessage(`Cancelled. ${label} is back at ${describeSpot(current.key, current.from)}.`);
    }
  };

  const moveTo = (to: Spot) => {
    const current = heldRef.current;
    if (!current || sameSpot(current.to, to)) return;
    update({ ...current, to });
    if (current.mode === "keyboard") {
      refocusRef.current = current.key;
      setMessage(`${current.label}, ${describeSpot(current.key, to)}.`);
    }
  };

  const pointerTarget = (x: number, y: number, key: DragKey): Spot | null => {
    let best: { lane: Lane; distance: number } | null = null;
    for (const lane of lanesRef.current) {
      const element = laneEls.current.get(lane.id);
      if (!element) continue;
      const distance = distanceToRect(x, y, element.getBoundingClientRect());
      if (!best || distance < best.distance) best = { lane, distance };
    }
    if (!best) return null;
    const others = best.lane.keys.filter((k) => k !== key);
    if (best.lane.folded) return { lane: best.lane.id, index: others.length };
    const along = best.lane.axis === "y" ? y : x;
    let index = 0;
    for (const other of others) {
      const rect = itemEls.current.get(other)?.getBoundingClientRect();
      if (!rect) continue;
      const middle =
        best.lane.axis === "y" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
      if (middle < along) index += 1;
    }
    return { lane: best.lane.id, index };
  };

  const retarget = () => {
    const current = heldRef.current;
    const point = pointRef.current;
    if (!current || current.mode !== "pointer" || !point) return;
    const to = pointerTarget(point.x, point.y, current.key);
    if (to) moveTo(to);
  };

  // Track the pointer itself while a pointer drag is held: dnd-kit's deltas
  // fold in scroll adjustments, and auto-scroll moves items under a still
  // pointer, which only a scroll listener hears.
  const retargetRef = useRef(retarget);
  useLayoutEffect(() => {
    retargetRef.current = retarget;
  });
  const pointerHeld = liveHeld?.mode === "pointer";
  useEffect(() => {
    if (!pointerHeld) return;
    const onMove = (event: Event) => {
      const point = pointOf(event);
      if (!point) return;
      pointRef.current = point;
      retargetRef.current();
    };
    const onScroll = () => retargetRef.current();
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [pointerHeld]);

  // A keyboard move re-renders the item somewhere else, which blurs it; put
  // focus back and keep it in view. Only after a move or an explicit drop or
  // cancel, never on any other render: a user who clicked away keeps focus
  // where they clicked.
  useLayoutEffect(() => {
    const key = refocusRef.current;
    refocusRef.current = null;
    if (key === null) return;
    const handle = handleEls.current.get(key);
    if (!handle) return;
    if (document.activeElement !== handle) handle.focus({ preventScroll: true });
    handle.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  });

  const dndHandlers = {
    onDragStart: (event: DragStartEvent) => {
      pointRef.current = pointOf(event.activatorEvent);
      lift(event.active.id, "pointer");
    },
    onDragEnd: () => {
      if (heldRef.current?.mode === "pointer") finish(true);
    },
    onDragCancel: () => {
      if (heldRef.current?.mode === "pointer") finish(false);
    },
  };

  const neighbourLane = (
    from: string,
    step: 1 | -1,
    skip: (lane: Lane) => boolean
  ): Lane | null => {
    const all = lanesRef.current;
    let at = all.findIndex((lane) => lane.id === from) + step;
    while (at >= 0 && at < all.length) {
      const lane = all[at];
      if (lane && !skip(lane)) return lane;
      at += step;
    }
    return null;
  };

  const onHandleKeyDown = (key: DragKey, event: KeyboardEvent<HTMLElement>) => {
    const current = heldRef.current;
    const lanesNow = lanesRef.current;
    const spot = spotOf(lanesNow, key);
    if (!spot) return;
    const lane = laneById(spot.lane);
    if (!lane) return;
    const alongPrev = lane.axis === "y" ? "ArrowUp" : "ArrowLeft";
    const alongNext = lane.axis === "y" ? "ArrowDown" : "ArrowRight";
    const acrossPrev = laneAxis === "x" ? "ArrowLeft" : "ArrowUp";
    const acrossNext = laneAxis === "x" ? "ArrowRight" : "ArrowDown";
    const multiLane = lanesNow.length > 1 && lane.axis !== laneAxis;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (current && current.mode === "keyboard" && current.key === key) {
      const toLane = laneById(current.to.lane);
      const room = toLane ? toLane.keys.filter((k) => k !== key).length : 0;
      if (event.key === " " || event.key === "Enter") {
        handled();
        finish(true);
      } else if (event.key === "Escape") {
        handled();
        finish(false);
      } else if (event.key === alongPrev || event.key === alongNext) {
        handled();
        const index = current.to.index + (event.key === alongNext ? 1 : -1);
        moveTo({ lane: current.to.lane, index: Math.min(Math.max(index, 0), room) });
      } else if (event.key === "Home" || event.key === "End") {
        handled();
        moveTo({ lane: current.to.lane, index: event.key === "Home" ? 0 : room });
      } else if (multiLane && (event.key === acrossPrev || event.key === acrossNext)) {
        handled();
        const next = neighbourLane(
          current.to.lane,
          event.key === acrossNext ? 1 : -1,
          (l) => l.folded
        );
        if (!next) return;
        const nextRoom = next.keys.filter((k) => k !== key).length;
        moveTo({ lane: next.id, index: Math.min(current.to.index, nextRoom) });
      } else if (event.key === "Tab") {
        finish(false);
      }
      return;
    }
    // Keys pressed in a control inside the item are that control's.
    if (current || event.target !== event.currentTarget) return;

    if (event.key === " " || event.key === "Enter") {
      handled();
      if (!isDisabled(key)) lift(key, "keyboard");
      return;
    }
    // A disabled item in `handle` mode draws no grip, so it has no stop to
    // land on; the walk passes over it.
    const focusable = (k: DragKey) => handleEls.current.has(k);
    const walk = (keys: DragKey[], from: number, step: 1 | -1) => {
      for (let at = from; at >= 0 && at < keys.length; at += step) {
        const k = keys[at];
        if (k !== undefined && focusable(k)) return k;
      }
      return undefined;
    };
    const focusKey = (target: DragKey | undefined) => {
      if (target === undefined) return;
      handled();
      setTabStop(target);
      handleEls.current.get(target)?.focus();
    };
    if (event.key === alongPrev) focusKey(walk(lane.keys, spot.index - 1, -1));
    else if (event.key === alongNext) focusKey(walk(lane.keys, spot.index + 1, 1));
    else if (event.key === "Home") focusKey(walk(lane.keys, 0, 1));
    else if (event.key === "End") focusKey(walk(lane.keys, lane.keys.length - 1, -1));
    else if (multiLane && (event.key === acrossPrev || event.key === acrossNext)) {
      const next = neighbourLane(
        spot.lane,
        event.key === acrossNext ? 1 : -1,
        (l) => l.folded || !l.keys.some(focusable)
      );
      if (next) {
        const at = Math.min(spot.index, next.keys.length - 1);
        focusKey(walk(next.keys, at, -1) ?? walk(next.keys, at, 1));
      }
    }
  };

  const onHandleBlur = (key: DragKey) => {
    // Moving a focused node blurs it; the layout effect has refocused it by
    // the time this runs, so only a real departure cancels the drag.
    window.setTimeout(() => {
      const current = heldRef.current;
      if (current?.mode !== "keyboard" || current.key !== key) return;
      if (document.activeElement !== handleEls.current.get(key)) finish(false, false);
    }, 0);
  };

  /** A lane's keys as drawn: a keyboard-held item is drawn at its target. */
  const displayKeys = (lane: Lane): DragKey[] => {
    if (!liveHeld || liveHeld.mode !== "keyboard") return lane.keys;
    const keys = lane.keys.filter((k) => k !== liveHeld.key);
    if (liveHeld.to.lane === lane.id) keys.splice(liveHeld.to.index, 0, liveHeld.key);
    return keys;
  };

  /** Where a pointer drop would land in this lane: the item the line sits against. */
  const indicatorFor = (
    lane: Lane
  ): { key: DragKey; edge: "before" | "after" } | "empty" | null => {
    if (!liveHeld || liveHeld.mode !== "pointer" || liveHeld.to.lane !== lane.id) return null;
    if (sameSpot(liveHeld.from, liveHeld.to)) return null;
    const others = lane.keys.filter((k) => k !== liveHeld.key);
    if (others.length === 0) return "empty";
    const before = others[liveHeld.to.index];
    if (before !== undefined) return { key: before, edge: "before" };
    const last = others[others.length - 1];
    return last === undefined ? "empty" : { key: last, edge: "after" };
  };

  // The tab stop is always an item with a handle to focus: not one in a
  // folded column, nor, in `handle` mode, a disabled one (it has no grip).
  const stops = lanes
    .filter((lane) => !lane.folded)
    .flatMap((lane) => lane.keys)
    .filter((key) => !handleMode || !isDisabled(key));
  const stop = tabStop !== null && stops.includes(tabStop) ? tabStop : (stops[0] ?? null);

  return {
    held: liveHeld,
    message,
    tabStop: stop,
    setTabStop,
    itemEls,
    handleEls,
    laneEls,
    dndHandlers,
    onHandleKeyDown,
    onHandleBlur,
    displayKeys,
    indicatorFor,
  };
}

type Engine = ReturnType<typeof useReorderEngine>;

const LIFTED_SURFACE =
  "border border-border-strong bg-surface-panel-elevated shadow-[var(--theme-shadow-floating)]";

// The grip's 24px box overhangs the row's padding rather than growing it.
const GRIP_OFFSET = "-my-1 -ml-1.5";

const HANDLE_FOCUS =
  "outline-hidden focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";

/** The 2px insertion line, centred in the gap before or after an item. */
function DropLine({ axis, edge, gap }: { axis: "x" | "y"; edge: "before" | "after"; gap: number }) {
  const offset = -(gap / 2) - 1;
  const style: CSSProperties =
    axis === "y"
      ? edge === "before"
        ? { top: offset }
        : { bottom: offset }
      : edge === "before"
        ? { left: offset }
        : { right: offset };
  return (
    <div
      aria-hidden="true"
      data-kit-drop-indicator={edge}
      style={style}
      className={cn(
        DROP_INDICATOR_LINE,
        axis === "y" ? "inset-x-1 h-0.5" : "inset-y-1 w-0.5",
        "rounded-full"
      )}
    />
  );
}

interface ItemShellProps {
  engine: Engine;
  itemKey: DragKey;
  label: string;
  disabled: boolean;
  handle: boolean;
  axis: "x" | "y";
  gap: number;
  indicator: "before" | "after" | null;
  /** The surface's own classes: a list row or a card. */
  surfaceClass: string;
  instructionsId: string;
  /** Names the grip with the item: "Reorder Alpha", "Move Fix login". */
  gripVerb: string;
  children: ReactNode;
}

function ItemShell({
  engine,
  itemKey,
  label,
  disabled,
  handle,
  axis,
  gap,
  indicator,
  surfaceClass,
  instructionsId,
  gripVerb,
  children,
}: ItemShellProps) {
  const skipMotion = useShouldSkipMotion();
  const held = engine.held;
  const isHeld = held?.key === itemKey;
  const keyboardLifted = isHeld && held.mode === "keyboard";
  const ghost = isHeld && held.mode === "pointer";
  const { setNodeRef, setActivatorNodeRef, listeners } = useDraggable({
    id: itemKey,
    disabled: disabled || (held !== null && held.mode === "keyboard"),
  });
  const handleProps = {
    ...listeners,
    ref: (element: HTMLElement | null) => {
      setActivatorNodeRef(element);
      if (element) engine.handleEls.current.set(itemKey, element);
      else engine.handleEls.current.delete(itemKey);
    },
    role: "button",
    tabIndex: engine.tabStop === itemKey ? 0 : -1,
    "aria-roledescription": handle ? "drag handle" : "sortable item",
    "aria-describedby": instructionsId,
    "aria-pressed": isHeld,
    "aria-disabled": disabled || undefined,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => engine.onHandleKeyDown(itemKey, event),
    onFocus: () => engine.setTabStop(itemKey),
    onBlur: () => engine.onHandleBlur(itemKey),
  };

  return (
    <div
      ref={(element) => {
        setNodeRef(element);
        if (element) engine.itemEls.current.set(itemKey, element);
        else engine.itemEls.current.delete(itemKey);
      }}
      role="listitem"
      data-kit-sortable-item={String(itemKey)}
      data-state={isHeld ? (keyboardLifted ? "lifted" : "placeholder") : undefined}
      className="relative"
      // Images and links drag natively by default; inside a kit item only an
      // element the view marked draggable may start a system drag.
      onDragStart={(event) => {
        const target = event.target;
        if (!(target instanceof Element) || target.closest("[draggable='true']") === null) {
          event.preventDefault();
        }
      }}
    >
      {indicator === "before" ? <DropLine axis={axis} edge="before" gap={gap} /> : null}
      <div
        {...(handle ? {} : handleProps)}
        style={ghost ? { opacity: DRAG_GHOST_OPACITY } : undefined}
        className={cn(
          surfaceClass,
          !handle && HANDLE_FOCUS,
          !handle && !disabled && "cursor-grab",
          keyboardLifted && [LIFTED_SURFACE, "z-10 scale-[1.02]"],
          !skipMotion && "transition-[scale] duration-150 ease-out"
        )}
      >
        {handle && !disabled ? (
          <span
            {...handleProps}
            aria-label={`${gripVerb} ${label}`}
            className={cn(DRAG_GRIP_CLASS, GRIP_OFFSET)}
          >
            <GripVertical aria-hidden="true" className={DRAG_GRIP_ICON_CLASS} />
          </span>
        ) : handle ? (
          // A row that can't move keeps the grip's slot but not the grip, so
          // every row's content stays on one rail.
          <span aria-hidden="true" className={cn("h-6 w-6 shrink-0", GRIP_OFFSET)} />
        ) : null}
        {children}
      </div>
      {indicator === "after" ? <DropLine axis={axis} edge="after" gap={gap} /> : null}
    </div>
  );
}

function ownIdOf(item: unknown): DragKey | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const id = field(item, "id");
  return isDragId(id) ? id : undefined;
}

function defaultLabelOf(item: unknown, fallback: string): string {
  if (typeof item === "string" && item.trim() !== "") return item;
  if (typeof item === "object" && item !== null) {
    for (const key of ["title", "label", "name"]) {
      const value = nonEmpty(field(item, key));
      if (value && value.trim() !== "") return value;
    }
  }
  return fallback;
}

/**
 * A drag key per item: the author's id, or a positional key for a missing or
 * repeated one, so two items never share a drag identity.
 */
function keyFor(read: () => unknown, seen: Set<DragKey>, fallback: string): DragKey {
  let id: unknown;
  try {
    id = read();
  } catch {
    id = undefined;
  }
  let key: DragKey = fallback;
  if (isDragId(id) && !seen.has(id)) key = id;
  // A positional key an author id already took gets a suffix until it is free.
  else while (seen.has(key)) key = `${key}~`;
  seen.add(key);
  return key;
}

function safeLabel(read: (() => unknown) | undefined, fallback: string): string {
  if (!read) return fallback;
  try {
    const value = str(read());
    return value && value.trim() !== "" ? value : fallback;
  } catch {
    return fallback;
  }
}

function safeFlag(read: (() => unknown) | undefined): boolean {
  if (!read) return false;
  try {
    return read() === true;
  } catch {
    return false;
  }
}

function useInstructions(acrossLanes: boolean): { id: string; text: string } {
  const id = `${useId()}instructions`;
  return {
    id,
    text: acrossLanes
      ? "Press Space to pick up. While it is held, Up and Down move it within its column, Left and Right move it to another column, Space drops it and Escape cancels."
      : "Press Space to pick up. While it is held, the arrow keys move it, Space drops it and Escape cancels.",
  };
}

function usePointerSensors() {
  return useSensors(
    useSensor(KitMouseSensor, MOUSE_SENSOR_OPTIONS),
    useSensor(KitTouchSensor, TOUCH_SENSOR_OPTIONS)
  );
}

function registerIn<K>(map: Map<K, HTMLElement>, key: K, element: HTMLElement | null) {
  if (element) map.set(key, element);
  else map.delete(key);
}

const LIST_GAP_PX = 2;
const ROW_SURFACE =
  "relative flex min-w-0 items-center gap-2 rounded-[var(--radius-md)] border border-transparent px-2 py-1.5 text-sm text-text-primary hover:bg-overlay-subtle";

interface ListEntry<T> {
  item: T;
  index: number;
  key: DragKey;
}

function KitSortableList<T>(props: PluginSortableListProps<T>) {
  const {
    items: rawItems,
    getId,
    renderItem,
    onReorder,
    onChange,
    "aria-label": ariaLabel,
    orientation,
    handle,
    isItemDisabled,
    getItemLabel,
    className,
    ...rest
  } = props;
  // Array.from fills holes in a sparse array with `undefined` items.
  const items: readonly T[] = Array.isArray(rawItems) ? Array.from(rawItems) : [];
  const idOf = fn(getId);
  const render = fn(renderItem);
  const reorder = fn(onReorder);
  const change = fn(onChange);
  const disabledOf = fn(isItemDisabled);
  const labelOfItem = fn(getItemLabel);
  const axis = oneOf(orientation, ["vertical", "horizontal"] as const) === "horizontal" ? "x" : "y";
  const useHandle = handle === true;

  const seen = new Set<DragKey>();
  const entries: ListEntry<T>[] = items.map((item, index) => ({
    item,
    index,
    key: keyFor(() => (idOf ? idOf(item, index) : ownIdOf(item)), seen, `kit-item-${index}`),
  }));
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const labelOf = (key: DragKey) => {
    const entry = byKey.get(key);
    if (!entry) return String(key);
    const fallback = defaultLabelOf(entry.item, `Item ${entry.index + 1}`);
    return safeLabel(labelOfItem && (() => labelOfItem(entry.item, entry.index)), fallback);
  };
  const isDisabled = (key: DragKey) => {
    const entry = byKey.get(key);
    return entry ? safeFlag(disabledOf && (() => disabledOf(entry.item, entry.index))) : true;
  };
  const lane: Lane = { id: "list", keys: entries.map((entry) => entry.key), axis, folded: false };
  const engine = useReorderEngine({
    lanes: [lane],
    laneAxis: axis === "y" ? "x" : "y",
    isDisabled,
    labelOf,
    handleMode: useHandle,
    onCommit: ({ from, to }) => {
      // Each hears the move even if the other throws.
      if (reorder) attempt(() => reorder(from.index, to.index), undefined);
      if (change) {
        const next = [...items];
        next.splice(to.index, 0, ...next.splice(from.index, 1));
        attempt(() => change(next), undefined);
      }
    },
  });
  const instructions = useInstructions(false);
  const sensors = usePointerSensors();
  const autoScroll = useAutoScroll(axis === "y" ? "y" : "xy");

  const renderContent = (key: DragKey, overlay: boolean) => {
    const entry = byKey.get(key);
    if (!entry || !render) return null;
    return node(
      attempt(
        () =>
          render(entry.item, {
            index: entry.index,
            isDragging: engine.held?.key === key,
            isOverlay: overlay,
            disabled: isDisabled(key),
          }),
        null
      )
    );
  };

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={pointerFirst}
        autoScroll={autoScroll}
        accessibility={SILENT_ACCESSIBILITY}
        onDragStart={engine.dndHandlers.onDragStart}
        onDragEnd={engine.dndHandlers.onDragEnd}
        onDragCancel={engine.dndHandlers.onDragCancel}
      >
        <SortableListFrame
          engine={engine}
          lane={lane}
          rootProps={pickRootProps(rest)}
          ariaLabel={str(ariaLabel) ?? "Sortable list"}
          className={str(className)}
          handle={useHandle}
          instructionsId={instructions.id}
          labelOf={labelOf}
          isDisabled={isDisabled}
          renderContent={renderContent}
        />
      </DndContext>
      <p id={instructions.id} className="sr-only">
        {instructions.text}
      </p>
      <LiveRegion message={engine.message} />
    </>
  );
}

/** The list element itself: inside the DndContext, so its drop target registers there. */
function SortableListFrame({
  engine,
  lane,
  rootProps,
  ariaLabel,
  className,
  handle,
  instructionsId,
  labelOf,
  isDisabled,
  renderContent,
}: {
  engine: Engine;
  lane: Lane;
  rootProps: Record<string, string | number | boolean>;
  ariaLabel: string;
  className: string | undefined;
  handle: boolean;
  instructionsId: string;
  labelOf(key: DragKey): string;
  isDisabled(key: DragKey): boolean;
  renderContent(key: DragKey, overlay: boolean): ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: "kit-lane:list" });
  const boundaryId = useId();
  const modifiers = useMemo(
    () => [clampToBoundary(() => boundaryElement(boundaryId))],
    [boundaryId]
  );
  const indicator = engine.indicatorFor(lane);
  const held = engine.held;
  const axis = lane.axis;
  return (
    <div
      {...rootProps}
      ref={(element) => {
        setNodeRef(element);
        registerIn(engine.laneEls.current, lane.id, element);
      }}
      {...{ [BOUNDARY_ATTRIBUTE]: boundaryId }}
      role="list"
      aria-label={ariaLabel}
      data-no-dnd=""
      data-orientation={axis === "y" ? "vertical" : "horizontal"}
      className={cn("flex min-w-0 gap-0.5", axis === "y" ? "flex-col" : "flex-row", className)}
    >
      {engine.displayKeys(lane).map((key) => (
        <ItemShell
          key={reactKey(key)}
          engine={engine}
          itemKey={key}
          label={labelOf(key)}
          disabled={isDisabled(key)}
          handle={handle}
          axis={axis}
          gap={LIST_GAP_PX}
          indicator={
            typeof indicator === "object" && indicator?.key === key ? indicator.edge : null
          }
          surfaceClass={ROW_SURFACE}
          instructionsId={instructionsId}
          gripVerb="Reorder"
        >
          <div className="min-w-0 flex-1">{renderContent(key, false)}</div>
        </ItemShell>
      ))}
      <KitDragOverlay modifiers={modifiers}>
        {held?.mode === "pointer" ? (
          <div className={cn(ROW_SURFACE, "h-full w-full hover:bg-transparent", LIFTED_SURFACE)}>
            {handle ? <OverlayGrip /> : null}
            <div className="min-w-0 flex-1">{renderContent(held.key, true)}</div>
          </div>
        ) : null}
      </KitDragOverlay>
    </div>
  );
}

function OverlayGrip() {
  return (
    <span aria-hidden="true" className={cn(DRAG_GRIP_CLASS, GRIP_OFFSET, "cursor-grabbing")}>
      <GripVertical aria-hidden="true" className={DRAG_GRIP_ICON_CLASS} />
    </span>
  );
}

const CARD_GAP_PX = 6;
const COLUMN_WIDTH_DEFAULT = 272;
const COLUMN_WIDTH_MIN = 200;
const COLUMN_WIDTH_MAX = 480;
const CARD_SURFACE =
  "relative flex min-w-0 gap-2 rounded-[var(--radius-md)] border border-border-default bg-surface-panel px-3 py-2.5 text-left text-sm text-text-primary transition-[border-color] duration-150 ease-out hover:border-border-strong";

interface BoardCard<T> {
  card: T;
  column: string;
  index: number;
  key: DragKey;
}

interface BoardColumn<T> {
  column: PluginKanbanColumn;
  cards: BoardCard<T>[];
  lane: Lane;
}

function readColumnDefs(value: unknown): PluginKanbanColumn[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: PluginKanbanColumn[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = nonEmpty(field(entry, "id"));
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const limit = field(entry, "limit");
    out.push({
      id,
      title: nonEmpty(field(entry, "title")) ?? id,
      limit: typeof limit === "number" && Number.isInteger(limit) && limit >= 0 ? limit : undefined,
      empty: content(field(entry, "empty")),
    });
  }
  return out;
}

function cardsIn<T>(
  cards: Readonly<Record<string, readonly T[]>> | undefined,
  id: string
): readonly T[] {
  if (typeof cards !== "object" || cards === null || !Object.hasOwn(cards, id)) return [];
  const list = cards[id];
  return Array.isArray(list) ? Array.from(list) : [];
}

function readIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string");
}

function ColumnCount({ count, limit }: { count: number; limit: number | undefined }) {
  const over = limit !== undefined && count > limit;
  const Warning = SEVERITY_GLYPH.warning;
  return (
    <span
      data-kit-column-count=""
      data-over-limit={over ? "" : undefined}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-2xs tabular-nums",
        over ? "font-medium text-status-warning" : "text-text-secondary"
      )}
    >
      {over ? <Warning className="h-3 w-3" aria-hidden="true" /> : null}
      <span aria-hidden="true">{limit === undefined ? count : `${count}/${limit}`}</span>
      <span className="sr-only">
        {limit === undefined
          ? pluralize(count, "card")
          : `${pluralize(count, "card")} of a limit of ${limit}${over ? ", over the limit" : ""}`}
      </span>
    </span>
  );
}

function FoldButton({
  title,
  folded,
  onToggle,
}: {
  title: string;
  folded: boolean;
  onToggle(): void;
}) {
  const zClass = useKitOverlayZClass();
  const label = folded ? `Expand ${title}` : `Collapse ${title}`;
  const Glyph = folded ? ChevronsLeftRight : ChevronsRightLeft;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-expanded={!folded}
          onClick={onToggle}
        >
          <Glyph aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className={zClass}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function KanbanColumnFrame({
  engine,
  column,
  lane,
  width,
  collapsible,
  onToggleFold,
  actions,
  isOverTarget,
  empty,
  children,
}: {
  engine: Engine;
  column: PluginKanbanColumn;
  lane: Lane;
  width: number;
  collapsible: boolean;
  onToggleFold(): void;
  actions: ReactNode;
  isOverTarget: boolean;
  /** No card is drawn in it, counting a keyboard-held card moved in or out. */
  empty: boolean;
  children: ReactNode;
}) {
  const titleId = `${useId()}title`;
  const { setNodeRef } = useDroppable({ id: `kit-lane:${column.id}` });
  const register = (element: HTMLElement | null) => {
    setNodeRef(element);
    registerIn(engine.laneEls.current, column.id, element);
  };
  const count = lane.keys.length;

  if (lane.folded) {
    return (
      <section
        ref={register}
        aria-labelledby={titleId}
        data-kit-kanban-column={column.id}
        data-state="collapsed"
        className={cn(
          "flex w-10 shrink-0 flex-col items-center gap-2 rounded-[var(--radius-lg)] border border-border-subtle bg-surface-inset py-2",
          isOverTarget && DROP_TARGET_FRAME
        )}
      >
        <FoldButton title={column.title} folded onToggle={onToggleFold} />
        <h3
          id={titleId}
          className={cn(SECTION_LABEL_CLASS, "min-h-0 truncate [writing-mode:vertical-rl]")}
        >
          {column.title}
        </h3>
        <ColumnCount count={count} limit={column.limit} />
      </section>
    );
  }

  return (
    <section
      ref={register}
      aria-labelledby={titleId}
      data-kit-kanban-column={column.id}
      style={{ width }}
      className="flex min-h-0 shrink-0 flex-col rounded-[var(--radius-lg)] border border-border-subtle bg-surface-inset"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border-subtle pr-1.5 pl-3">
        <h3 id={titleId} className={cn(SECTION_LABEL_CLASS, "min-w-0 truncate")}>
          {column.title}
        </h3>
        <ColumnCount count={count} limit={column.limit} />
        <span className="flex-1" />
        {actions}
        {collapsible ? (
          <FoldButton title={column.title} folded={false} onToggle={onToggleFold} />
        ) : null}
      </header>
      <div
        role="list"
        aria-labelledby={titleId}
        className="relative flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5"
      >
        {!empty ? (
          children
        ) : (
          <div className="relative px-2 py-6 text-center text-xs text-text-secondary">
            {isOverTarget ? <DropLine axis="y" edge="before" gap={0} /> : null}
            {hasContent(column.empty) ? node(column.empty) : "No cards"}
          </div>
        )}
      </div>
    </section>
  );
}

function KitKanban<T>(props: PluginKanbanProps<T>) {
  const {
    columns: rawColumns,
    cards: rawCards,
    getCardId,
    renderCard,
    onMove,
    "aria-label": ariaLabel,
    handle,
    isCardDisabled,
    getCardLabel,
    columnActions,
    collapsible,
    collapsedColumns,
    defaultCollapsedColumns,
    onCollapsedColumnsChange,
    columnWidth,
    className,
    ...rest
  } = props;
  const idOf = fn(getCardId);
  const render = fn(renderCard);
  const move = fn(onMove);
  const disabledOf = fn(isCardDisabled);
  const labelOfCard = fn(getCardLabel);
  const actionsOf = fn(columnActions);
  const foldChange = fn(onCollapsedColumnsChange);
  const foldable = collapsible === true;
  const width =
    typeof columnWidth === "number" && Number.isFinite(columnWidth)
      ? Math.min(Math.max(columnWidth, COLUMN_WIDTH_MIN), COLUMN_WIDTH_MAX)
      : COLUMN_WIDTH_DEFAULT;
  const useHandle = handle === true;

  const [ownFolded, setOwnFolded] = useState<string[]>(
    () => readIdList(defaultCollapsedColumns) ?? []
  );
  const controlledFolded = readIdList(collapsedColumns);
  const folded = foldable ? (controlledFolded ?? ownFolded) : [];
  const toggleFold = (id: string) => {
    const next = folded.includes(id) ? folded.filter((f) => f !== id) : [...folded, id];
    if (controlledFolded === undefined) setOwnFolded(next);
    if (foldChange) attempt(() => foldChange(next), undefined);
  };

  const seen = new Set<DragKey>();
  const board: BoardColumn<T>[] = readColumnDefs(rawColumns).map((column) => {
    const cards = cardsIn(rawCards, column.id).map((card, index) => ({
      card,
      column: column.id,
      index,
      key: keyFor(
        () => (idOf ? idOf(card) : ownIdOf(card)),
        seen,
        `kit-card-${column.id}-${index}`
      ),
    }));
    const lane: Lane = {
      id: column.id,
      keys: cards.map((card) => card.key),
      axis: "y",
      folded: folded.includes(column.id),
      name: column.title,
    };
    return { column, cards, lane };
  });
  const byKey = new Map(
    board.flatMap(({ cards }) => cards.map((card) => [card.key, card] as const))
  );

  const labelOf = (key: DragKey) => {
    const found = byKey.get(key);
    if (!found) return String(key);
    const fallback = defaultLabelOf(found.card, `Card ${found.index + 1}`);
    return safeLabel(labelOfCard && (() => labelOfCard(found.card)), fallback);
  };
  const isDisabled = (key: DragKey) => {
    const found = byKey.get(key);
    return found ? safeFlag(disabledOf && (() => disabledOf(found.card))) : true;
  };

  const engine = useReorderEngine({
    lanes: board.map(({ lane }) => lane),
    laneAxis: "x",
    isDisabled,
    labelOf,
    handleMode: useHandle,
    onCommit: ({ key, from, to }) => {
      const report = {
        cardId: key,
        fromColumn: from.lane,
        toColumn: to.lane,
        fromIndex: from.index,
        index: to.index,
      };
      if (move) attempt(() => move(report), undefined);
    },
  });
  const instructions = useInstructions(true);
  const sensors = usePointerSensors();
  const autoScroll = useAutoScroll("xy");
  const boundaryId = useId();
  const modifiers = useMemo(
    () => [clampToBoundary(() => boundaryElement(boundaryId))],
    [boundaryId]
  );
  const held = engine.held;

  const renderContent = (key: DragKey, overlay: boolean) => {
    const found = byKey.get(key);
    if (!found || !render) return null;
    return node(
      attempt(
        () =>
          render(found.card, {
            columnId: found.column,
            index: found.index,
            isDragging: held?.key === key,
            isOverlay: overlay,
            disabled: isDisabled(key),
          }),
        null
      )
    );
  };

  return (
    <div
      {...pickRootProps(rest)}
      {...{ [BOUNDARY_ATTRIBUTE]: boundaryId }}
      role="group"
      aria-label={str(ariaLabel) ?? "Board"}
      data-no-dnd=""
      className={cn(
        "flex h-full min-h-0 min-w-0 items-stretch gap-3 overflow-x-auto",
        str(className)
      )}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={pointerFirst}
        autoScroll={autoScroll}
        accessibility={SILENT_ACCESSIBILITY}
        onDragStart={engine.dndHandlers.onDragStart}
        onDragEnd={engine.dndHandlers.onDragEnd}
        onDragCancel={engine.dndHandlers.onDragCancel}
      >
        {board.map(({ column, lane }) => {
          const indicator = engine.indicatorFor(lane);
          const shown = engine.displayKeys(lane);
          const isOverTarget =
            held?.mode === "pointer" &&
            held.to.lane === lane.id &&
            (lane.folded || indicator === "empty");
          return (
            <KanbanColumnFrame
              key={column.id}
              engine={engine}
              column={column}
              lane={lane}
              width={width}
              collapsible={foldable}
              onToggleFold={() => toggleFold(column.id)}
              actions={actionsOf ? node(attempt(() => actionsOf(column), null)) : null}
              isOverTarget={isOverTarget}
              empty={shown.length === 0}
            >
              {shown.map((key) => (
                <ItemShell
                  key={reactKey(key)}
                  engine={engine}
                  itemKey={key}
                  label={labelOf(key)}
                  disabled={isDisabled(key)}
                  handle={useHandle}
                  axis="y"
                  gap={CARD_GAP_PX}
                  indicator={
                    typeof indicator === "object" && indicator?.key === key ? indicator.edge : null
                  }
                  surfaceClass={CARD_SURFACE}
                  instructionsId={instructions.id}
                  gripVerb="Move"
                >
                  <div className="min-w-0 flex-1">{renderContent(key, false)}</div>
                </ItemShell>
              ))}
            </KanbanColumnFrame>
          );
        })}
        <KitDragOverlay modifiers={modifiers}>
          {held?.mode === "pointer" ? (
            <div className={cn(CARD_SURFACE, "h-full w-full", LIFTED_SURFACE)}>
              {useHandle ? <OverlayGrip /> : null}
              <div className="min-w-0 flex-1">{renderContent(held.key, true)}</div>
            </div>
          ) : null}
        </KitDragOverlay>
      </DndContext>
      <p id={instructions.id} className="sr-only">
        {instructions.text}
      </p>
      <LiveRegion message={engine.message} />
    </div>
  );
}

export const pluginKitDnd = {
  DragDropProvider: KitDragDropProvider,
  SortableList: KitSortableList,
  Kanban: KitKanban,
};
