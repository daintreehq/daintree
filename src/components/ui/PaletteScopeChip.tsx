import { cn } from "@/lib/utils";
import {
  UI_PALETTE_ENTER_DURATION,
  UI_PALETTE_EXIT_DURATION,
  UI_ENTER_EASING,
  UI_EXIT_EASING,
} from "@/lib/animationUtils";

export interface PaletteScopeChipProps {
  label: string;
  isVisible: boolean;
  id?: string;
  /**
   * Be a polite live region that speaks the label as it appears. Default true;
   * a palette that announces its own scope changes passes false so the change
   * isn't spoken twice.
   */
  live?: boolean;
}

/**
 * The chip a palette shows inside its search field while the input is scoped
 * to one source: the action palette's `> Commands` mode, the quick switcher's
 * plugin search providers. Passed as `inputPrefix`; it rides the palette's own
 * enter and exit tiers so it never pops in faster than the palette does. A
 * long label is cut so the field always keeps room to type.
 */
export function PaletteScopeChip({ label, isVisible, id, live = true }: PaletteScopeChipProps) {
  return (
    <span
      id={id}
      role={live ? "status" : undefined}
      aria-live={live ? "polite" : undefined}
      title={label}
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] max-w-48",
        "bg-overlay-subtle text-xs text-text-secondary select-none shrink-0 origin-left",
        "transition-[opacity,scale] motion-reduce:transition-opacity motion-reduce:scale-100",
        isVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"
      )}
      style={{
        transitionDuration: isVisible
          ? `${UI_PALETTE_ENTER_DURATION}ms`
          : `${UI_PALETTE_EXIT_DURATION}ms`,
        transitionTimingFunction: isVisible ? UI_ENTER_EASING : UI_EXIT_EASING,
      }}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}
