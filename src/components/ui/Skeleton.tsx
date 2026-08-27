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
        // `bg-tint/[0.08]`, not `bg-muted`. `--muted` is aliased to
        // `--theme-surface-panel` (src/index.css:734) and is never redefined by any
        // theme, so a bone painted with it is EXACTLY its own background on any panel
        // surface — all 15 themes — and on any dialog body on the 8 dark ones. The
        // pulse animates opacity only, so it cannot rescue a same-colour bone: the
        // composite is the background at every frame. `--theme-tint` is white on dark
        // and black on light, so an alpha tint contrasts with whatever it is laid over
        // by construction and cannot collide with a surface again.
        "bg-tint/[0.08] rounded",
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
            // Same surface collision as `SkeletonBone` — see the note there.
            "bg-tint/[0.08] rounded",
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

// First hint lands at 8s — NN/g's research puts the attention-break boundary at
// ~10s, so 8s preempts it with headroom while staying late enough not to draw
// attention to a delay the user would otherwise tolerate. Second and action
// thresholds keep a ~5s/~7s spacing above it so the ladder doesn't compress.
const DEFAULT_FIRST_THRESHOLD_MS = 8_000;
const DEFAULT_SECOND_THRESHOLD_MS = 13_000;
const DEFAULT_ACTION_THRESHOLD_MS = 20_000;

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

// A caller-supplied `message` (e.g. "Fetching 3 of 12 files…") replaces the
// generic copy at the first/second phases. The action phase always keeps the
// generic "Taking longer than usual…" — past the stall threshold that signal is
// accurate regardless of where the operation's own progress string sits.
function hintCopy(phase: HintPhase, message?: string): string {
  // Use the caller copy only when it carries non-whitespace content; a blank or
  // whitespace-only string falls back to the generic copy rather than rendering
  // an empty hint.
  const custom = message?.trim() ? message : undefined;
  if (phase === "first") return custom ?? FIRST_HINT_COPY;
  if (phase === "second") return custom ?? SECOND_HINT_COPY;
  if (phase === "action") return SECOND_HINT_COPY;
  return "";
}

function actionAffordanceCopy(showCancel: boolean, showRetry: boolean): string {
  if (showCancel && showRetry) return "Cancel and retry options available.";
  if (showCancel) return "Cancel option available.";
  if (showRetry) return "Retry option available.";
  return "";
}

// Announces the visible copy plus whichever affordances are currently surfaced.
// Receives the computed `showCancel`/`showRetry` flags (not raw handler
// presence) so Retry is never announced before it actually appears — Cancel
// surfaces at the first phase, Retry only at the action phase.
function liveRegionCopy(
  phase: HintPhase,
  showCancel: boolean,
  showRetry: boolean,
  message?: string
): string {
  const base = hintCopy(phase, message);
  if (phase === "hidden") return base;
  const action = actionAffordanceCopy(showCancel, showRetry);
  return action ? `${base} ${action}` : base;
}

export interface SkeletonHintProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "role" | "aria-live" | "children"
> {
  /** Delay before the first hint appears. Default 8000ms. */
  firstThreshold?: number;
  /** Delay before copy escalates to "Taking longer than usual…". Default 13000ms. */
  secondThreshold?: number;
  /** Delay before the Retry button surfaces (only when onRetry is passed). Default 20000ms. */
  actionThreshold?: number;
  /**
   * Caller-supplied status copy (e.g. "Fetching 3 of 12 files…"). When set, it
   * replaces the generic first/second-phase copy. The action phase still shows
   * the generic stall copy.
   */
  message?: string;
  /** When provided, a Cancel button surfaces with the first hint and fires this handler. */
  onCancel?: () => void;
  /** When provided, a Retry button appears at actionThreshold and fires this handler. */
  onRetry?: () => void;
}

/**
 * Companion to `<Skeleton>` for long-tail loads (>8s). Stays invisible until the
 * first threshold, then fades in escalating copy. A Cancel affordance surfaces
 * with the first hint (so the user can bail as soon as the wait registers);
 * Retry waits for the later action threshold, where "try again" is the
 * meaningful recovery. Place as a sibling to the `<Skeleton>` wrapper — never
 * nested inside, because the wrapper's `aria-busy="true"` silences mutations
 * within its subtree on modern screen readers.
 *
 * The sr-only span is always rendered so screen readers register the live
 * region up front; only its text content updates on phase change.
 */
export function SkeletonHint({
  firstThreshold,
  secondThreshold,
  actionThreshold,
  message,
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
  // Cancel surfaces as soon as the hint is visible; Retry stays gated to the
  // action threshold where re-trying is the meaningful recovery.
  const showCancel = phase !== "hidden" && hasCancel;
  const showRetry = phase === "action" && hasRetry;
  const visibleCopy = hintCopy(phase, message);

  // Key the visible row on its rendered state, not the raw phase. When phase
  // moves "second" → "action" with no handlers, the visible content is
  // identical, so React preserves the DOM node and the fade-in does NOT
  // re-fire. The key only changes when the user-visible content actually
  // changes (copy escalation, or a button surfacing). Cancel and Retry are
  // tracked independently so each one's appearance re-fires the fade.
  const visibleKey = `${visibleCopy}|${showCancel ? "cancel" : ""}|${showRetry ? "retry" : ""}`;

  return (
    <div {...rest} className={className}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveRegionCopy(phase, showCancel, showRetry, message)}
      </span>
      {phase !== "hidden" && (
        <div
          key={visibleKey}
          className="animate-hint-fade-in flex items-center gap-2 text-text-secondary text-xs"
        >
          <span aria-hidden="true">{visibleCopy}</span>
          {showCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} type="button">
              {CANCEL_LABEL}
            </Button>
          )}
          {showRetry && (
            <Button variant="ghost" size="sm" onClick={onRetry} type="button">
              {RETRY_LABEL}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
