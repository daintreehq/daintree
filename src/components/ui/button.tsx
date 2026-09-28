import * as React from "react";
import { Slot, Slottable } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/Spinner";

const buttonVariants = cva(
  "relative inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-md)] font-medium cursor-pointer select-none transition duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 active:scale-[0.98] active:duration-[1ms]",
  {
    variants: {
      variant: {
        // Accent-filled variants pair `primary` (the accent fill) with
        // `primary-foreground` — the contrast-validated counterpart, guaranteed
        // >= 4.5:1 against the fill for any custom accent. No text-shadow: the
        // label's polarity flips with the accent, so a fixed white emboss would
        // smudge a dark label on a light accent.
        default:
          "bg-primary text-primary-foreground ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none",
        destructive:
          "bg-destructive text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none",
        outline:
          "ring-1 ring-border-strong bg-surface-panel-elevated/95 backdrop-blur-md text-text-primary shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_var(--color-overlay-soft)] hover:bg-surface-panel-elevated hover:ring-border-default hover:text-text-primary active:bg-overlay-soft active:shadow-none",
        // High-contrast INVERSE CTA: a near-white fill + off-black text on dark
        // themes, near-black fill + off-white text on light themes — so the button
        // pops against the surrounding UI (white CTA on a dark app / black CTA on a
        // light app). `text-primary` is the off-white/off-black foreground shade
        // and `text-inverse` its opposite; the built-in themes keep this pair very
        // high contrast (~12-16:1). Use where the chromatic accent would be
        // unreadable (e.g. white text on a bright-green accent) or would
        // distractingly restyle, and the action needs to be highly noticeable.
        // Hover/active shift the fill toward the text color — a background-only
        // press cue that reads correctly in both polarities (darkens the white
        // fill / lightens the black fill). Not opacity, which would fade the
        // label and let the surface bleed through.
        contrast:
          "bg-text-primary text-text-inverse ring-1 ring-tint/15 shadow-[var(--theme-shadow-ambient)] hover:bg-[color-mix(in_oklab,var(--color-text-primary)_90%,var(--color-text-inverse))] active:bg-[color-mix(in_oklab,var(--color-text-primary)_82%,var(--color-text-inverse))] active:shadow-none",
        secondary:
          "bg-secondary text-secondary-foreground ring-1 ring-tint/[0.08] shadow-[var(--theme-shadow-ambient)] hover:bg-secondary/90 active:shadow-none",
        // `overlay-hover`, not `overlay-soft`: it is the one fill in the ladder
        // the theme validator floors (`getOverlayContrastWarnings`), and soft
        // measured 9.6-10.8% Weber on every light theme, below that 12% floor,
        // which is what kept sending callers to hand-rolled `tint/*` hovers.
        ghost:
          "text-text-secondary hover:bg-overlay-hover hover:text-text-primary focus-visible:text-text-primary",
        // The one link treatment: secondary ink, underlined at rest so it never
        // relies on colour alone (WCAG 1.4.1), stepping up to primary on hover.
        // Sized `inline` by default — see `resolvedSize` below.
        link: "font-normal text-text-secondary underline underline-offset-2 hover:text-text-primary",
        subtle:
          "bg-surface-panel text-text-secondary ring-1 ring-border-strong hover:bg-surface-panel-elevated hover:ring-border-default hover:text-text-primary",
        pill: "rounded-full bg-surface-panel backdrop-blur-md ring-1 ring-border-strong text-text-secondary hover:bg-surface-panel-elevated hover:ring-border-default hover:text-text-primary",
        "ghost-danger":
          "text-status-error hover:bg-status-error/10 focus-visible:outline-status-error",
        "ghost-info": "text-status-info hover:bg-status-info/10",
        info: "bg-status-info text-text-inverse [text-shadow:0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-tint/20 shadow-[var(--theme-shadow-ambient)] inset-shadow-[0_1px_0_rgba(255,255,255,0.15)] hover:brightness-110 active:brightness-95 active:inset-shadow-none",
        glow: "bg-primary text-primary-foreground shadow-[0_0_15px_rgb(from_var(--theme-accent-primary)_r_g_b/0.3)] ring-1 ring-tint/25 hover:shadow-[0_0_25px_rgb(from_var(--theme-accent-primary)_r_g_b/0.45)] hover:brightness-110 active:shadow-inner active:brightness-95",
        vibrant:
          "bg-gradient-to-b from-primary to-primary/80 text-primary-foreground shadow-[var(--theme-shadow-floating)] ring-1 ring-tint/25 hover:brightness-110 active:brightness-90 active:shadow-inner",
      },
      size: {
        default: "h-8 px-4 py-1.5 gap-2 text-sm [&_svg]:size-4",
        sm: "h-7 px-3 py-1 gap-1.5 text-xs [&_svg]:size-3.5",
        xs: "h-6 px-2.5 py-0.5 gap-1 text-2xs leading-none [&_svg]:size-3",
        lg: "h-9 px-6 py-2 gap-2.5 text-sm [&_svg]:size-4",
        icon: "h-8 w-8 text-sm [&_svg]:size-4",
        "icon-sm": "h-7 w-7 text-sm [&_svg]:size-3.5",
        "icon-xs": "h-6 w-6 text-sm [&_svg]:size-3",
        // No box and no type size: the control takes the font and line height
        // of the text it sits in, so a link inside a sentence stays in the
        // sentence. Inline targets are exempt from the 24px minimum (WCAG 2.5.8).
        inline:
          "h-auto p-0 gap-1 whitespace-normal text-left rounded-[var(--radius-xs)] [&_svg]:size-[1em]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

/**
 * The one pressed look for a toggle button (`pressed` below), whatever its
 * variant: a `text-secondary` edge, which clears WCAG 1.4.11's 3:1 in both
 * polarities where the border ramp's strongest step measured 1.5-1.7:1, over
 * the filter chips' selected fill, with primary ink. It is the filter chip's
 * selected treatment on a button's shape, so "on" reads the same on a chip and
 * on a toggle. A fill step alone, the old per-site treatment, was barely
 * different from rest on the dark themes. A pressed button is set, not raised,
 * so the outline variant's drop shadow and top highlight go, which also keeps
 * every variant's "on" identical. Keyed on `aria-pressed` so the state
 * the screen reader hears is the state that is drawn; the variants use rings,
 * not borders, so the edge costs no layout. Forced colours strips both the fill
 * and the ring — `data-toggle` is the hook `index.css` redraws it from.
 */
const PRESSED_CLASS =
  "aria-pressed:bg-filter-selected-bg-strong aria-pressed:text-text-primary aria-pressed:ring-1 aria-pressed:ring-text-secondary aria-pressed:shadow-none aria-pressed:inset-shadow-none";

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
  inline: "xs",
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
  inline: "gap-1",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /**
   * When true, overlays a centered spinner and hides the label without swapping
   * it (preserving width + accessible name). Sets `aria-busy`/`aria-disabled`
   * and blocks clicks/keyboard activation without using the native `disabled`
   * attribute, so focus is preserved.
   */
  loading?: boolean;
  /**
   * Makes the button a toggle: sets `aria-pressed` and draws the shared pressed
   * treatment while it is true. Leave it undefined for an ordinary button, and
   * keep the label constant — the pressed state is what changes, not the name.
   */
  pressed?: boolean;
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
      pressed,
      onClick,
      disabled,
      children,
      "aria-disabled": ariaDisabled,
      "aria-busy": ariaBusy,
      ...props
    },
    ref
  ) => {
    const Comp = asChild ? Slot : "button";
    // A link is text, not a box: unless the caller asks for a size, it takes
    // the inline one rather than the default's 32px padded frame.
    const resolvedSize: ButtonSize = size ?? (variant === "link" ? "inline" : "default");
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
          buttonVariants({ variant, size: resolvedSize }),
          loading && "pointer-events-none",
          pressed !== undefined && PRESSED_CLASS,
          className,
          // Busy outranks unavailable: a caller's own disabled dimming (the
          // `disabled:`/`aria-disabled:` 50%) would fade the spinner it overlays.
          loading && "disabled:opacity-100 aria-disabled:opacity-100"
        )}
        ref={ref}
        // Never natively disabled while busy — that would drop keyboard focus to
        // <body> mid-operation. `loading` already vetoes activation.
        disabled={loading ? undefined : disabled}
        onClick={handleClick}
        {...props}
        // After the spread: when the caller asks for a toggle, the state it
        // draws is the state it announces. Undefined leaves a raw aria-pressed
        // (the toolbar's armed chip) alone.
        {...(pressed !== undefined && { "aria-pressed": pressed, "data-toggle": true })}
        // Component-owned loading state — placed after the prop spread so a
        // consumer can't silently desync the announced ARIA state.
        // A consumer's own busy signal (a rotating refresh glyph) passes through
        // when the primitive isn't loading.
        aria-busy={loading || ariaBusy || undefined}
        aria-disabled={resolvedAriaDisabled}
        data-loading={loading || undefined}
        // A durable hook for the forced-colors rule in index.css. In
        // forced-colors the UA replaces every button's background with a system
        // colour, so `bg-destructive` stops distinguishing this button from
        // Cancel — an attribute survives where a fill does not, and unlike
        // keying the CSS off the fill utility it cannot silently stop matching
        // if the variant's classes are restyled.
        data-variant={variant ?? "default"}
      >
        {spinner}
        {/* asChild + loading: overlay renders alongside the slotted child;
            label hiding is intentionally not applied to the asChild path
            (would require cloning the consumer's element). No call site
            combines asChild with loading. */}
        {asChild ? (
          <Slottable>{children}</Slottable>
        ) : (
          // `display: contents` when not loading so the wrapper is transparent
          // to layout — children are flex items of the <button> directly, which
          // restores caller patterns like `w-full justify-between` + `truncate`.
          // When loading, the wrapper becomes a real flex box so `opacity-0` can
          // hide the label behind the absolute spinner overlay while it still
          // holds the width. A dimmed label under the spinner collided with it
          // on short labels ("Run" read as a spinner over its first letter).
          <span
            data-slot="button-content"
            className={
              loading
                ? cn(
                    "inline-flex items-center justify-center",
                    GAP_CLASS_MAP[resolvedSize],
                    "opacity-0 transition-opacity duration-150 ease-out"
                  )
                : "contents"
            }
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
