import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Geometry and tone for a status pill. Presentation only — a badge that needs to
 * be clicked belongs inside a real `<button>`, so the interactive element keeps
 * its own semantics and a tooltip trigger has something to attach to.
 *
 * `rounded-sm` (6px), never the repo's bare `rounded` (10px): at pill height
 * that reads as a lozenge and loses the badge's squared-off edge.
 *
 * Forced colors paints every fill as Canvas, which would leave two neighbouring
 * tags reading as one run of words, so each keeps a border there.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center whitespace-nowrap font-medium transition-colors duration-150 ease-out [&_svg]:shrink-0 forced-colors:border forced-colors:border-[CanvasText]",
  {
    variants: {
      size: {
        xs: "gap-1 px-1.5 py-0.5 text-3xs [&_svg]:w-2.5 [&_svg]:h-2.5",
        sm: "gap-1 px-1.5 py-0.5 text-xs [&_svg]:w-3 [&_svg]:h-3",
        md: "gap-1.5 px-2 py-1 text-sm leading-[inherit] [&_svg]:w-3.5 [&_svg]:h-3.5",
      },
      tone: {
        neutral: "bg-overlay-subtle text-text-secondary",
        /** Hairline-bordered wash for badges that sit on a busy surface. */
        outline: "bg-tint/[0.07] border border-tint/[0.08] text-text-secondary",
        error: "bg-status-error/10 text-status-error",
        warning: "bg-status-warning/10 text-status-warning",
        success: "bg-status-success/10 text-status-success",
        info: "bg-status-info/10 text-status-info",
      },
      shape: {
        default: "rounded-sm",
        pill: "rounded-full",
      },
    },
    defaultVariants: {
      size: "sm",
      tone: "neutral",
      shape: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  ref?: React.Ref<HTMLSpanElement>;
}

// No `asChild`: it would pull `@radix-ui/react-slot` into the eager graph
// (#7659) to serve an interactive badge, and an interactive badge should be a
// real `<button>` wrapping this one anyway.
function Badge({ className, size, tone, shape, ref, ...props }: BadgeProps) {
  return (
    <span
      ref={ref}
      className={cn(badgeVariants({ size, tone, shape }), className)}
      {...props}
      // After the spread: these report what the variants actually painted, so a
      // stray `data-tone` at a call site cannot make the markup lie.
      data-slot="badge"
      data-size={size ?? "sm"}
      data-tone={tone ?? "neutral"}
    />
  );
}

/**
 * A number beside the thing it counts: a section's files, a coalesced toast, a
 * settings search's matches. Round and tabular so it reads as a tally and not
 * as a word badge, and so a count that ticks from 9 to 10 does not shift its
 * neighbours by a digit's width. One fill for every count, so no header looks
 * more urgent than the next because its chip was tinted differently.
 *
 * `normal-case tracking-normal` because a count often sits inside an uppercase
 * section label and must not inherit its tracking.
 *
 * Forced colors paints the fill as Canvas and would leave a bare numeral
 * running on from its label, so the pill keeps a border there — the same fix
 * the inbox count already had in `index.css`.
 *
 * A bare numeral is not an accessible name, and an `aria-label` on a plain
 * span is not exposed. Pass `label` ("3 plugins") and the numeral becomes
 * visual only while the label is what a screen reader says.
 */
const COUNT_BADGE_CLASS =
  "inline-flex shrink-0 items-center justify-center rounded-full bg-tint/10 px-1.5 py-0.5 text-3xs font-medium leading-none tabular-nums normal-case tracking-normal text-text-secondary forced-colors:border forced-colors:border-[CanvasText]";

type CountBadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  ref?: React.Ref<HTMLSpanElement>;
  /** What the count means, spoken in place of the bare numeral. */
  label?: string;
};

function CountBadge({ className, ref, label, children, ...props }: CountBadgeProps) {
  // `data-slot` after the spread for the same reason as `Badge`.
  return (
    <span ref={ref} className={cn(COUNT_BADGE_CLASS, className)} {...props} data-slot="count-badge">
      {label === undefined ? (
        children
      ) : (
        <>
          <span aria-hidden="true">{children}</span>
          <span className="sr-only">{label}</span>
        </>
      )}
    </span>
  );
}

export { Badge, badgeVariants, CountBadge, COUNT_BADGE_CLASS };
