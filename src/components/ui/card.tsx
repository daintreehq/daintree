import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/**
 * The one hover recipe for anything card-shaped the pointer can act on: a
 * neutral wash plus the border stepping up a tier. The border step is what
 * carries it on light themes, where the wash alone composites under the JND.
 */
const CARD_HOVER_PAINT = ["bg-overlay-subtle", "border-border-strong"] as const;

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
    /**
     * Hover paint only. The frame stays a plain `<div>` and never takes focus,
     * so a focus ring here could never match — the real control inside the card
     * owns focus, and the accent that goes with it.
     */
    interactive: {
      true: cn(
        "transition-[background-color,border-color] duration-150 ease-out",
        CARD_HOVER_PAINT.map((utility) => `hover:${utility}`)
      ),
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

/**
 * A whole card that is itself the control: a quick action, a recovery choice,
 * an agent to pick, a theme radio. `Card interactive` is the frame for a card
 * that *holds* controls; this is the card that *is* one, so it also owns focus
 * and press.
 *
 * - Rest is outlined, never filled: a resting wash is the hover state, so a
 *   filled card reads as already hovered, and static panels (`Card`) are the
 *   ones that carry a fill.
 * - Press is the Button snap (`active:scale-[0.98]`, 1ms in). `press-scale` is
 *   what removes it under reduced motion — `motion-reduce:` cannot, because the
 *   utility sets the individual `scale` property.
 * - Hover is `not-disabled:` rather than `enabled:` so the recipe also drives
 *   a `<label>` wrapping a radio, which is never `:enabled`. Press needs no
 *   guard: a disabled button never enters `:active`.
 * - `selected` is a radio card's checked state. Its edge is `text-secondary`,
 *   the Pressed Toggle edge, because the hover border would otherwise be the
 *   same tier as the selection and the two would read alike.
 */
const choiceCardVariants = cva(
  [
    "press-scale relative flex text-left cursor-pointer select-none rounded-[var(--radius-lg)] border",
    // `scale` stays out of the transition list, so the press snaps both ways
    // rather than easing back over 150ms.
    "transition-[background-color,border-color,color] duration-150 ease-out",
    "active:scale-[0.98] active:duration-[1ms]",
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
    "disabled:cursor-not-allowed disabled:opacity-50",
  ],
  {
    variants: {
      /**
       * `elevated` lifts one recommended card off the set — a raised surface and
       * the stronger edge, never accent. On light the `/95` alpha makes the lift
       * translucency-inert, so `.light` takes the opaque surface.
       */
      tone: {
        default: "",
        elevated: "",
      },
      selected: {
        true: "border-text-secondary bg-overlay-selected",
        false: "",
      },
      padding: {
        sm: "px-3 py-2",
        md: "p-3",
      },
    },
    compoundVariants: [
      {
        tone: "default",
        selected: false,
        className: cn(
          "border-border-default",
          CARD_HOVER_PAINT.map((utility) => `not-disabled:hover:${utility}`)
        ),
      },
      {
        tone: "elevated",
        selected: false,
        className:
          "border-border-strong bg-surface-panel-elevated/95 [.light_&]:bg-surface-panel-elevated not-disabled:hover:bg-surface-panel-elevated shadow-[var(--theme-shadow-ambient)]",
      },
    ],
    defaultVariants: {
      tone: "default",
      selected: false,
      padding: "md",
    },
  }
);

export interface ChoiceCardProps
  extends
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    Omit<VariantProps<typeof choiceCardVariants>, "selected"> {
  ref?: React.Ref<HTMLButtonElement>;
}

/**
 * Selection is a radio's job, so `selected` is not a prop here: a radio card is
 * a `<label>` over a native radio that spells `choiceCardVariants({ selected })`
 * itself, which keeps arrow-key selection native.
 */
function ChoiceCard({ className, tone, padding, ref, type = "button", ...props }: ChoiceCardProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(choiceCardVariants({ tone, padding }), className)}
      {...props}
      data-slot="choice-card"
      data-tone={tone ?? "default"}
    />
  );
}

export { Card, cardVariants, ChoiceCard, choiceCardVariants, CARD_HOVER_PAINT };
