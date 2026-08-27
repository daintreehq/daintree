import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon, MinusIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useFieldControl } from "@/components/ui/field";

/**
 * Checked is painted with the text colour, not the accent: a checkbox marks
 * membership, and the accent is reserved for the one load-bearing signal in a
 * focus region. `rounded-sm` (6px) rather than the repo's bare `rounded` (10px),
 * which on a 16px box rounds far enough to read as a radio.
 *
 * The unchecked fill is `surface-canvas`, not the `surface-input` the text
 * fields use. On dark themes `surface-input` derives from
 * `surface-panel-elevated`, which several palettes (Galapagos) also give the
 * settings dialog — the box would dissolve into the surface it sits on, leaving
 * a 20%-alpha border as the only edge. Canvas is the recessed surface in every
 * bundled theme, so a 16px box keeps a boundary wherever it is dropped.
 */
const checkboxVariants = cva(
  "group relative flex shrink-0 items-center justify-center border border-border-strong bg-surface-canvas transition-colors duration-150 ease-out " +
    "data-[state=checked]:bg-text-primary data-[state=checked]:border-text-primary " +
    "data-[state=indeterminate]:bg-text-primary data-[state=indeterminate]:border-text-primary " +
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-daintree-accent " +
    "disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      size: {
        sm: "w-3.5 h-3.5 rounded-[var(--radius-xs)] [&_svg]:w-2.5 [&_svg]:h-2.5",
        md: "w-4 h-4 rounded-sm [&_svg]:w-3 [&_svg]:h-3",
      },
      invalid: {
        true: "border-status-error data-[state=checked]:border-status-error data-[state=indeterminate]:border-status-error",
        false: "",
      },
    },
    defaultVariants: {
      size: "md",
      invalid: false,
    },
  }
);

export interface CheckboxProps
  extends
    React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>,
    Omit<VariantProps<typeof checkboxVariants>, "invalid"> {
  /** Overrides the enclosing `Field`'s state when given. */
  invalid?: boolean;
  ref?: React.Ref<React.ComponentRef<typeof CheckboxPrimitive.Root>>;
}

function Checkbox({ className, size, invalid, ref, ...props }: CheckboxProps) {
  const { invalid: resolvedInvalid, controlProps } = useFieldControl(props, invalid);

  return (
    <CheckboxPrimitive.Root
      ref={ref}
      {...props}
      {...controlProps}
      data-slot="checkbox"
      data-size={size ?? "md"}
      className={cn(checkboxVariants({ size, invalid: resolvedInvalid }), className)}
    >
      <CheckboxPrimitive.Indicator className="animate-checkbox-check flex h-full w-full items-center justify-center text-text-inverse">
        {/* Both glyphs render; the root's data-state picks which one shows, so
            neither icon needs the parent to re-render to swap. */}
        <CheckIcon className="group-data-[state=indeterminate]:hidden" aria-hidden="true" />
        <MinusIcon className="hidden group-data-[state=indeterminate]:block" aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox, checkboxVariants };
