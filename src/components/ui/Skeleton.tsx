import type { CSSProperties, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

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
