import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { PluginRangeSliderProps } from "@shared/types/plugin-sdk-react";
import { cn } from "@/lib/utils";
import { clamp, field, finite, fn, nonEmpty, pickRootProps, positive, str } from "./kitProps";
import { safeFormat } from "./kitDiagnostics";
import { invalidProp, useKitFieldControl, focusLeft, useKitFocusScope } from "./kitField";

function decimalsOf(value: number): number {
  const text = String(value);
  // "2.5e-7": the mantissa's own places plus the exponent's.
  const scientific = /^[+-]?\d*(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (scientific) return Math.max(0, (scientific[1]?.length ?? 0) - Number(scientific[2]));
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/**
 * A range slider's values as steps from `lo`: `top` is the last step inside
 * the range, and `gap` the smallest number of steps between the thumbs, the
 * minimum distance rounded up so the thumbs are never closer than it.
 */
interface RangeGrid {
  lo: number;
  step: number;
  top: number;
  gap: number;
  places: number;
}

// A hair under a whole step, so float error in (hi - lo) / step does not lose one.
const STEP_EPSILON = 1e-9;

function rangeGrid(lo: number, hi: number, step: number, minDistance: number): RangeGrid {
  const top = Math.floor((hi - lo) / step + STEP_EPSILON);
  return {
    lo,
    step,
    top,
    gap: Math.min(top, Math.max(0, Math.ceil(minDistance / step - STEP_EPSILON))),
    places: Math.min(Math.max(decimalsOf(step), decimalsOf(lo)), 12),
  };
}

function valueAtStep(grid: RangeGrid, index: number): number {
  return Number((grid.lo + index * grid.step).toFixed(grid.places));
}

/** The nearest step to a value, inside the range. */
function stepOf(grid: RangeGrid, value: number): number {
  return clamp(Math.round((value - grid.lo) / grid.step), 0, grid.top);
}

/** A pair as steps: in order, inside the range, and at least the gap apart. */
function pairSteps(grid: RangeGrid, pair: readonly [number, number]): [number, number] {
  let a = stepOf(grid, pair[0]);
  let b = stepOf(grid, pair[1]);
  if (a > b) [a, b] = [b, a];
  if (b - a < grid.gap) {
    b = Math.min(grid.top, a + grid.gap);
    a = b - grid.gap;
  }
  return [a, b];
}

/** A pair in order, on steps, at least `minDistance` apart, and inside the range. */
export function normalizeRange(
  pair: readonly [number, number],
  lo: number,
  hi: number,
  step: number,
  minDistance: number
): [number, number] {
  const grid = rangeGrid(lo, hi, step, minDistance);
  const [a, b] = pairSteps(grid, pair);
  return [valueAtStep(grid, a), valueAtStep(grid, b)];
}

/** A plugin's formatter, made safe: a throw or a non-string reads as the number. */
function formatSafely(formatter: ((value: number) => string) | undefined, value: number): string {
  return safeFormat(formatter, value, String) || String(value);
}

/**
 * A slider's value readout, as wide as the widest text it can show: the ends'
 * texts sit invisibly in the same cell, so the track beside it keeps its size
 * when a drag passes 9 or 99, or a format grows from "5 s" to "15 s".
 */
export function SliderReadout({
  text,
  reserve,
  className,
}: {
  text: string;
  reserve: readonly string[];
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-slider-readout=""
      className={cn(
        "grid shrink-0 justify-items-end whitespace-nowrap text-xs tabular-nums text-text-secondary",
        className
      )}
    >
      {reserve.map((ghost, index) => (
        <span key={index} data-readout-reserve="" className="invisible [grid-area:1/1]">
          {ghost}
        </span>
      ))}
      <span className="[grid-area:1/1]">{text}</span>
    </span>
  );
}

function readPair(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const a = finite(value[0]);
  const b = finite(value[1]);
  return a === undefined || b === undefined ? undefined : [a, b];
}

function readMarks(value: unknown, lo: number, hi: number): { value: number; label?: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { value: number; label?: string }[] = [];
  for (const entry of value) {
    const at =
      typeof entry === "number"
        ? finite(entry)
        : typeof entry === "object" && entry !== null
          ? finite(field(entry, "value"))
          : undefined;
    if (at === undefined || at < lo || at > hi) continue;
    const label =
      typeof entry === "object" && entry !== null ? nonEmpty(field(entry, "label")) : undefined;
    out.push({ value: at, label });
  }
  return out;
}

const RANGE_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

// Slider's parts, drawn as elements rather than a native range's pseudo
// elements: the input-edge ink for the empty track, the primary ink for the
// span between the thumbs, and the thumb a field-coloured disc ringed in the
// primary ink. The track is inset half a thumb each side, so a thumb's centre
// sits on its value exactly as the native range's does.
const RANGE_THUMB =
  "absolute top-1/2 box-border size-4 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border-2 border-solid border-text-primary bg-surface-input focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary data-[dragging]:cursor-grabbing aria-disabled:cursor-not-allowed";

// The host tooltip's card, drawn in place over the thumb rather than portalled:
// it follows the thumb frame by frame while it moves.
const RANGE_TOOLTIP =
  "pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-md)] surface-overlay shadow-overlay px-2 py-1 text-xs tabular-nums text-text-primary";

export function KitRangeSlider(props: PluginRangeSliderProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    onValueCommit,
    min,
    max,
    step,
    minDistance,
    formatValue,
    showValue,
    marks,
    tooltip,
    thumbLabels,
    name,
    disabled,
    invalid,
    className,
  } = props;
  const onBlur = fn(props.onBlur);
  const rawLo = finite(min) ?? 0;
  const rawHi = finite(max) ?? 100;
  const [lo, hi] = rawHi > rawLo ? [rawLo, rawHi] : [0, 100];
  const stepBy = positive(step, hi - lo) ?? 1;
  const grid = rangeGrid(lo, hi, stepBy, finite(minDistance) ?? 0);
  const controlledPair = readPair(value);
  const [own, setOwn] = useState<[number, number]>(() => readPair(defaultValue) ?? [lo, hi]);
  const steps = pairSteps(grid, controlledPair ?? own);
  const current: [number, number] = [valueAtStep(grid, steps[0]), valueAtStep(grid, steps[1])];
  // Each thumb's reach: as far as the range's end and the other thumb allow.
  const bounds: [[number, number], [number, number]] = [
    [0, steps[1] - grid.gap],
    [steps[0] + grid.gap, grid.top],
  ];
  const onChange = fn(onValueChange);
  const onCommit = fn(onValueCommit);
  const formatter = fn(formatValue);
  const words = (n: number) => formatSafely(formatter, n);
  const inert = disabled === true;
  const names: [string, string] = [
    nonEmpty(Array.isArray(thumbLabels) ? thumbLabels[0] : undefined) ?? "Minimum",
    nonEmpty(Array.isArray(thumbLabels) ? thumbLabels[1] : undefined) ?? "Maximum",
  ];
  const [dragging, setDragging] = useState<0 | 1 | null>(null);
  const [focusVisible, setFocusVisible] = useState<0 | 1 | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  // Set while a press puts focus on a thumb: that focus shows no tooltip of
  // its own, since the drag is what shows it.
  const pointerFocus = useRef(false);
  const thumbRefs = useRef<(HTMLDivElement | null)[]>([]);
  // The pair this gesture last proposed. A controlled parent can lag a move
  // behind, so the gesture steps on from, and commits, what it proposed.
  const proposed = useRef<[number, number] | null>(null);
  const { invalid: shownInvalid, controlProps } = useKitFieldControl(
    props,
    invalidProp(invalid),
    false
  );
  const focusScope = useKitFocusScope();
  const tickList = readMarks(marks, lo, hi);
  const labelled = tickList.some((mark) => mark.label !== undefined);

  const frac = (n: number) => (n - lo) / (hi - lo);
  const position = (n: number) => `calc(0.5rem + (100% - 1rem) * ${frac(n)})`;

  /** Moves one thumb to a step, held between the range's end and the other thumb. */
  const moveThumb = (index: 0 | 1, targetStep: number) => {
    const base = proposed.current ? pairSteps(grid, proposed.current) : steps;
    const reach: [number, number] =
      index === 0 ? [0, base[1] - grid.gap] : [base[0] + grid.gap, grid.top];
    const nextSteps: [number, number] = [...base];
    nextSteps[index] = clamp(Math.round(targetStep), reach[0], reach[1]);
    const next: [number, number] = [
      valueAtStep(grid, nextSteps[0]),
      valueAtStep(grid, nextSteps[1]),
    ];
    const from: [number, number] = [valueAtStep(grid, base[0]), valueAtStep(grid, base[1])];
    proposed.current = next;
    if (next[0] !== from[0] || next[1] !== from[1]) {
      if (controlledPair === undefined) setOwn(next);
      onChange?.(next);
    }
  };

  const commit = () => {
    const pair = proposed.current ?? current;
    proposed.current = null;
    onCommit?.(pair);
  };

  const valueAt = (clientX: number): number => {
    const track = trackRef.current;
    if (!track) return lo;
    const rect = track.getBoundingClientRect();
    const inner = Math.max(1, rect.width - 16);
    return lo + clamp((clientX - rect.left - 8) / inner, 0, 1) * (hi - lo);
  };
  const stepAt = (clientX: number) => (valueAt(clientX) - lo) / stepBy;

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (inert || event.button !== 0) return;
    event.preventDefault();
    const target = valueAt(event.clientX);
    const [a, b] = current;
    // The nearer thumb; on a tie (thumbs together) the one on the press's side.
    const index: 0 | 1 =
      Math.abs(target - a) < Math.abs(target - b)
        ? 0
        : Math.abs(target - a) > Math.abs(target - b)
          ? 1
          : target < a
            ? 0
            : 1;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(index);
    pointerFocus.current = true;
    thumbRefs.current[index]?.focus({ preventScroll: true, focusVisible: false });
    pointerFocus.current = false;
    proposed.current = null;
    moveThumb(index, stepAt(event.clientX));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging === null) return;
    moveThumb(dragging, stepAt(event.clientX));
  };

  const endDrag = () => {
    if (dragging === null) return;
    setDragging(null);
    commit();
  };

  const onThumbKeyDown = (index: 0 | 1, event: KeyboardEvent<HTMLDivElement>) => {
    if (inert || !RANGE_KEYS.has(event.key)) return;
    event.preventDefault();
    const at = (proposed.current ? pairSteps(grid, proposed.current) : steps)[index];
    const deltas: Record<string, number> = {
      ArrowUp: 1,
      ArrowRight: 1,
      ArrowDown: -1,
      ArrowLeft: -1,
      PageUp: 10,
      PageDown: -10,
    };
    const target =
      event.key === "Home"
        ? bounds[index][0]
        : event.key === "End"
          ? bounds[index][1]
          : at + (deltas[event.key] ?? 0);
    moveThumb(index, target);
  };

  const showTip = tooltip !== "never";

  return (
    <div
      {...pickRootProps(props)}
      role="group"
      aria-label={str(props["aria-label"])}
      {...controlProps}
      aria-disabled={inert || undefined}
      data-slot="range-slider"
      onBlur={(event) => {
        if (focusLeft(event, focusScope.id)) onBlur?.();
      }}
      className={cn(
        "flex w-full min-w-0 items-center gap-3",
        inert && "opacity-50",
        str(className)
      )}
    >
      <div
        className={cn(
          "relative min-w-0 flex-1",
          // Room above for the value tooltip, held at rest too so nothing jumps
          // and the tooltip never covers the row's own words.
          showTip && "pt-7",
          labelled ? "pb-5" : tickList.length ? "pb-2" : ""
        )}
      >
        <div
          ref={trackRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          className={cn(
            "relative h-5 touch-none select-none",
            inert ? "cursor-not-allowed" : "cursor-pointer"
          )}
        >
          <div className="absolute inset-x-2 top-1/2 h-1 -translate-y-1/2 rounded-full bg-[var(--color-selection-outline)]" />
          <div
            data-slot="range-fill"
            className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-text-primary"
            style={{ left: position(current[0]), right: `calc(100% - ${position(current[1])})` }}
          />
          {([0, 1] as const).map((index) => {
            const at = current[index];
            const spoken = words(at);
            const tipShown = showTip && (dragging === index || focusVisible === index);
            return (
              <div
                key={index}
                ref={(el) => {
                  thumbRefs.current[index] = el;
                }}
                role="slider"
                tabIndex={inert ? -1 : 0}
                aria-label={names[index]}
                aria-valuemin={valueAtStep(grid, bounds[index][0])}
                aria-valuemax={valueAtStep(grid, bounds[index][1])}
                aria-valuenow={at}
                aria-valuetext={formatter ? spoken : undefined}
                aria-orientation="horizontal"
                aria-disabled={inert || undefined}
                data-dragging={dragging === index ? "" : undefined}
                onKeyDown={(event) => onThumbKeyDown(index, event)}
                onKeyUp={(event) => {
                  if (!inert && RANGE_KEYS.has(event.key)) commit();
                }}
                onFocus={() => {
                  if (!pointerFocus.current) setFocusVisible(index);
                }}
                onBlur={() => {
                  setFocusVisible(null);
                  // A key gesture whose key-up never came (focus moved mid-press) ends here.
                  if (dragging === null && proposed.current !== null) commit();
                }}
                className={cn(RANGE_THUMB, shownInvalid && "border-status-error")}
                // The later thumb sits on top where they meet, unless the first is held.
                style={{ left: position(at), zIndex: dragging === index ? 3 : index + 1 }}
              >
                {tipShown ? (
                  <span aria-hidden="true" className={RANGE_TOOLTIP}>
                    {spoken}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        {tickList.length > 0 ? (
          // Under the track, wherever the tooltip's room puts it.
          <div
            aria-hidden="true"
            className={cn("absolute inset-x-0 h-4", showTip ? "top-12" : "top-5")}
          >
            {tickList.map((mark) => (
              <span
                key={mark.value}
                className="absolute top-0 flex -translate-x-1/2 flex-col items-center gap-0.5"
                style={{ left: position(mark.value) }}
              >
                <span className="h-1.5 w-px bg-border-strong" />
                {mark.label ? (
                  <span className="whitespace-nowrap text-2xs tabular-nums text-text-secondary">
                    {mark.label}
                  </span>
                ) : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {showValue === true ? (
        <SliderReadout
          text={`${words(current[0])} – ${words(current[1])}`}
          reserve={[
            `${words(lo)} – ${words(lo)}`,
            `${words(lo)} – ${words(hi)}`,
            `${words(hi)} – ${words(lo)}`,
            `${words(hi)} – ${words(hi)}`,
          ]}
        />
      ) : null}
      {nonEmpty(name) ? (
        <>
          <input type="hidden" name={name} value={current[0]} disabled={inert} />
          <input type="hidden" name={name} value={current[1]} disabled={inert} />
        </>
      ) : null}
    </div>
  );
}
