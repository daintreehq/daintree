import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * Geometry and tone for a status pill. Presentation only — a badge that needs to
 * be clicked belongs inside a real `<button>`, so the interactive element keeps
 * its own semantics and a tooltip trigger has something to attach to.
 *
 * `rounded-sm` (6px), never the repo's bare `rounded` (10px): at pill height
 * that reads as a lozenge and loses the badge's squared-off edge.
 */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center whitespace-nowrap font-medium transition-colors duration-150 ease-out [&_svg]:shrink-0",
  {
    variants: {
      size: {
        xs: "gap-1 px-1.5 py-0.5 text-[10px] [&_svg]:w-2.5 [&_svg]:h-2.5",
        sm: "gap-1 px-1.5 py-0.5 text-xs [&_svg]:w-3 [&_svg]:h-3",
        md: "gap-1.5 px-2 py-1 text-[13px] [&_svg]:w-3.5 [&_svg]:h-3.5",
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
  asChild?: boolean;
  ref?: React.Ref<HTMLSpanElement>;
}

function Badge({ className, size, tone, shape, asChild = false, ref, ...props }: BadgeProps) {
  const Comp = asChild ? Slot : "span";

  return (
    <Comp
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

export { Badge, badgeVariants };
