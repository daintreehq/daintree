import { useLayoutEffect, useRef, useState } from "react";
import { MousePointer2 } from "lucide-react";
import {
  useSecondsSinceCue,
  useTimelineIndex,
  useTourPlayer,
  type TimelinePoint,
} from "../react.js";
import { cn } from "./cn.js";
import { ANCHOR_SETTLE_MS, hasCanvasLayout, measureAnchor } from "./tourAnchors.js";

/** Vite's dev flag; undefined — so no warnings — under any other bundler. */
function isDevBuild(): boolean {
  return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
}

/** Breathing room between the last typed character and the moment it's acted on. */
const TYPING_MARGIN_S = 0.15;

/**
 * Typing speed that finishes the text before a later cue, never slower than
 * `floor`. Keeps typed prompts ahead of the Enter they lead to whatever pace
 * the narrator reads at — a re-recording can't leave a prompt half-typed.
 */
export function typingRate(
  length: number,
  startAt: number,
  finishAt: number | undefined,
  floor: number
): number {
  if (finishAt === undefined) return floor;
  const available = finishAt - startAt - TYPING_MARGIN_S;
  return available > 0 ? Math.max(floor, length / available) : floor * 4;
}

/** Entry/exit for any element a cue reveals. Opacity survives reduced motion; the lift does not. */
export function reveal(visible: boolean, from: "below" | "above" | "left" | "none" = "below") {
  return cn(
    "transition-[opacity,translate] duration-200 ease-out reduce-motion:translate-0",
    visible ? "opacity-100 translate-0" : "opacity-0 pointer-events-none",
    !visible && from === "below" && "translate-y-2",
    !visible && from === "above" && "-translate-y-2",
    !visible && from === "left" && "-translate-x-3"
  );
}

export function MockLines({
  widths,
  className,
  visibleCount,
}: {
  widths: readonly number[];
  className?: string;
  /** Reveal lines progressively, as if streaming. Defaults to all. */
  visibleCount?: number;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)} aria-hidden="true">
      {widths.map((width, i) => (
        <div
          key={i}
          className={cn(
            "h-1.5 rounded-full bg-overlay-strong transition-opacity duration-150 ease-out",
            i < (visibleCount ?? widths.length) ? "opacity-100" : "opacity-0"
          )}
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Text that types itself out from a cue, driven by the timeline so it pauses,
 * scrubs and replays with everything else.
 */
export function MockTyping({
  cue,
  text,
  delay = 0,
  charsPerSecond = 22,
  finishBy,
  caret = true,
}: {
  cue: string;
  text: string;
  /** Seconds after the cue before the first character. */
  delay?: number;
  /** The slowest the text types; it speeds up if `finishBy` needs it to. */
  charsPerSecond?: number;
  /** A cue (plus offset) the text must be fully typed by. */
  finishBy?: TimelinePoint;
  caret?: boolean;
}) {
  const player = useTourPlayer();
  const since = useSecondsSinceCue(cue);
  if (since === null || since < delay) return null;
  const cues = player.timing.cues;
  const startAt = (cues[cue] ?? 0) + delay;
  const finishAt =
    finishBy && cues[finishBy.cue] !== undefined
      ? cues[finishBy.cue]! + (finishBy.offset ?? 0)
      : undefined;
  const rate = typingRate(text.length, startAt, finishAt, charsPerSecond);
  const shown = text.slice(0, Math.floor((since - delay) * rate));
  const done = shown.length >= text.length;
  return (
    <>
      {shown}
      {caret && !done && (
        <span className="ml-px inline-block h-2.5 w-px translate-y-0.5 bg-text-primary" />
      )}
    </>
  );
}

export interface CursorStop {
  x: number;
  y: number;
}

/**
 * The centre of a `data-tour-anchor` element, measured from the render, nudged
 * by `dx`/`dy` canvas pixels — so a click stays on its element however the
 * mockup's layout shifts.
 */
export interface CursorAnchor {
  anchor: string;
  dx?: number;
  dy?: number;
}

/** Where the pointer goes: an anchor, or a plain canvas point for spots on no element. */
export type CursorTarget = CursorStop | CursorAnchor;

export interface CursorStep extends TimelinePoint {
  at: CursorTarget;
  click?: boolean;
  /** A key held for this step, shown riding beside the pointer (e.g. "⇧ Shift"). */
  modifier?: string;
}

/**
 * Resolve a scripted pointer path against the timeline. A click is its own
 * step at the same spot, a beat after the arrival, so the glide finishes first.
 */
export function useMockCursor(start: CursorStop, steps: readonly CursorStep[]) {
  const index = useTimelineIndex(steps);
  const step = index >= 0 ? steps[index]! : null;
  return {
    at: step?.at ?? start,
    clickKey: step?.click ? String(index) : null,
    modifier: step?.modifier ?? null,
    visible: index >= 0,
  };
}

/** Reveal lines one by one from a cue, like output arriving. */
export function MockStreamingLines({
  cue,
  widths,
  perSecond = 6,
  delay = 0,
  className,
}: {
  cue: string;
  widths: readonly number[];
  perSecond?: number;
  delay?: number;
  className?: string;
}) {
  const since = useSecondsSinceCue(cue);
  const count = since === null || since < delay ? 0 : Math.floor((since - delay) * perSecond) + 1;
  return <MockLines widths={widths} visibleCount={count} className={className} />;
}

/**
 * The pointer that shows where to click. Moves between canvas positions with
 * one eased glide; a click is a ring that blooms once from the tip. An anchor
 * target is measured once its step lands and again after the target's entry
 * transition settles; one that isn't rendered leaves the pointer where it was.
 */
export function MockCursor({
  at,
  clickKey,
  modifier = null,
  visible = true,
}: {
  at: CursorTarget;
  /** Changing this replays the click ring; null shows none. */
  clickKey: string | null;
  modifier?: string | null;
  visible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const player = useTourPlayer();
  // The anchor target the pointer last reached and the click it reached it on,
  // so a later click on the same target stays put.
  const reached = useRef<{ target: string; on: string | null } | null>(null);
  const anchor = "anchor" in at ? at.anchor : null;
  const dx = "anchor" in at ? (at.dx ?? 0) : 0;
  const dy = "anchor" in at ? (at.dy ?? 0) : 0;
  const x = "anchor" in at ? 0 : at.x;
  const y = "anchor" in at ? 0 : at.y;
  const [shown, setShown] = useState<CursorStop>({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = (next: CursorStop) =>
      setShown((prev) => (prev.x === next.x && prev.y === next.y ? prev : next));
    if (anchor === null) {
      reached.current = null;
      place({ x, y });
      return;
    }
    const target = `${anchor}|${dx}|${dy}`;
    const prior = reached.current;
    // A click lands where the arrival put it: re-measuring now would chase the
    // target as the scene reacts to the click (a dialog leaving, panes reflowing).
    if (clickKey !== null && prior?.target === target && prior.on !== clickKey) return;
    reached.current = null;
    const measure = () => {
      const r = measureAnchor(el, anchor);
      if (!r) return false;
      reached.current = { target, on: clickKey };
      place({ x: r.x + r.width / 2 + dx, y: r.y + r.height / 2 + dy });
      return true;
    };
    measure();
    const timer = window.setTimeout(() => {
      if (!measure() && isDevBuild() && hasCanvasLayout(el)) {
        console.warn(`[tour] cursor target "${anchor}" is not rendered`);
      }
    }, ANCHOR_SETTLE_MS);
    // Not rendered yet — it mounts later in the step, or a seek lands back
    // where it's shown: retry once the scene has drawn each new moment.
    let frame = 0;
    const offTime = player.subscribeTime(() => {
      if (reached.current?.target === target) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    });
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      offTime();
    };
  }, [player, anchor, dx, dy, x, y, clickKey]);

  const point = anchor === null ? { x, y } : shown;
  return (
    <div
      ref={ref}
      aria-hidden="true"
      data-tour-cursor={anchor ?? undefined}
      className={cn(
        "pointer-events-none absolute left-0 top-0 z-40",
        "transition-[translate,opacity] duration-[450ms] ease-[cubic-bezier(0.45,0,0.2,1)] reduce-motion:transition-[opacity]",
        visible ? "opacity-100" : "opacity-0"
      )}
      style={{ translate: `${point.x}px ${point.y}px` }}
    >
      {clickKey !== null && (
        <span
          key={clickKey}
          className="tour-click-ring absolute -left-3 -top-3 size-6 rounded-full border-2 border-text-primary"
        />
      )}
      <MousePointer2
        className="relative size-4 fill-text-primary text-surface-canvas drop-shadow-sm"
        strokeWidth={1.5}
      />
      <span
        className={cn(
          "absolute left-4 top-3.5 whitespace-nowrap rounded-sm border border-border-strong bg-surface-panel-elevated px-1 py-px text-3xs font-medium text-text-primary transition-opacity duration-150 ease-out",
          modifier ? "opacity-100" : "opacity-0"
        )}
      >
        {modifier ?? ""}
      </span>
    </div>
  );
}

/** A soft outline drawn around the thing being talked about. */
export function MockFocusRing({ visible, className }: { visible: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -inset-1 rounded-lg border-2 border-text-secondary",
        "transition-opacity duration-200 ease-out",
        visible ? "opacity-60" : "opacity-0",
        className
      )}
    />
  );
}
