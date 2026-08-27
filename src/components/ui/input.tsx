import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { useFieldControl } from "@/components/ui/field";

/**
 * `density`, not `size`: `size` is a real attribute on `<input>` and shadowing
 * it would quietly drop the native one.
 */
const inputVariants = cva(
  "w-full bg-surface-input border border-border-strong rounded-[var(--radius-md)] text-text-primary placeholder:text-text-placeholder transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      density: {
        compact: "px-2 py-1 text-xs",
        default: "px-3 py-1.5 text-sm",
      },
      invalid: {
        true: "border-status-error",
        false: "",
      },
    },
    defaultVariants: {
      density: "default",
      invalid: false,
    },
  }
);

export interface InputProps
  extends
    React.ComponentPropsWithoutRef<"input">,
    Omit<VariantProps<typeof inputVariants>, "invalid"> {
  /** Overrides the enclosing `Field`'s state when given. */
  invalid?: boolean;
  ref?: React.Ref<HTMLInputElement>;
}

function Input({ className, density, invalid, ref, ...props }: InputProps) {
  const { invalid: resolvedInvalid, controlProps } = useFieldControl(props, invalid);

  return (
    <input
      ref={ref}
      {...props}
      {...controlProps}
      data-slot="input"
      data-density={density ?? "default"}
      className={cn(inputVariants({ density, invalid: resolvedInvalid }), className)}
    />
  );
}

export { Input, inputVariants };
