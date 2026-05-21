import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/Spinner";

const buttonVariants = cva(
  "relative inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium cursor-pointer select-none transition duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 active:scale-[0.98] active:duration-[1ms]",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none",
        destructive:
          "bg-destructive text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none focus-visible:outline-destructive",
        outline:
          "ring-1 ring-border-strong bg-surface-panel-elevated/95 backdrop-blur-md text-daintree-text shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_var(--color-overlay-soft)] hover:bg-surface-panel-elevated hover:ring-border-default hover:text-daintree-text active:bg-overlay-soft active:shadow-none",
        secondary:
          "bg-secondary text-secondary-foreground ring-1 ring-tint/[0.08] shadow-[var(--theme-shadow-ambient)] hover:bg-secondary/90 active:shadow-none",
        ghost:
          "text-text-secondary hover:bg-overlay-soft hover:text-daintree-text focus-visible:text-daintree-text",
        link: "text-primary underline-offset-4 hover:underline",
        subtle:
          "bg-surface-panel text-text-secondary ring-1 ring-border-strong hover:bg-surface-panel-elevated hover:ring-border-default hover:text-daintree-text",
        pill: "rounded-full bg-surface-panel backdrop-blur-md ring-1 ring-border-strong text-text-secondary hover:bg-surface-panel-elevated hover:ring-border-default hover:text-daintree-text",
        "ghost-danger":
          "text-status-error hover:bg-status-error/10 focus-visible:outline-status-error",
        "ghost-success": "text-status-success hover:bg-status-success/10",
        "ghost-info": "text-status-info hover:bg-status-info/10",
        info: "bg-status-info text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none",
        glow: "bg-primary text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] shadow-[0_0_15px_rgb(from_var(--theme-accent-primary)_r_g_b/0.3)] ring-1 ring-tint/25 hover:shadow-[0_0_25px_rgb(from_var(--theme-accent-primary)_r_g_b/0.45)] hover:brightness-110 active:shadow-inner active:brightness-95",
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

type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

// Spinner size per button size — kept in lockstep with the CVA `[&_svg]:size-*`
// rules so the overlay matches inline icon sizing.
const SPINNER_SIZE_MAP: Record<ButtonSize, React.ComponentProps<typeof Spinner>["size"]> = {
  default: "md",
  sm: "sm",
  xs: "xs",
  lg: "md",
  icon: "md",
  "icon-sm": "sm",
  "icon-xs": "xs",
};

// `gap` is not a CSS-inherited property, so the content wrapper can't pick up
// the button's gap implicitly — mirror the per-size gap explicitly.
const GAP_CLASS_MAP: Record<ButtonSize, string> = {
  default: "gap-2",
  sm: "gap-1.5",
  xs: "gap-1",
  lg: "gap-2.5",
  icon: "gap-2",
  "icon-sm": "gap-1.5",
  "icon-xs": "gap-1",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * When true, overlays a centered spinner and dims the label without swapping
   * it (preserving width + accessible name). Sets `aria-busy`/`aria-disabled`
   * and blocks clicks/keyboard activation without using the native `disabled`
   * attribute, so focus is preserved.
   */
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      type,
      loading = false,
      onClick,
      disabled,
      children,
      "aria-disabled": ariaDisabled,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    const resolvedSize: ButtonSize = size ?? "default";
    const resolvedAriaDisabled = loading || disabled ? true : ariaDisabled || undefined;

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      if (loading) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      onClick?.(event);
    };

    const spinner = loading ? (
      <span
        data-slot="button-spinner"
        className="pointer-events-none absolute inset-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <Spinner size={SPINNER_SIZE_MAP[resolvedSize]} />
      </span>
    ) : null;

    return (
      <Comp
        type={asChild ? undefined : (type ?? "button")}
        className={cn(
          buttonVariants({ variant, size }),
          loading && "pointer-events-none",
          className
        )}
        ref={ref}
        disabled={disabled}
        onClick={handleClick}
        {...props}
        // Component-owned loading state — placed after the prop spread so a
        // consumer can't silently desync the announced ARIA state.
        aria-busy={loading || undefined}
        aria-disabled={resolvedAriaDisabled}
        data-loading={loading || undefined}
      >
        {spinner}
        {/* asChild + loading: overlay renders alongside the slotted child;
            label dimming is intentionally not applied to the asChild path
            (would require cloning the consumer's element). No call site
            combines asChild with loading. */}
        {asChild ? (
          <Slottable>{children}</Slottable>
        ) : (
          <span
            data-slot="button-content"
            className={cn(
              "inline-flex items-center justify-center",
              GAP_CLASS_MAP[resolvedSize],
              loading && "opacity-30 transition-opacity duration-150 ease-out"
            )}
          >
            {children}
          </span>
        )}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
