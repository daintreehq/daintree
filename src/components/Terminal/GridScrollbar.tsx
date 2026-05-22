import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Total horizontal space the custom scrollbar reserves (bar + edge margin). */
export const GRID_SCROLLBAR_GUTTER_PX = 22;

/** Visible bar width. */
const BAR_WIDTH_PX = 14;
/** Margin between the bar and the grid's right edge. */
const BAR_INSET_PX = 4;
/** Vertical inset of the track inside the grid viewport (top and bottom each). */
const TRACK_INSET_PX = 4;
/** Smallest the handle ever gets, so it stays grabbable on huge fleets. */
const THUMB_MIN_PX = 44;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Pure handle geometry. Returns `null` when the content does not overflow —
 * the caller renders nothing. Otherwise `height` is proportional to the
 * visible fraction (clamped to `minThumb`) and `top` is the handle's offset
 * within the track for the current scroll position.
 */
export function computeThumbGeometry(
  m: ScrollMetrics,
  trackHeight: number,
  minThumb: number
): { height: number; top: number } | null {
  const maxScroll = m.scrollHeight - m.clientHeight;
  if (maxScroll <= 1 || trackHeight <= 0 || m.scrollHeight <= 0) return null;
  const raw = (m.clientHeight / m.scrollHeight) * trackHeight;
  const height = Math.min(trackHeight, Math.max(minThumb, Math.round(raw)));
  const travel = trackHeight - height;
  const top = travel > 0 ? Math.round((m.scrollTop / maxScroll) * travel) : 0;
  return { height, top };
}

/**
 * A custom, always-visible scroll handle for the agent panel grid — modelled
 * on xterm's (VS Code's) slider rather than the OS scrollbar. The native
 * scrollbar on `#panel-grid` is hidden in CSS; this overlays a chunky,
 * physical handle that shows scroll position and can be dragged. The grid
 * still scrolls by wheel / keyboard / programmatic scroll independently.
 *
 * `revision` changes whenever the grid layout could have changed the content
 * height (panel open/close, column count, scroll-mode flip) — a plain scroll
 * listener and ResizeObserver miss those because `scrollHeight` grows without
 * either firing.
 */
export function GridScrollbar({
  scrollRoot,
  revision,
}: {
  scrollRoot: HTMLElement | null;
  revision: string | number;
}) {
  const [metrics, setMetrics] = useState<ScrollMetrics>({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  });
  const [phase, setPhase] = useState<"idle" | "hover" | "drag">("idle");
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);

  useEffect(() => {
    const el = scrollRoot;
    if (!el) return;
    const measure = () => {
      setMetrics((prev) => {
        const next: ScrollMetrics = {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
        };
        return prev.scrollTop === next.scrollTop &&
          prev.scrollHeight === next.scrollHeight &&
          prev.clientHeight === next.clientHeight
          ? prev
          : next;
      });
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [scrollRoot, revision]);

  const trackHeight = Math.max(0, metrics.clientHeight - 2 * TRACK_INSET_PX);
  const geometry = computeThumbGeometry(metrics, trackHeight, THUMB_MIN_PX);

  const onThumbPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!scrollRoot) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startScrollTop: scrollRoot.scrollTop };
      setPhase("drag");
    },
    [scrollRoot]
  );

  const onThumbPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      const track = trackRef.current;
      if (!drag || !track || !scrollRoot) return;
      const live: ScrollMetrics = {
        scrollTop: scrollRoot.scrollTop,
        scrollHeight: scrollRoot.scrollHeight,
        clientHeight: scrollRoot.clientHeight,
      };
      const geo = computeThumbGeometry(live, track.clientHeight, THUMB_MIN_PX);
      if (!geo) return;
      const travel = track.clientHeight - geo.height;
      if (travel <= 0) return;
      const maxScroll = live.scrollHeight - live.clientHeight;
      const next = drag.startScrollTop + ((e.clientY - drag.startY) / travel) * maxScroll;
      // `scrollTo` (a method call) rather than assigning `scrollRoot.scrollTop`:
      // the React Compiler forbids writing to a prop's property.
      scrollRoot.scrollTo({ top: Math.max(0, Math.min(maxScroll, next)) });
    },
    [scrollRoot]
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setPhase("idle");
  }, []);

  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // A click in the empty track pages toward the click, like a real scrollbar.
      const track = trackRef.current;
      if (!scrollRoot || !track || !geometry) return;
      e.stopPropagation();
      const clickY = e.clientY - track.getBoundingClientRect().top;
      const dir = clickY < geometry.top ? -1 : 1;
      scrollRoot.scrollBy({ top: dir * scrollRoot.clientHeight * 0.9, behavior: "smooth" });
    },
    [scrollRoot, geometry]
  );

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // The scrollbar overlays the grid's gutter, so a wheel over it would
      // otherwise land on dead space. Forward the delta to the grid so the
      // wheel scrolls the grid no matter where the cursor sits.
      if (!scrollRoot) return;
      const px =
        e.deltaMode === 2
          ? e.deltaY * scrollRoot.clientHeight
          : e.deltaMode === 1
            ? e.deltaY * 16
            : e.deltaY;
      scrollRoot.scrollBy({ top: px });
    },
    [scrollRoot]
  );

  if (!scrollRoot || !geometry) return null;

  const maxScroll = metrics.scrollHeight - metrics.clientHeight;
  const valueNow = maxScroll > 0 ? Math.round((metrics.scrollTop / maxScroll) * 100) : 0;

  return (
    <div
      ref={trackRef}
      data-no-dnd
      onPointerDown={onTrackPointerDown}
      onWheel={onWheel}
      className="absolute z-20"
      style={{
        right: BAR_INSET_PX,
        top: TRACK_INSET_PX,
        bottom: TRACK_INSET_PX,
        width: BAR_WIDTH_PX,
      }}
    >
      <div
        role="scrollbar"
        aria-orientation="vertical"
        aria-controls="panel-grid"
        aria-valuenow={valueNow}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={-1}
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerEnter={() => setPhase((p) => (p === "drag" ? p : "hover"))}
        onPointerLeave={() => setPhase((p) => (p === "drag" ? p : "idle"))}
        className={cn(
          "absolute inset-x-0 cursor-default rounded-[7px] transition-colors",
          phase === "idle" ? "bg-[var(--scrollbar-thumb)]" : "bg-[var(--scrollbar-thumb-hover)]"
        )}
        style={{ height: geometry.height, top: geometry.top }}
      />
    </div>
  );
}
