import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  clampToolDrawerWidth,
  useDevPreviewToolStore,
  TOOL_DRAWER_DEFAULT_WIDTH,
  TOOL_DRAWER_MAX_WIDTH,
  TOOL_DRAWER_MIN_WIDTH,
} from "@/store/devPreviewToolStore";
import { cn } from "@/lib/utils";

/**
 * The page's floor beside a docked drawer. A drawer that keeps taking width from
 * a tiled preview walks the site through its own responsive breakpoints, so the
 * preview stops showing what the user is building. Under this the drawer floats
 * over the page instead: the page keeps the width it laid itself out at, and the
 * drawer stays a full surface rather than a squeezed column.
 */
const PAGE_MIN_WIDTH = 480;
/** What a floating drawer always leaves of the page, so it never covers it whole. */
const OVERLAY_GUTTER = 56;
const RESIZE_STEP = 16;

/** Live width of the preview pane the drawer is docked into; 0 until measured. */
function usePaneWidth(root: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const pane = root?.parentElement;
    if (!pane) return;
    setWidth(pane.clientWidth);
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => setWidth(pane.clientWidth));
    observer.observe(pane);
    return () => observer.disconnect();
  }, [root]);
  return width;
}

/**
 * Drag-to-resize for the drawer's page-facing (left) edge, committed to the
 * store once per gesture. The live width stays local so the drag is fluid.
 *
 * Pointer capture, not document listeners and not a shield: the drag crosses
 * the page, which is an out-of-process `<webview>` that takes the pointer the
 * moment it enters, and the panel around it is `contain: content`, so a
 * `fixed` shield cannot reach past the panel's own edge into a neighbour.
 * Capture retargets every pointer event to the handle whatever is under it,
 * and a lost capture ends the gesture rather than leaving it stuck.
 */
function useDrawerResize(): {
  draft: number | null;
  isResizing: boolean;
  start: (e: React.PointerEvent, from: number) => void;
  move: (e: React.PointerEvent) => void;
  end: () => void;
  onKeyDown: (e: React.KeyboardEvent, from: number) => void;
  reset: () => void;
} {
  const stored = useDevPreviewToolStore((s) => s.drawerWidth);
  const setDrawerWidth = useDevPreviewToolStore((s) => s.setDrawerWidth);
  const [draft, setDraft] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(stored);
  const draftRef = useRef(stored);

  // `from` is the width the drawer is actually showing, which is not the stored
  // width once a narrow pane has capped it: a drag starting from the stored
  // width would spend its first pixels moving nothing.
  const start = useCallback((e: React.PointerEvent, from: number) => {
    // Only the primary button resizes; anything else falls through rather
    // than locking the body cursor.
    if (e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; the gesture then
      // ends on the first pointerup the handle still sees.
    }
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = from;
    draftRef.current = from;
    setDraft(from);
    setIsResizing(true);
  }, []);

  const move = useCallback((e: React.PointerEvent) => {
    // The drawer is docked right, so dragging left (smaller clientX) grows it.
    const next = clampToolDrawerWidth(
      dragStartWidthRef.current + (dragStartXRef.current - e.clientX)
    );
    draftRef.current = next;
    setDraft(next);
  }, []);

  const end = useCallback(() => {
    const moved = draftRef.current !== dragStartWidthRef.current;
    setDraft(null);
    setIsResizing(false);
    if (moved) setDrawerWidth(draftRef.current);
  }, [setDrawerWidth]);

  useEffect(() => {
    if (!isResizing) return;
    // A window that loses focus mid-drag never sees the pointer go up.
    window.addEventListener("blur", end);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("blur", end);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, end]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent, from: number) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setDrawerWidth(from + RESIZE_STEP);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setDrawerWidth(from - RESIZE_STEP);
      }
    },
    [setDrawerWidth]
  );

  const reset = useCallback(() => setDrawerWidth(TOOL_DRAWER_DEFAULT_WIDTH), [setDrawerWidth]);

  return { draft, isResizing, start, move, end, onKeyDown, reset };
}

/**
 * The host's chrome around a dev preview tool's drawer: its width, its resize
 * handle, and the policy for a preview too narrow to share. The tool fills it
 * and owns nothing about how much room it gets — every tool's drawer is the same
 * surface, and a plugin cannot decide to eat a tiled preview.
 *
 * The chrome is hidden while the tool's drawer renders nothing, so a tool that
 * stays closed until it has something to say (SvelteKit Tools does) costs the
 * page no width at all.
 */
export function DevPreviewToolDrawerChrome({
  children,
  surfaceTag,
}: {
  children: ReactNode;
  /** Identifies the tool and preview this drawer belongs to, for focus return. */
  surfaceTag?: string;
}) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const paneWidth = usePaneWidth(root);
  const stored = useDevPreviewToolStore((s) => s.drawerWidth);
  const { draft, isResizing, start, move, end, onKeyDown, reset } = useDrawerResize();
  const wanted = draft ?? stored;

  // Unmeasured (first paint, or a pane that never reports) docks: the common
  // case is a preview with room, and a drawer that starts floating and settles
  // would be a worse first frame than one that starts docked.
  const floating = paneWidth > 0 && paneWidth - wanted < PAGE_MIN_WIDTH;
  const width = floating ? Math.min(wanted, Math.max(paneWidth - OVERLAY_GUTTER, 0)) : wanted;
  // The range the handle announces is the one this pane can honour, not the
  // store's: a narrow pane caps the drawer below the nominal minimum, and a
  // reader told "280 to 560" of a 264px drawer is being lied to.
  const effectiveMax =
    paneWidth > 0
      ? Math.min(TOOL_DRAWER_MAX_WIDTH, paneWidth - OVERLAY_GUTTER)
      : TOOL_DRAWER_MAX_WIDTH;
  const rangeMax = Math.max(Math.round(width), Math.round(effectiveMax));
  const rangeMin = Math.min(TOOL_DRAWER_MIN_WIDTH, Math.round(width));

  return (
    <div
      ref={setRoot}
      data-testid="dev-preview-tool-drawer"
      data-dev-preview-tool-surface={surfaceTag}
      data-floating={floating ? "true" : undefined}
      style={{ width }}
      className={cn(
        // `@container/drawer` here rather than in the tool: the drawer's rows
        // answer to the width the host gave them, which is the only width that
        // is ever true.
        "@container/drawer relative min-h-0 shrink-0 flex-col border-l border-overlay bg-surface-panel text-text-primary",
        // Nothing rendered inside means no drawer: a tool's drawer that returns
        // null must not leave the page paying for an empty column.
        "hidden has-[[data-drawer-content]>*]:flex",
        // Above the page's own overlays — the reconnect notice, the load error
        // and the find bar all sit at `z-20` in this same stacking context.
        floating && "absolute inset-y-0 right-0 z-30 shadow-[var(--theme-shadow-floating)]"
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize tool drawer (double-click to reset)"
        aria-valuenow={Math.round(width)}
        aria-valuemin={rangeMin}
        aria-valuemax={rangeMax}
        tabIndex={0}
        onPointerDown={(e) => start(e, width)}
        onPointerMove={isResizing ? move : undefined}
        onPointerUp={isResizing ? end : undefined}
        onPointerCancel={isResizing ? end : undefined}
        onLostPointerCapture={isResizing ? end : undefined}
        onKeyDown={(e) => onKeyDown(e, width)}
        onDoubleClick={reset}
        className={cn(
          "group/resize absolute inset-y-0 -left-1.5 z-20 flex w-3 cursor-col-resize items-center justify-center",
          // Neutral throughout: a resize handle is a secondary affordance, and
          // the accent in this region belongs to the tool itself.
          "transition-colors focus-visible:bg-overlay-medium focus-visible:outline-hidden",
          // Hover styling is off while resizing, or it outranks the drag state.
          isResizing ? "bg-overlay-medium" : "hover:bg-overlay-soft"
        )}
      >
        <div
          className={cn(
            "h-8 rounded-full transition-[width] delay-100 duration-150",
            isResizing
              ? "w-0.5 bg-text-primary/50"
              : "w-px bg-text-primary/20 group-hover/resize:w-0.5 group-hover/resize:bg-text-primary/35 group-focus-visible/resize:w-0.5 group-focus-visible/resize:bg-text-primary/60"
          )}
        />
      </div>
      <div data-drawer-content className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
