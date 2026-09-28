import { forwardRef, useCallback, useRef } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface PopoverSearchFieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Extra classes for the field, not the inner input. */
  fieldClassName?: string;
  /**
   * Shows the clear button while the field has a value, as `SearchField` does.
   * Escape inside the popover is the layer's: pass `clearSearchBeforeDismiss`
   * from its `onEscapeKeyDown` so a query clears before the picker closes.
   */
  onClear?: () => void;
  clearLabel?: string;
}

/**
 * The strip and input halves of the field, for a search box whose `<input>` is
 * owned by someone else — the emoji picker's comes from frimousse, which wires
 * its keyboard navigation to its own element.
 */
export const POPOVER_SEARCH_STRIP_CLASS = cn(
  "flex items-center gap-2 border-b border-border-default px-3",
  "transition-colors duration-150 ease-out",
  "focus-within:border-border-strong"
);

export const POPOVER_SEARCH_INPUT_CLASS = cn(
  "h-10 min-w-0 flex-1 bg-transparent text-sm text-text-primary",
  "placeholder:text-text-placeholder outline-hidden",
  "disabled:cursor-not-allowed disabled:opacity-50"
);

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
 * The field sits bare on the panel with a hairline under it, and focus only
 * firms that hairline up. It used to lift the whole strip onto its own surface
 * with a `selection-outline` edge, but every picker autofocuses this field on
 * open, so that treatment was lit whenever the popover was — a permanent band
 * across the top of the panel that read as a separate toolbar rather than the
 * panel's own first line. The caret carries "type here"; the edge is only there
 * so focus leaving for a row control is still visible. Never the accent ring,
 * for the same always-lit reason.
 *
 * Only for a picker whose search box is the panel's full-width top strip, with
 * nothing else in that row. A search box inset in a header that also holds
 * other controls, or anywhere outside a picker popover, is `SearchField`.
 */
export const PopoverSearchField = forwardRef<HTMLInputElement, PopoverSearchFieldProps>(
  function PopoverSearchField(
    { className, fieldClassName, onClear, clearLabel = "Clear search", ...inputProps },
    ref
  ) {
    const { value } = inputProps;
    const hasValue = value !== undefined && value !== null && String(value).length > 0;
    const localRef = useRef<HTMLInputElement | null>(null);
    const setRefs = useCallback(
      (el: HTMLInputElement | null) => {
        localRef.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      },
      [ref]
    );
    return (
      // The whole strip is the field: pressing the icon or the padding puts the
      // caret in the text, which is what "the whole top area is the text box"
      // has to mean to a pointer. A div that forwards the press rather than a
      // <label>, because a label may hold only one control and the clear button
      // is a second.
      <div
        className={cn(POPOVER_SEARCH_STRIP_CLASS, "cursor-text", fieldClassName)}
        onPointerDown={(event) => {
          const target = event.target;
          if (!(target instanceof Element) || target.closest("input, button")) return;
          event.preventDefault();
          localRef.current?.focus();
        }}
      >
        {/* text-secondary, not text-muted: muted has no contrast floor in the
            dark themes (2.2:1 in Namib) and this glyph names the field. */}
        <Search className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <input
          ref={setRefs}
          type="text"
          className={cn(POPOVER_SEARCH_INPUT_CLASS, className)}
          {...inputProps}
        />
        {onClear && hasValue && (
          <button
            type="button"
            className="search-field-clear"
            aria-label={clearLabel}
            disabled={inputProps.disabled}
            // Pressing the button would otherwise pull focus off the input.
            onMouseDown={(event) => event.preventDefault()}
            // The button goes away with the query, so focus goes back to the text
            // rather than falling to the body.
            onClick={() => {
              onClear();
              localRef.current?.focus();
            }}
          >
            <X className="h-3 w-3" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }
);
