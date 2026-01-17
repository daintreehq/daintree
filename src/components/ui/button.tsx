import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] font-medium transition-[color,background-color,border-color,box-shadow,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90 active:scale-[0.98]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 active:scale-[0.98] focus-visible:ring-destructive",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground active:scale-[0.98]",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 active:scale-[0.98]",
        ghost: "hover:bg-white/[0.06] hover:text-accent-foreground active:scale-[0.98]",
        link: "text-primary underline-offset-4 hover:underline",
        subtle:
          "bg-canopy-bg text-canopy-text/60 hover:bg-white/[0.06] hover:text-canopy-text active:scale-[0.98]",
        pill: "rounded-full bg-canopy-bg/50 border border-canopy-border text-canopy-text/60 hover:bg-white/[0.06] hover:text-canopy-text/80 active:scale-[0.98]",
        "ghost-danger":
          "text-[var(--color-status-error)] hover:bg-[var(--color-status-error)]/10 active:scale-[0.98] focus-visible:ring-[var(--color-status-error)]",
        "ghost-success":
          "text-[var(--color-status-success)] hover:bg-[var(--color-status-success)]/10 active:scale-[0.98]",
        "ghost-info":
          "text-[var(--color-status-info)] hover:bg-[var(--color-status-info)]/10 active:scale-[0.98]",
        info: "bg-[var(--color-status-info)] text-white hover:brightness-110 active:scale-[0.98]",
      },
      size: {
        default: "h-9 px-4 py-2 gap-2 text-sm [&_svg]:size-4",
        sm: "h-8 px-3 gap-1.5 text-xs [&_svg]:size-3.5",
        xs: "h-6 px-2 gap-1 text-xs [&_svg]:size-3",
        lg: "h-10 px-8 gap-2.5 text-sm [&_svg]:size-5",
        icon: "h-9 w-9 [&_svg]:size-4",
        "icon-sm": "h-7 w-7 [&_svg]:size-3.5",
        "icon-xs": "h-6 w-6 [&_svg]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
