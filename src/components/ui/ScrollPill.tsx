import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export interface ScrollPillProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** Whether the pill is in its shown state (drives opacity + resting transform). */
  isVisible: boolean;
  /** Direction the pill slides toward when hidden. "none" hides without vertical movement. */
  translateDirection: "up" | "down" | "none";
}

/**
 * Shared floating scroll-pill chrome. Owns the rounded surface, border, shadow,
 * hover, focus ring, scoped opacity/transform transition, and motion-reduce
 * stack. Callers supply layout (flex/padding/gap), copy, and animation timing
 * (via their own `useAnimatedPresence`) and keep `pointer-events-none` on the
 * overlay wrapper — `pointer-events-auto` is baked in here so the button stays
 * clickable through the wrapper.
 *
 * The primitive owns its `opacity-*` / `translate-y-*` / `transform-*` and
 * `transition-*` utilities — callers must not pass conflicting variants via
 * `className` (Tailwind v4 resolves conflicts by stylesheet order, not class
 * string order, so the winner would be undefined). Pass only layout/spacing
 * utilities (flex, gap, padding). `type` is always `button` and cannot be
 * overridden — scroll chrome must never submit a form.
 */
export const ScrollPill = forwardRef<HTMLButtonElement, ScrollPillProps>(
  ({ isVisible, translateDirection, className, ...rest }, ref) => {
    const hiddenTransform =
      translateDirection === "up"
        ? "opacity-0 -translate-y-2"
        : translateDirection === "down"
          ? "opacity-0 translate-y-2"
          : "opacity-0 translate-y-0";

    return (
      <button
        ref={ref}
        className={cn(
          "pointer-events-auto rounded-full",
          "bg-daintree-bg/90 border border-daintree-border/40 text-daintree-text shadow-[var(--theme-shadow-floating)]",
          "text-xs font-medium cursor-pointer",
          "hover:bg-daintree-bg hover:border-daintree-border/60",
          // Tailwind v4 translate-* emits the individual `translate` property,
          // which `transform` in a transition list does NOT cover — list it
          // explicitly or the slide snaps and only the fade animates.
          "transition-[opacity,translate] duration-150",
          "motion-reduce:transition-none motion-reduce:duration-0 motion-reduce:translate-none",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:outline-offset-1",
          isVisible ? "opacity-100 translate-y-0" : hiddenTransform,
          className
        )}
        {...rest}
        type="button"
      />
    );
  }
);

ScrollPill.displayName = "ScrollPill";
