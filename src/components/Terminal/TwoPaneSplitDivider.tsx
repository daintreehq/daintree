import { useCallback, useEffect, useLayoutEffect, useState, useRef } from "react";
import { cn } from "@/lib/utils";

interface TwoPaneSplitDividerProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  // Called with the ratio when a key sets it, so the committed value is the
  // one just computed rather than one still pending in the parent's state.
  onRatioCommit: (ratio?: number) => void;
  onDoubleClick: () => void;
  onDragStateChange?: (isDragging: boolean) => void;
  minRatio?: number;
  maxRatio?: number;
}

const DIVIDER_WIDTH_PX = 6;
const KEYBOARD_STEP = 0.02;
const KEYBOARD_COARSE_STEP = 0.1;

function percent(ratio: number): number {
  return Math.round(ratio * 100);
}

export function TwoPaneSplitDivider({
  containerRef,
  ratio,
  onRatioChange,
  onRatioCommit,
  onDoubleClick,
  onDragStateChange,
  minRatio = 0.2,
  maxRatio = 0.8,
}: TwoPaneSplitDividerProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dividerRef = useRef<HTMLDivElement>(null);
  const cleanupFnRef = useRef<(() => void) | null>(null);

  // Notify parent of drag state changes
  useEffect(() => {
    onDragStateChange?.(isDragging);
  }, [isDragging, onDragStateChange]);

  // Cache drag state in refs to avoid callback recreation during drag
  const dragStateRef = useRef({
    containerRect: null as DOMRect | null,
    minRatio,
    maxRatio,
    onRatioChange,
    onRatioCommit,
  });

  // Update refs when props change (but not during drag)
  useEffect(() => {
    if (!isDragging) {
      dragStateRef.current.minRatio = minRatio;
      dragStateRef.current.maxRatio = maxRatio;
    }
    dragStateRef.current.onRatioChange = onRatioChange;
    dragStateRef.current.onRatioCommit = onRatioCommit;
  }, [isDragging, minRatio, maxRatio, onRatioChange, onRatioCommit]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      // Don't stopPropagation - allow double-click to work

      // Cache container rect at drag start to avoid layout thrashing
      if (containerRef.current) {
        dragStateRef.current.containerRect = containerRef.current.getBoundingClientRect();
      }

      // Track if we've actually started dragging (mouse moved)
      let hasMoved = false;
      const startX = e.clientX;

      const handleMouseMove = (moveEvent: MouseEvent) => {
        // Only consider it a drag if mouse moved more than 3px
        if (!hasMoved && Math.abs(moveEvent.clientX - startX) > 3) {
          hasMoved = true;
          // Acquire resize ownership before the ratio write below can reflow
          // the panes. Waiting for the isDragging effect leaves one commit
          // where ResizeObserver can publish mid-gesture PTY geometry.
          onDragStateChange?.(true);
          setIsDragging(true);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }

        if (!hasMoved) return;

        const {
          containerRect,
          minRatio: min,
          maxRatio: max,
          onRatioChange: onChange,
        } = dragStateRef.current;
        if (!containerRect || containerRect.width <= 0) return;

        const offsetX = moveEvent.clientX - containerRect.left;
        const newRatio = Math.max(min, Math.min(max, offsetX / containerRect.width));
        if (Number.isFinite(newRatio)) {
          onChange(newRatio);
        }
      };

      const handleMouseUp = () => {
        cleanup();
        if (hasMoved) {
          setIsDragging(false);
          dragStateRef.current.onRatioCommit();
        }
        dragStateRef.current.containerRect = null;
      };

      const handleBlur = () => {
        cleanup();
        if (hasMoved) {
          setIsDragging(false);
          dragStateRef.current.onRatioCommit();
        }
        dragStateRef.current.containerRect = null;
      };

      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;

      const cleanup = () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        window.removeEventListener("blur", handleBlur);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        cleanupFnRef.current = null;
      };

      // Store cleanup function for unmount safety
      cleanupFnRef.current = cleanup;

      // Attach listeners synchronously to catch immediate mouseup
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      window.addEventListener("blur", handleBlur);
    },
    [containerRef, onDragStateChange]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupFnRef.current) {
        cleanupFnRef.current();
      }
    };
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? KEYBOARD_COARSE_STEP : KEYBOARD_STEP;
      let next: number | null = null;
      if (e.key === "ArrowLeft") next = ratio - step;
      else if (e.key === "ArrowRight") next = ratio + step;
      else if (e.key === "Home") next = minRatio;
      else if (e.key === "End") next = maxRatio;
      else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onDoubleClick();
        return;
      }
      if (next === null) return;
      e.preventDefault();
      const clamped = Math.max(minRatio, Math.min(maxRatio, next));
      onRatioChange(clamped);
      onRatioCommit(clamped);
    },
    [ratio, minRatio, maxRatio, onRatioChange, onRatioCommit, onDoubleClick]
  );

  // The primary pane is the left one: its size is the value. Its body is the
  // region this separator controls, found in the DOM because a tab group's
  // rendered pane is its active tab, which the split's panel pair does not name.
  const [controlsId, setControlsId] = useState<string | undefined>(undefined);
  const resolveControlsId = useCallback(() => {
    const leftPane = containerRef.current?.firstElementChild;
    const body = leftPane?.querySelector<HTMLElement>('[id^="panel-body-"]');
    setControlsId(body?.id || undefined);
  }, [containerRef]);
  useLayoutEffect(resolveControlsId, [resolveControlsId]);

  const handleDoubleClick = useCallback(() => {
    onDoubleClick();
  }, [onDoubleClick]);

  return (
    <div
      ref={dividerRef}
      role="separator"
      aria-label="Resize split between left and right panes"
      aria-orientation="vertical"
      aria-controls={controlsId}
      aria-valuenow={percent(ratio)}
      aria-valuemin={percent(minRatio)}
      aria-valuemax={percent(maxRatio)}
      aria-valuetext={`Left pane ${percent(ratio)}%, right pane ${100 - percent(ratio)}%`}
      aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Home End Enter"
      tabIndex={0}
      className={cn(
        "group cursor-col-resize flex items-center justify-center z-10 shrink-0 transition-colors",
        // Hover styling is off while dragging: the pointer sits on the divider
        // for the whole gesture, so a hover variant would outrank the drag state
        // and the two would render identically.
        //
        // On dark, overlay-soft already clears the JND (~0.022-0.032 dL), so it
        // stays. On light it composites sub-JND (~0.012-0.018 dL), so .light
        // alone steps the resting hover scrim up to overlay-medium.
        isDragging
          ? "bg-overlay-medium"
          : "hover:bg-overlay-soft [.light_&]:hover:bg-overlay-medium",
        // Keyboard focus is one solid inset outline — the single accent anchor
        // for this region. Outline rather than ring so it is the same mark the
        // forced-colors override redraws, and inset so it stays inside the track
        // instead of painting over both pane borders.
        "outline-hidden focus-visible:bg-overlay-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary"
      )}
      style={{ width: DIVIDER_WIDTH_PX }}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
      onFocus={resolveControlsId}
    >
      <div
        className={cn(
          "h-16 rounded-full transition-[width] duration-150 delay-100",
          // The grip's ink ladder: /20 rest, /35 hover, /50 drag on dark. On
          // light the low-alpha ink reads too faint over the near-white track, so
          // .light raises every step. Focus keeps it neutral in every theme — the
          // outline is the accent — and widens it so it reads inside the frame.
          isDragging
            ? "w-0.5 bg-text-primary/50 [.light_&]:bg-text-primary/55"
            : cn(
                "w-px group-hover:w-0.5 group-focus-visible:w-0.5",
                "bg-text-primary/20 group-hover:bg-text-primary/35 group-focus-visible:bg-text-primary/50",
                "[.light_&]:bg-text-primary/25 [.light_&]:group-hover:bg-text-primary/45",
                "[.light_&]:group-focus-visible:bg-text-primary/55"
              )
        )}
      />
    </div>
  );
}

export { DIVIDER_WIDTH_PX };
