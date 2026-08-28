import { useLayoutEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";

const ELLIPSIS = "...";
/** Subpixel slack, so the browser never adds a second ellipsis on top of ours. */
const FIT_SLACK = 2;

let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    measureCtx = document.createElement("canvas").getContext("2d");
  }
  return measureCtx;
}

/** Canvas wants the `font` shorthand, and `getComputedStyle().font` is empty in Chromium. */
function cssFont(el: HTMLElement): string {
  const s = getComputedStyle(el);
  return `${s.fontStyle} ${s.fontWeight} ${s.fontSize} / ${s.lineHeight} ${s.fontFamily}`;
}

function textWidth(text: string, font: string): number {
  const ctx = getMeasureCtx();
  if (!ctx) return 0;
  ctx.font = font;
  return ctx.measureText(text).width;
}

let segmenter: Intl.Segmenter | undefined;

/**
 * Graphemes, not UTF-16 units: git allows UTF-8 refs, and slicing by index
 * splits a surrogate pair — or a ZWJ emoji, or a combining mark — in half.
 */
function graphemes(value: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(value), (s) => s.segment);
}

/**
 * Longest middle-cropped form of `value` that fits `budget` px — binary search
 * over how many graphemes survive, so the head and tail stay balanced. Width is
 * treated as monotonic in that count, which shaping and ligatures can violate;
 * the cost of a violation is a slightly short crop, never one over budget.
 */
export function fitMiddle(value: string, budget: number, font: string): string {
  if (textWidth(value, font) <= budget) return value;
  // Nothing honest fits. Rendering the marker anyway would overflow and get
  // hard-clipped, which is the malformed output this component exists to avoid.
  if (textWidth(ELLIPSIS, font) > budget) return "";

  const chars = graphemes(value);
  let lo = 0;
  let hi = chars.length - 1;
  let best = ELLIPSIS;

  while (lo <= hi) {
    const keep = (lo + hi) >> 1;
    const front = Math.ceil(keep / 2);
    const back = keep - front;
    const candidate =
      chars.slice(0, front).join("") + ELLIPSIS + chars.slice(chars.length - back).join("");

    if (textWidth(candidate, font) <= budget) {
      best = candidate;
      lo = keep + 1;
    } else {
      hi = keep - 1;
    }
  }

  return best;
}

/** One branch name: cropped on screen, whole to a screen reader and on hover. */
function BranchName({
  value,
  display,
  className,
}: {
  value: string;
  display: string;
  className?: string;
}) {
  const isCropped = display !== value;

  return (
    <TruncatedTooltip
      content={value}
      isTruncated={isCropped || undefined}
      side="top"
      // A branch name has no spaces to break on, so tooltip content would clip
      // at its own max-width and hide the tail this tooltip exists to reveal.
      contentClassName="[overflow-wrap:anywhere] whitespace-normal"
    >
      <span
        data-branch-name
        className={cn("overflow-hidden whitespace-nowrap font-mono", className)}
      >
        {isCropped ? (
          <>
            {/* The visible text is lossy, so the whole name is what gets announced. */}
            <span className="sr-only">{value}</span>
            <span aria-hidden="true">{display}</span>
          </>
        ) : (
          value
        )}
      </span>
    </TruncatedTooltip>
  );
}

interface BranchSummaryProps {
  /** Omitted in existing-branch mode, where there is no base to show. */
  base?: string;
  branch: string;
  icon?: React.ReactNode;
}

/**
 * The dialog footer's `base → branch` echo, cropped to the width it actually
 * has. A fixed character budget cannot do this: the two names share one row, so
 * a budget generous enough for a short base double-crops when both are long —
 * once in JS and again by `text-overflow`, which reads as `feature/...ne…`.
 *
 * So the pixels get measured and split instead. This relies on the footer hint
 * being `flex-1`: that makes this box's width a function of the dialog rather
 * than of its own text, which is what keeps the measure-then-crop from chasing
 * its own tail.
 */
export function BranchSummary({ base, branch, icon }: BranchSummaryProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const [fitted, setFitted] = useState<{ base: string; branch: string }>({
    base: base ?? "",
    branch,
  });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const apply = () => {
      const names = root.querySelectorAll<HTMLElement>("[data-branch-name]");
      const sample = names[0];
      const whole = { base: base ?? "", branch };
      if (!sample || !getMeasureCtx()) {
        setFitted(whole);
        return;
      }

      // Everything that is not a name holds its size: icon, arrow, and the gaps
      // between all of them. What is left is the two names' to share.
      const style = getComputedStyle(root);
      const gap = parseFloat(style.columnGap) || 0;
      const kids = Array.from(root.children);
      // getBoundingClientRect, not offsetWidth: the arrow is an SVG, and SVG
      // elements have no offsetWidth, so that reads undefined and poisons the
      // whole budget with NaN — which crops every name to a bare ellipsis.
      const reserved = kids
        .filter((kid) => !kid.hasAttribute("data-branch-name"))
        .reduce((sum, kid) => sum + kid.getBoundingClientRect().width, 0);
      const available =
        root.clientWidth - reserved - gap * Math.max(0, kids.length - 1) - FIT_SLACK;

      if (!Number.isFinite(available) || available <= 0) {
        setFitted(whole);
        return;
      }

      const font = cssFont(sample);
      const baseWidth = base ? textWidth(base, font) : 0;
      const branchWidth = textWidth(branch, font);
      const total = baseWidth + branchWidth;

      if (total <= available || total <= 0) {
        setFitted(whole);
        return;
      }

      // Max-min fair: an equal share each, and whatever one name does not need
      // passes to the other. Splitting the space in proportion to length looks
      // reasonable and is not — it crushed a base of "develop" down to "d...p"
      // to subsidise a long name that already had room to spare.
      const half = available / 2;
      let baseBudget = half;
      let branchBudget = half;
      if (baseWidth <= half) {
        baseBudget = baseWidth;
        branchBudget = available - baseWidth;
      } else if (branchWidth <= half) {
        branchBudget = branchWidth;
        baseBudget = available - branchWidth;
      }

      setFitted({
        base: base ? fitMiddle(base, baseBudget, font) : "",
        branch: fitMiddle(branch, branchBudget, font),
      });
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(root);

    // The observer only sees the box, and the box is flex-sized — so a late
    // JetBrains Mono swap changes every glyph width without ever resizing it,
    // leaving a crop measured against the fallback's metrics.
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive && rootRef.current) apply();
    });

    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [base, branch]);

  return (
    <span ref={rootRef} className="flex min-w-0 flex-1 items-center gap-1">
      {icon}
      {base !== undefined && (
        <>
          <BranchName value={base} display={fitted.base} />
          <ArrowRight className="w-3 h-3 shrink-0" aria-hidden="true" />
        </>
      )}
      <BranchName value={branch} display={fitted.branch} className="text-text-primary" />
    </span>
  );
}
