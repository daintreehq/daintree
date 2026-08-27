import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { useFieldControl } from "@/components/ui/field";

/**
 * Its own component rather than an `Input multiline` mode: the element type
 * decides the ref type, the value/rows props and half the event surface, so a
 * polymorphic version would make every one of those a union the consumer has to
 * narrow.
 */
const textareaVariants = cva(
  "w-full bg-surface-input border border-border-strong rounded-[var(--radius-md)] text-text-primary placeholder:text-text-placeholder transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed",
  {
    variants: {
      density: {
        compact: "px-2.5 py-1.5",
        default: "px-3 py-2",
      },
      variant: {
        default: "text-sm",
        /** Paths, prompts, JSON — anything the user reads character by character. */
        code: "font-mono text-xs",
      },
      resize: {
        vertical: "resize-y",
        none: "resize-none",
      },
      invalid: {
        true: "border-status-error",
        false: "",
      },
    },
    defaultVariants: {
      density: "default",
      variant: "default",
      resize: "vertical",
      invalid: false,
    },
  }
);

export interface TextareaProps
  extends
    React.ComponentPropsWithoutRef<"textarea">,
    Omit<VariantProps<typeof textareaVariants>, "invalid"> {
  /** Overrides the enclosing `Field`'s state when given. */
  invalid?: boolean;
  ref?: React.Ref<HTMLTextAreaElement>;
}

function Textarea({ className, density, variant, resize, invalid, ref, ...props }: TextareaProps) {
  const { invalid: resolvedInvalid, controlProps } = useFieldControl(props, invalid);

  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      data-density={density ?? "default"}
      {...props}
      {...controlProps}
      className={cn(
        textareaVariants({ density, variant, resize, invalid: resolvedInvalid }),
        className
      )}
    />
  );
}

export { Textarea, textareaVariants };
