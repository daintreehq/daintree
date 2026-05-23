import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { m, type TransformProperties, type Transition } from "framer-motion";
import { cn } from "@/lib/utils";
import { UI_ANIMATION_DURATION, DRAG_GHOST_OPACITY, DRAG_GHOST_EASING } from "@/lib/animationUtils";
import type { TerminalInstance } from "@/store";
import type { DragData } from "./DndProvider";
import { DragHandleProvider } from "./DragHandleContext";

// Force integer-pixel translations on the FLIP wrapper. xterm canvas/WebGL
// renderers blur when their ancestor chain receives a fractional CSS transform
// (Chromium bug 40892376), so we snap mid-flight to the nearest device pixel.
export function pixelSnapTransform({ x, y }: TransformProperties): string {
  const tx = typeof x === "number" ? x : parseFloat(x ?? "0") || 0;
  const ty = typeof y === "number" ? y : parseFloat(y ?? "0") || 0;
  return `translate3d(${Math.round(tx)}px, ${Math.round(ty)}px, 0)`;
}

interface SortableTerminalProps {
  terminal: TerminalInstance;
  sourceLocation: "grid" | "dock";
  sourceIndex: number;
  children: React.ReactNode;
  disabled?: boolean;
  /** If this panel is part of a tab group, the group ID */
  groupId?: string;
  /** If this panel is part of a tab group, all panel IDs in the group */
  groupPanelIds?: string[];
  /** Shared layout transition for the FLIP animation. When omitted, framer-motion's default is used. */
  layoutTransition?: Transition;
  /** Disable FLIP on latency-critical paths such as optimistic close. */
  layoutEnabled?: boolean;
}

export function SortableTerminal({
  terminal,
  sourceLocation,
  sourceIndex,
  children,
  disabled = false,
  groupId,
  groupPanelIds,
  layoutTransition,
  layoutEnabled = true,
}: SortableTerminalProps) {
  const dragData: DragData = {
    terminal,
    sourceLocation,
    sourceIndex,
    groupId,
    groupPanelIds,
  };

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: terminal.id,
    data: dragData,
    disabled,
    // Disable dnd-kit's own layout animation. Framer-motion's `layout="position"`
    // owns FLIP for column-count changes; without this the two systems fight
    // over `style.transform` and produce visible jitter mid-drag.
    animateLayoutChanges: () => false,
  });

  const sortableStyle = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  // dnd-kit attaches role="button" + tabIndex={0} to the sortable container by
  // default, which conflicts with axe's nested-interactive rule because the
  // panel content hosts its own buttons, inputs, and xterm textarea. Strip
  // those props — actual drag initiation happens via drag handles passed
  // through DragHandleProvider, not via focusing the outer container.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  const destructured = attributes as unknown as Record<string, unknown>;
  const { role: _role, tabIndex: _tabIndex, ...remainingAttributes } = destructured;
  void _role;
  void _tabIndex;

  return (
    <m.div
      layout={layoutEnabled ? "position" : false}
      transition={layoutTransition}
      transformTemplate={pixelSnapTransform}
      data-terminal-id={terminal.id}
      className="h-full min-w-0"
      {...remainingAttributes}
      aria-roledescription="sortable item"
    >
      <div
        ref={setNodeRef}
        style={sortableStyle}
        className={cn(
          "h-full min-w-0 contain-layout contain-style",
          isDragging && "ring-2 ring-daintree-text/20 rounded"
        )}
      >
        <m.div
          className="h-full"
          animate={{ opacity: isDragging ? DRAG_GHOST_OPACITY : 1 }}
          transition={{
            duration: isDragging ? UI_ANIMATION_DURATION / 1000 : 0,
            ease: DRAG_GHOST_EASING,
          }}
        >
          <DragHandleProvider value={{ listeners, setActivatorNodeRef }}>
            {children}
          </DragHandleProvider>
        </m.div>
      </div>
    </m.div>
  );
}
