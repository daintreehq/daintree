import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium cursor-pointer select-none transition-all duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 active:scale-[0.98]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none",
        destructive:
          "bg-destructive text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none focus-visible:ring-destructive",
        outline:
          "ring-1 ring-border-interactive bg-surface-panel-elevated/95 backdrop-blur-md text-canopy-text shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_var(--color-overlay-soft)] hover:bg-surface-panel-elevated hover:ring-border-default hover:text-canopy-text active:bg-overlay-soft active:shadow-none",
        secondary:
          "bg-secondary text-secondary-foreground ring-1 ring-tint/[0.08] shadow-[var(--theme-shadow-ambient)] hover:bg-secondary/90 active:shadow-none",
        ghost:
          "text-text-secondary hover:bg-overlay-soft hover:text-canopy-text focus-visible:text-canopy-text",
        link: "text-primary underline-offset-4 hover:underline",
        subtle:
          "bg-surface-panel text-text-secondary ring-1 ring-border-interactive hover:bg-surface-panel-elevated hover:ring-border-default hover:text-canopy-text",
        pill: "rounded-full bg-surface-panel backdrop-blur-md ring-1 ring-border-interactive text-text-secondary hover:bg-surface-panel-elevated hover:ring-border-default hover:text-canopy-text",
        "ghost-danger":
          "text-status-error hover:bg-status-error/10 focus-visible:ring-status-error",
        "ghost-success": "text-status-success hover:bg-status-success/10",
        "ghost-info": "text-status-info hover:bg-status-info/10",
        info: "bg-status-info text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none",
        glow: "bg-primary text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] shadow-[0_0_15px_rgba(var(--theme-accent-rgb),0.3)] ring-1 ring-tint/25 hover:shadow-[0_0_25px_rgba(var(--theme-accent-rgb),0.45)] hover:brightness-110 active:shadow-inner active:brightness-95",
        vibrant:
          "bg-gradient-to-b from-primary to-primary/80 text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] shadow-[var(--theme-shadow-floating)] ring-1 ring-tint/25 hover:brightness-110 active:brightness-90 active:shadow-inner",
      },
      size: {
        default: "h-8 px-4 py-1.5 gap-2 [&_svg]:size-4",
        sm: "h-7 px-3 py-1 gap-1.5 text-xs [&_svg]:size-3.5",
        xs: "h-6 px-2.5 py-0.5 gap-1 text-[10px] leading-none [&_svg]:size-3",
        lg: "h-9 px-6 py-2 gap-2.5 text-sm [&_svg]:size-4",
        icon: "h-8 w-8 [&_svg]:size-4",
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
