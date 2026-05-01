import { useEffect, useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const TEXT_LINE_WIDTHS = ["w-full", "w-3/4", "w-1/2"] as const;
const MAX_TEXT_LINES = 100;

function pulseClass(immediate: boolean): string {
  return immediate ? "animate-pulse-immediate" : "animate-pulse-delayed";
}

function clampLines(lines: number): number {
  if (!Number.isFinite(lines)) return 0;
  return Math.min(Math.max(0, Math.floor(lines)), MAX_TEXT_LINES);
}

function safeHeightPx(value: number | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) return undefined;
  return `${value}px`;
}

export interface SkeletonProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "role" | "aria-live" | "aria-busy"
> {
  /** Accessible label announced to assistive tech. Defaults to "Loading". */
  label?: string;
  /**
   * Children compose the bones. Each bone should be `aria-hidden` — `<SkeletonBone>`
   * and `<SkeletonText>` already are. Apply layout classes (`flex`, `grid`, `space-y-*`)
   * on `className` here; the wrapper is the only DOM element.
   */
  children?: ReactNode;
  /** Hide the wrapper from AT (e.g., when nested in another `role="status"`). */
  inert?: boolean;
}

/**
 * ARIA status wrapper for loading skeletons. Owns `role="status"`, `aria-live="polite"`,
 * `aria-busy="true"`, and an sr-only label. The sr-only span is absolutely positioned
 * and takes no layout space, so flex/grid classes on `className` apply directly to the
 * bone children.
 */
export function Skeleton({
  label = "Loading",
  children,
  inert = false,
  className,
  ...rest
}: SkeletonProps) {
  if (inert) {
    return (
      <div {...rest} aria-hidden="true" className={className}>
        {children}
      </div>
    );
  }

  return (
    <div
      {...rest}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={className}
    >
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export interface SkeletonBoneProps extends Omit<HTMLAttributes<HTMLDivElement>, "aria-hidden"> {
  /** Skip the 400ms anti-flicker delay; bone is visible immediately. */
  immediate?: boolean;
  /** Layer a transform-based shimmer sweep on top of the opacity pulse. */
  shimmer?: boolean;
  /** Set a fixed pixel height to prevent layout shift when content loads. */
  heightPx?: number;
}

/**
 * Single skeleton bone. `aria-hidden` and class-merged so callers can size it freely.
 * Default animation is the 400ms-delayed opacity pulse; `shimmer` adds a sweep.
 * `heightPx` wins over an explicit `style.height` to keep the layout-shift contract.
 */
export function SkeletonBone({
  immediate = false,
  shimmer = false,
  heightPx,
  className,
  style,
  ...rest
}: SkeletonBoneProps) {
  const height = safeHeightPx(heightPx);
  const merged: CSSProperties | undefined = height !== undefined ? { ...style, height } : style;

  return (
    <div
      {...rest}
      aria-hidden="true"
      className={cn(
        "bg-muted rounded",
        pulseClass(immediate),
        shimmer && "animate-skeleton-shimmer",
        className
      )}
      style={merged}
    />
  );
}

export interface SkeletonTextProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "aria-hidden"
> {
  /** Number of text lines. Clamped to [0, 100]; defaults to 3. */
  lines?: number;
  /** Skip the 400ms anti-flicker delay. */
  immediate?: boolean;
  /** Layer the shimmer sweep on each line. */
  shimmer?: boolean;
  /** Tailwind height class for each line. Defaults to `h-4`. */
  lineHeightClassName?: string;
  /** Vertical gap between lines. Defaults to `space-y-2`. */
  gapClassName?: string;
}

/**
 * Multi-line text skeleton. Cycles widths through `[w-full, w-3/4, w-1/2]` to mimic
 * ragged-right typography (uniform widths look like a picket fence).
 */
export function SkeletonText({
  lines = 3,
  immediate = false,
  shimmer = false,
  lineHeightClassName = "h-4",
  gapClassName = "space-y-2",
  className,
  ...rest
}: SkeletonTextProps) {
  const count = clampLines(lines);

  return (
    <div {...rest} aria-hidden="true" className={cn(gapClassName, className)}>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className={cn(
            "bg-muted rounded",
            lineHeightClassName,
            TEXT_LINE_WIDTHS[i % TEXT_LINE_WIDTHS.length],
            pulseClass(immediate),
            shimmer && "animate-skeleton-shimmer"
          )}
        />
      ))}
    </div>
  );
}

const DEFAULT_FIRST_THRESHOLD_MS = 5_000;
const DEFAULT_SECOND_THRESHOLD_MS = 10_000;
const DEFAULT_ACTION_THRESHOLD_MS = 15_000;

const FIRST_HINT_COPY = "Still working…";
const SECOND_HINT_COPY = "Taking longer than usual…";
const CANCEL_LABEL = "Cancel";
const RETRY_LABEL = "Retry";

type HintPhase = "hidden" | "first" | "second" | "action";

function safeThreshold(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) return fallback;
  return value;
}

function hintCopy(phase: HintPhase): string {
  if (phase === "first") return FIRST_HINT_COPY;
  if (phase === "second" || phase === "action") return SECOND_HINT_COPY;
  return "";
}

function actionAffordanceCopy(hasCancel: boolean, hasRetry: boolean): string {
  if (hasCancel && hasRetry) return "Cancel and retry options available.";
  if (hasCancel) return "Cancel option available.";
  if (hasRetry) return "Retry option available.";
  return "";
}

function liveRegionCopy(phase: HintPhase, hasCancel: boolean, hasRetry: boolean): string {
  const base = hintCopy(phase);
  if (phase !== "action") return base;
  const action = actionAffordanceCopy(hasCancel, hasRetry);
  return action ? `${base} ${action}` : base;
}

export interface SkeletonHintProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "role" | "aria-live" | "children"
> {
  /** Delay before "Still working…" appears. Default 5000ms. */
  firstThreshold?: number;
  /** Delay before copy escalates to "Taking longer than usual…". Default 10000ms. */
  secondThreshold?: number;
  /** Delay before Cancel/Retry buttons surface (only when handlers are passed). Default 15000ms. */
  actionThreshold?: number;
  /** When provided, a Cancel button appears at actionThreshold and fires this handler. */
  onCancel?: () => void;
  /** When provided, a Retry button appears at actionThreshold and fires this handler. */
  onRetry?: () => void;
}

/**
 * Companion to `<Skeleton>` for long-tail loads (>5s). Stays invisible until the
 * first threshold, then fades in escalating copy and surfaces a Cancel/Retry
 * affordance at the action threshold. Place as a sibling to the `<Skeleton>`
 * wrapper — never nested inside, because the wrapper's `aria-busy="true"`
 * silences mutations within its subtree on modern screen readers.
 *
 * The sr-only span is always rendered so screen readers register the live
 * region up front; only its text content updates on phase change.
 */
export function SkeletonHint({
  firstThreshold,
  secondThreshold,
  actionThreshold,
  onCancel,
  onRetry,
  className,
  ...rest
}: SkeletonHintProps) {
  const [phase, setPhase] = useState<HintPhase>("hidden");

  // Clamp thresholds to monotonic ascending order so a misconfigured prop (e.g.
  // actionThreshold smaller than the default secondThreshold) can't make the
  // phase walk backward when the later setTimeout fires.
  const first = safeThreshold(firstThreshold, DEFAULT_FIRST_THRESHOLD_MS);
  const second = Math.max(first, safeThreshold(secondThreshold, DEFAULT_SECOND_THRESHOLD_MS));
  const action = Math.max(second, safeThreshold(actionThreshold, DEFAULT_ACTION_THRESHOLD_MS));

  useEffect(() => {
    const ids: ReturnType<typeof setTimeout>[] = [
      setTimeout(() => setPhase("first"), first),
      setTimeout(() => setPhase("second"), second),
      setTimeout(() => setPhase("action"), action),
    ];
    return () => {
      for (const id of ids) clearTimeout(id);
    };
  }, [first, second, action]);

  const hasCancel = onCancel !== undefined;
  const hasRetry = onRetry !== undefined;
  const visibleCopy = hintCopy(phase);
  const showActions = phase === "action" && (hasCancel || hasRetry);

  // Key the visible row on its rendered state, not the raw phase. When phase
  // moves "second" → "action" with no handlers, the visible content is
  // identical, so React preserves the DOM node and the fade-in does NOT
  // re-fire. The key only changes when the user-visible content actually
  // changes (copy escalation, or buttons appearing).
  const visibleKey = `${visibleCopy}|${showActions ? "actions" : "noactions"}`;

  return (
    <div {...rest} className={className}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveRegionCopy(phase, hasCancel, hasRetry)}
      </span>
      {phase !== "hidden" && (
        <div
          key={visibleKey}
          className="animate-hint-fade-in flex items-center gap-2 text-text-secondary text-xs"
        >
          <span aria-hidden="true">{visibleCopy}</span>
          {showActions && hasCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} type="button">
              {CANCEL_LABEL}
            </Button>
          )}
          {showActions && hasRetry && (
            <Button variant="ghost" size="sm" onClick={onRetry} type="button">
              {RETRY_LABEL}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
