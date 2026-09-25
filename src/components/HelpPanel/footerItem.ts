import { cn } from "@/lib/utils";

/**
 * The shared shape of every interactive item in the row: a 24px target (WCAG
 * 2.5.8) with its own hover surface, so the row reads as a status bar of
 * discrete items rather than loose text. The ring sits flush because the row
 * leaves exactly 2px above and below it.
 */
export const FOOTER_ITEM_CLASS = cn(
  "inline-flex items-center gap-1.5 h-6 px-1.5 rounded-[var(--radius-sm)] whitespace-nowrap",
  "transition-colors duration-150 ease-out hover:bg-overlay-soft",
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-0"
);
