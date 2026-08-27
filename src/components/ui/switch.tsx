import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { useFieldControl } from "@/components/ui/field";

/**
 * The OFF state deliberately does not paint the thumb with a solid high-contrast
 * fill: a filled circle in a pale track reads as an illuminated "on" indicator.
 * The solid fill belongs to the ON track; the OFF thumb is a mid-tone, and the
 * OFF track carries its own boundary so the control stays discernible against
 * the page (WCAG 1.4.11).
 *
 * An inset ring rather than a border — `border` would shrink the track's content
 * box and shift the checked thumb 2px off its resting inset.
 */
const switchVariants = cva(
  "relative inline-flex shrink-0 items-center rounded-full bg-surface-input ring-1 ring-inset ring-border-strong transition-colors duration-200 ease-out " +
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 " +
    "disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      size: {
        sm: "w-9 h-5",
        md: "w-11 h-6",
      },
      tone: {
        // Neutral, not accent: "on" is state, not the one load-bearing signal.
        neutral:
          "data-[state=checked]:bg-text-primary data-[state=checked]:ring-0 focus-visible:outline-daintree-accent",
        warning:
          "data-[state=checked]:bg-status-warning data-[state=checked]:ring-0 focus-visible:outline-status-warning",
        danger:
          "data-[state=checked]:bg-status-error data-[state=checked]:ring-0 focus-visible:outline-status-error",
      },
    },
    defaultVariants: {
      size: "md",
      tone: "neutral",
    },
  }
);

// Faster than the track and on a different curve: the thumb's travel is what the
// eye follows, the track's tint is what settles behind it.
const switchThumbVariants = cva(
  "block rounded-full bg-text-muted shadow-sm transition-transform duration-100 ease-[var(--ease-out-expo)] data-[state=checked]:bg-text-inverse",
  {
    variants: {
      size: {
        sm: "w-3.5 h-3.5 translate-x-[3px] data-[state=checked]:translate-x-[19px]",
        md: "w-4 h-4 translate-x-1 data-[state=checked]:translate-x-6",
      },
    },
    defaultVariants: {
      size: "md",
    },
  }
);

// This component supplies its own Thumb, so Radix's `asChild` would slot the
// trigger onto that inner span — a switch that cannot take focus — and a
// caller's `children` would be dropped. Neither belongs on the public surface.
type SwitchRootProps = Omit<
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>,
  "asChild" | "children"
>;

export interface SwitchProps extends SwitchRootProps, VariantProps<typeof switchVariants> {
  ref?: React.Ref<React.ComponentRef<typeof SwitchPrimitive.Root>>;
}

function Switch({ className, size, tone, ref, ...props }: SwitchProps) {
  const resolvedSize = size ?? "md";
  const { controlProps } = useFieldControl(props);

  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(switchVariants({ size, tone }), className)}
      {...props}
      {...controlProps}
      data-slot="switch"
      data-size={resolvedSize}
      data-tone={tone ?? "neutral"}
    >
      <SwitchPrimitive.Thumb className={switchThumbVariants({ size: resolvedSize })} />
    </SwitchPrimitive.Root>
  );
}

export { Switch, switchVariants, switchThumbVariants };
