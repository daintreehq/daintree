import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/appThemeViewTransition";

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
/** Share of the viewport one track page moves, leaving a strip of overlap for context. */
const TRACK_PAGE_FRACTION = 0.9;
/** Press-and-hold on the track: first repeat after this, like a native scrollbar. */
const TRACK_REPEAT_DELAY_MS = 450;
const TRACK_REPEAT_INTERVAL_MS = 60;

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
 * Next `scrollTop` for one track page toward `pointerY` (track-relative), or
 * `null` once the handle already sits under the pointer. The page is clamped
 * so the handle's centre never travels past the pointer — a click just beyond
 * a long handle nudges it there instead of throwing the grid a whole page, and
 * press-and-hold stops where the user is pointing rather than at an end.
 */
export function computeTrackPageTarget(
  m: ScrollMetrics,
  trackHeight: number,
  minThumb: number,
  pointerY: number
): number | null {
  const geo = computeThumbGeometry(m, trackHeight, minThumb);
  if (!geo) return null;
  if (pointerY >= geo.top && pointerY <= geo.top + geo.height) return null;
  const maxScroll = m.scrollHeight - m.clientHeight;
  const travel = trackHeight - geo.height;
  if (travel <= 0) return null;
  const centred = Math.max(
    0,
    Math.min(maxScroll, ((pointerY - geo.height / 2) / travel) * maxScroll)
  );
  const page = m.clientHeight * TRACK_PAGE_FRACTION;
  const next =
    pointerY < geo.top
      ? Math.max(m.scrollTop - page, centred)
      : Math.min(m.scrollTop + page, centred);
  const clamped = Math.max(0, Math.min(maxScroll, next));
  return Math.abs(clamped - m.scrollTop) < 1 ? null : clamped;
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
  // React state holds only what changes the rendered tree: the thumb's height
  // and whether the content overflows at all. Per-scroll position is written
  // straight to the thumb element as a composited transform inside an
  // rAF-coalesced listener — routing it through setState re-rendered the
  // component and invalidated layout (`top`) on every scroll frame.
  const [dims, setDims] = useState<{ scrollHeight: number; clientHeight: number }>({
    scrollHeight: 0,
    clientHeight: 0,
  });
  const [phase, setPhase] = useState<"idle" | "hover" | "drag">("idle");
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);
  const trackHoldRef = useRef<{
    pointerY: number;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);

  const stopTrackHold = useCallback(() => {
    const hold = trackHoldRef.current;
    if (hold?.timer != null) clearTimeout(hold.timer);
    trackHoldRef.current = null;
  }, []);

  useEffect(() => stopTrackHold, [stopTrackHold]);

  useEffect(() => {
    const el = scrollRoot;
    if (!el) return;
    let rafId: number | null = null;
    const syncDims = () => {
      setDims((prev) =>
        prev.scrollHeight === el.scrollHeight && prev.clientHeight === el.clientHeight
          ? prev
          : { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
      );
    };
    const writeThumb = () => {
      rafId = null;
      const thumb = thumbRef.current;
      if (!thumb) return;
      const live: ScrollMetrics = {
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
      const trackHeight = Math.max(0, live.clientHeight - 2 * TRACK_INSET_PX);
      const geo = computeThumbGeometry(live, trackHeight, THUMB_MIN_PX);
      if (!geo) return;
      thumb.style.transform = `translateY(${geo.top}px)`;
      const maxScroll = live.scrollHeight - live.clientHeight;
      thumb.setAttribute(
        "aria-valuenow",
        String(maxScroll > 0 ? Math.round((live.scrollTop / maxScroll) * 100) : 0)
      );
      // Content height can grow mid-scroll without a resize or revision bump;
      // the equality guard makes this a no-op on ordinary frames.
      syncDims();
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(writeThumb);
    };
    const measure = () => {
      syncDims();
      schedule();
    };
    measure();
    el.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", schedule);
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollRoot, revision]);

  const trackHeight = Math.max(0, dims.clientHeight - 2 * TRACK_INSET_PX);
  const geometry = computeThumbGeometry({ scrollTop: 0, ...dims }, trackHeight, THUMB_MIN_PX);

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
    const el = e.currentTarget;
    if (el.hasPointerCapture(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
    // Capture suppressed enter/leave for the whole drag, so the phase after
    // release comes from where the pointer actually is, not where it started.
    const r = el.getBoundingClientRect();
    const over =
      e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    setPhase(over ? "hover" : "idle");
  }, []);

  const pageTowardPointer = useCallback(
    (smooth: boolean): boolean => {
      const track = trackRef.current;
      const hold = trackHoldRef.current;
      if (!scrollRoot || !track || !hold) return false;
      const next = computeTrackPageTarget(
        {
          scrollTop: scrollRoot.scrollTop,
          scrollHeight: scrollRoot.scrollHeight,
          clientHeight: scrollRoot.clientHeight,
        },
        track.clientHeight,
        THUMB_MIN_PX,
        hold.pointerY
      );
      if (next === null) return false;
      scrollRoot.scrollTo({ top: next, behavior: smooth ? "smooth" : "auto" });
      return true;
    },
    [scrollRoot]
  );

  const onTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // A press in the empty track pages toward the pointer, then repeats while
      // held until the handle reaches it — a native scrollbar's contract.
      const track = trackRef.current;
      if (!scrollRoot || !track || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      stopTrackHold();
      trackHoldRef.current = {
        pointerY: e.clientY - track.getBoundingClientRect().top,
        timer: null,
      };
      if (!pageTowardPointer(!prefersReducedMotion())) {
        stopTrackHold();
        return;
      }
      track.setPointerCapture(e.pointerId);
      const repeat = () => {
        const hold = trackHoldRef.current;
        if (!hold) return;
        hold.timer = pageTowardPointer(false) ? setTimeout(repeat, TRACK_REPEAT_INTERVAL_MS) : null;
      };
      trackHoldRef.current.timer = setTimeout(repeat, TRACK_REPEAT_DELAY_MS);
    },
    [scrollRoot, pageTowardPointer, stopTrackHold]
  );

  const onTrackPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const hold = trackHoldRef.current;
    const track = trackRef.current;
    if (!hold || !track) return;
    hold.pointerY = e.clientY - track.getBoundingClientRect().top;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      // The scrollbar overlays the grid's gutter, so a wheel over it would
      // otherwise land on dead space. Forward the delta to the grid so the
      // wheel scrolls the grid no matter where the cursor sits.
      if (!scrollRoot) return;
      e.stopPropagation();
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

  return (
    <div
      ref={trackRef}
      data-no-dnd
      onPointerDown={onTrackPointerDown}
      onPointerMove={onTrackPointerMove}
      onPointerUp={stopTrackHold}
      onPointerCancel={stopTrackHold}
      onLostPointerCapture={stopTrackHold}
      onWheel={onWheel}
      className="absolute z-20 rounded-full bg-[var(--scrollbar-track)]"
      style={{
        right: BAR_INSET_PX,
        top: TRACK_INSET_PX,
        bottom: TRACK_INSET_PX,
        width: BAR_WIDTH_PX,
      }}
    >
      <div
        ref={thumbRef}
        role="scrollbar"
        aria-orientation="vertical"
        aria-controls="panel-grid"
        // Kept out of React's render path along with the thumb position; the
        // scroll listener owns both. The constant initial value means React's
        // prop diff never overwrites the imperatively-written attribute.
        aria-valuenow={0}
        aria-valuemin={0}
        aria-valuemax={100}
        tabIndex={-1}
        data-grid-scrollbar-thumb=""
        data-phase={phase}
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onPointerEnter={() => setPhase((p) => (p === "drag" ? p : "hover"))}
        onPointerLeave={() => setPhase((p) => (p === "drag" ? p : "idle"))}
        className={cn(
          "absolute inset-x-0 cursor-default rounded-full border-2 border-transparent bg-clip-padding",
          "transition-[background-color,border-color] duration-150 ease-out",
          phase === "idle" && "bg-[var(--scrollbar-thumb)]",
          phase === "hover" && "bg-[var(--scrollbar-thumb-hover)]",
          phase === "drag" && "bg-[var(--scrollbar-thumb-active)]"
        )}
        style={{ height: geometry.height, top: 0 }}
      />
    </div>
  );
}
