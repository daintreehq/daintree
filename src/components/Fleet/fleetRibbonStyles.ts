/**
 * The one shell both ribbon branches render into. The armed bar and the
 * confirm-pending bar used to be two hand-kept copies of the same class string
 * and drifted 4px apart in height, so the grid jumped every time a confirm
 * opened. A fixed height rather than padding: the chip (22px) and the text-only
 * confirm line both sit inside 36px, and neither can change the bar's size.
 *
 * The amber tint plus the 2px left stripe are the mode's non-colour structural
 * cue and are shared with the drafting pill and the fleet-primary input bar.
 */
export const FLEET_RIBBON_SHELL_CLASS =
  "relative flex h-9 items-center gap-3 border-b border-border-default bg-category-amber-subtle px-3 text-xs leading-[inherit] text-text-primary " +
  "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--color-category-amber-border)]";

/** 24×24 hit area for the ribbon's glyph-only controls (exit, dismiss, disarm, menu). */
export const FLEET_RIBBON_ICON_BUTTON_CLASS =
  "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-text-secondary transition-colors hover:bg-tint/[0.08] hover:text-text-primary";

/** The text buttons that live on the bar itself (Exit, Cancel). */
export const FLEET_RIBBON_TEXT_BUTTON_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] bg-tint/[0.08] px-2 text-2xs text-text-secondary transition-colors hover:bg-tint/[0.14] hover:text-text-primary";
