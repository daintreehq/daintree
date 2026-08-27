import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * The frame only. Header composition already belongs to `SurfaceHeader`, so
 * there is no `CardHeader`/`CardTitle` here — a card with a header is
 * `<Card padding="none"><SurfaceHeader …/>…</Card>`, which keeps one header
 * implementation instead of two that drift.
 */
const cardVariants = cva("rounded-[var(--radius-lg)] border", {
  variants: {
    variant: {
      default: "border-border-default bg-surface-panel",
      /** Recedes: nested groups, read-only detail blocks. */
      subtle: "border-border-subtle bg-surface-inset",
      /** Lifts off the page: floating panels, anything over a scrim. */
      elevated:
        "border-border-strong bg-surface-panel-elevated shadow-[var(--theme-shadow-ambient)]",
    },
    padding: {
      none: "",
      sm: "p-3",
      md: "p-4",
      lg: "p-6",
    },
    interactive: {
      true: "transition-[background-color,border-color] duration-150 ease-out hover:bg-overlay-subtle hover:border-border-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2",
      false: "",
    },
  },
  defaultVariants: {
    variant: "default",
    padding: "md",
    interactive: false,
  },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {
  ref?: React.Ref<HTMLDivElement>;
}

// No `asChild`: it would pull `@radix-ui/react-slot` into the eager graph
// (#7659) for an affordance nothing needs yet. A whole-card button can wrap
// this one, or `asChild` can be added back alongside the call site that wants it.
function Card({ className, variant, padding, interactive, ref, ...props }: CardProps) {
  return (
    <div
      ref={ref}
      className={cn(cardVariants({ variant, padding, interactive }), className)}
      {...props}
      data-slot="card"
      data-variant={variant ?? "default"}
      data-padding={padding ?? "md"}
    />
  );
}

export { Card, cardVariants };
