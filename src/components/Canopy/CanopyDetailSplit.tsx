import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { RESIZE_HANDLE_INLINE_TRACK_PX, ResizeHandle } from "@/components/ui/ResizeHandle";
import { useSplitterKeys } from "@/hooks/useSplitterKeys";
import { resizeCappedPreference } from "@/hooks/useViewportCappedWidth";
import { useCanopyStore } from "@/store/canopyStore";
import {
  CANOPY_DOCK_MAX_WIDTH,
  CANOPY_DOCK_MIN_WIDTH,
  canopyDockRoom,
  canopyDockSideBySide,
} from "./canopyDockWidth";
import { beginEdgeDrag, sameOnScreen } from "./canopyEdgeDrag";
import { CANOPY_PANE_MIN_WIDTH } from "./canopyListWidth";

/** What `.canopy-dock`'s `max-width` leaves the agent beside it: its pane's minimum and the edge's track. */
const SPLIT_STYLE = {
  "--canopy-dock-agent-room": `${CANOPY_PANE_MIN_WIDTH + RESIZE_HANDLE_INLINE_TRACK_PX}px`,
} as CSSProperties;

const RESIZE_STEP = 10;
const RESIZE_STEP_LARGE = 50;

/**
 * Canopy's detail area: the selected agent, and the global assistant docked
 * beside it (#16214), so an agent's ask and the assistant that can act on it
 * are on screen together. Side by side, the assistant's left edge is dragged,
 * stepped or reset as the list's is; where there isn't room for both, they
 * stack, the agent above. With only one of the two, it takes the whole area.
 *
 * Each pane keeps its place in the tree whichever way they sit, so neither
 * terminal reopens its stream when the window narrows or the other comes or goes.
 */
export function CanopyDetailSplit({
  children,
  dock,
}: {
  /** The selected agent's pane; null when the dock is all there is to show. */
  children: ReactNode;
  /** The global assistant, or null while it isn't docked. */
  dock: ReactNode;
}) {
  const splitRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const dockWidth = useCanopyStore((state) => state.dockWidth);
  const dockDrag = useCanopyStore((state) => state.dockDrag);
  const setDockWidth = useCanopyStore((state) => state.setDockWidth);
  const setDockDrag = useCanopyStore((state) => state.setDockDrag);
  const [shown, setShown] = useState({ width: 0, split: 0 });
  const endDragRef = useRef<(() => void) | null>(null);
  const paired = children !== null && dock !== null;

  useEffect(() => {
    const split = splitRef.current;
    if (!split) return;
    const measure = () => {
      const width = dockRef.current?.getBoundingClientRect().width ?? 0;
      // The content box: the area's padding is no room for either pane.
      const style = getComputedStyle(split);
      const splitWidth =
        split.getBoundingClientRect().width -
        (parseFloat(style.paddingLeft) || 0) -
        (parseFloat(style.paddingRight) || 0);
      setShown((was) =>
        was.width === width && was.split === splitWidth ? was : { width, split: splitWidth }
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(split);
    if (dockRef.current) observer.observe(dockRef.current);
    return () => observer.disconnect();
  }, [paired]);

  const sideBySide = canopyDockSideBySide(shown.split);
  // A drag under way lands when its edge goes: the dock leaving, or the panes stacking.
  const resizable = paired && sideBySide;
  useEffect(() => {
    if (!resizable) endDragRef.current?.();
  }, [resizable]);
  useEffect(() => () => endDragRef.current?.(), []);

  const room = canopyDockRoom(shown.split);
  const shownWidth = shown.width > 0 ? shown.width : (dockWidth ?? CANOPY_DOCK_MIN_WIDTH);
  const min = Math.min(CANOPY_DOCK_MIN_WIDTH, room);
  const max = Math.min(CANOPY_DOCK_MAX_WIDTH, room);

  const startDrag = (event: MouseEvent) => {
    if (event.button !== 0 || endDragRef.current) return;
    const split = splitRef.current;
    const pane = dockRef.current;
    if (!split || !pane) return;
    event.preventDefault();
    const startWidth = pane.getBoundingClientRect().width;
    setDockDrag(Math.round(startWidth));
    endDragRef.current = beginEdgeDrag({
      startX: event.clientX,
      startWidth,
      preference: dockWidth,
      room,
      min: CANOPY_DOCK_MIN_WIDTH,
      max: CANOPY_DOCK_MAX_WIDTH,
      grow: -1,
      setDrag: setDockDrag,
      onEnd: (reached) => {
        endDragRef.current = null;
        // Kept before the drag lets go, so no frame shows the old width between.
        if (reached !== null) setDockWidth(reached);
        setDockDrag(null);
      },
    });
  };

  const onKeyDown = useSplitterKeys({
    growKey: "ArrowLeft",
    value: shownWidth,
    min,
    max,
    step: RESIZE_STEP,
    largeStep: RESIZE_STEP_LARGE,
    onChange: (width) => {
      const next = resizeCappedPreference(
        width,
        dockWidth ?? shownWidth,
        CANOPY_DOCK_MIN_WIDTH,
        CANOPY_DOCK_MAX_WIDTH,
        room
      );
      // A step at a bound or the cap moves nothing on screen, so keeps nothing.
      if (!sameOnScreen(next, shownWidth, room)) setDockWidth(next);
    },
    onReset: () => setDockWidth(null),
  });

  const width = dockDrag ?? dockWidth;
  const dockStyle =
    paired && sideBySide && width !== null
      ? ({ "--canopy-dock-width": `${width}px` } as CSSProperties)
      : undefined;

  return (
    <div
      ref={splitRef}
      data-canopy-detail-split={paired ? (sideBySide ? "side-by-side" : "stacked") : undefined}
      style={SPLIT_STYLE}
      className={cn(
        "flex min-h-0 min-w-0 flex-1 bg-surface-canvas p-2",
        paired && sideBySide ? "flex-row" : "flex-col",
        paired && !sideBySide && "gap-2 overflow-y-auto"
      )}
    >
      {children !== null && (
        <div
          key="agent"
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            paired && !sideBySide && "canopy-dock-stacked"
          )}
        >
          {children}
        </div>
      )}
      {resizable && (
        <ResizeHandle
          key="edge"
          growKey="ArrowLeft"
          edge="inline"
          label="Resize global assistant"
          value={shownWidth}
          min={min}
          max={max}
          isResizing={dockDrag !== null}
          data-testid="canopy-dock-resize"
          onMouseDown={startDrag}
          onKeyDown={onKeyDown}
          onReset={() => setDockWidth(null)}
        />
      )}
      {dock !== null && (
        <div
          key="dock"
          ref={dockRef}
          id="canopy-global-dock"
          role="region"
          aria-label="Global assistant"
          data-canopy-global=""
          style={dockStyle}
          className={cn(
            "flex min-h-0 min-w-0 flex-col",
            !paired ? "flex-1" : sideBySide ? "canopy-dock shrink-0" : "canopy-dock-stacked flex-1"
          )}
        >
          {dock}
        </div>
      )}
    </div>
  );
}
