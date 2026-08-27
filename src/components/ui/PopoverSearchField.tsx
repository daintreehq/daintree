import { forwardRef } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

interface PopoverSearchFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Extra classes for the field, not the inner input. */
  fieldClassName?: string;
}

/**
 * The search box that sits at the top of a filtering popover.
 *
 * The whole strip is the field: the magnifier lives inside its padding and the
 * focus treatment covers the full width, taking the panel's own top corners
 * (the popover clips to them). Each site used to draw a ring around the bare
 * `<input>` instead, which floated a square-cornered box inside the panel that
 * started after the icon and left the padding stranded outside the control —
 * the field looked like it was in the wrong place rather than being the top of
 * the panel.
 *
 * Focus is neutral `selection-outline` on the bottom edge plus a surface lift,
 * the same pairing the palette input and the palette's selected row use. It is
 * deliberately not the global accent ring: this field is autofocused whenever
 * its popover opens, so an accent ring would spend the region's one
 * load-bearing accent on chrome that is always lit.
 */
export const PopoverSearchField = forwardRef<HTMLInputElement, PopoverSearchFieldProps>(
  function PopoverSearchField({ className, fieldClassName, ...inputProps }, ref) {
    return (
      // A label rather than a div: clicking anywhere on the strip — the icon,
      // the padding — puts the caret in the field, which is what "the whole
      // top area is the text box" has to mean to a pointer.
      <label
        className={cn(
          "flex items-center gap-2 border-b border-daintree-border px-3",
          "transition-colors duration-150 ease-out",
          "focus-within:bg-overlay-soft focus-within:border-selection-outline",
          fieldClassName
        )}
      >
        {/* text-secondary, not text-muted: muted has no contrast floor in the
            dark themes (2.2:1 in Namib) and this glyph names the field. */}
        <Search className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <input
          ref={ref}
          type="text"
          className={cn(
            "h-10 min-w-0 flex-1 bg-transparent text-sm text-daintree-text",
            "placeholder:text-text-placeholder outline-hidden",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
          {...inputProps}
        />
      </label>
    );
  }
);
