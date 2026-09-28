import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as React.RefObject<T | null>).current = value;
}

export type SearchFieldSize = "dense" | "compact" | "palette";

export interface SearchFieldProps extends Omit<
  React.ComponentPropsWithoutRef<"input">,
  "size" | "prefix"
> {
  /**
   * `compact` for rails, nav columns and dropdown headers (28px), `dense` for
   * filter strips and pane toolbars beside xs chips (24px), `palette` for
   * palette and dialog headers (38px).
   */
  size?: SearchFieldSize;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Classes for the visible field, not the inner input. */
  fieldClassName?: string;
  fieldStyle?: React.CSSProperties;
  /** Props for the field element itself — a landmark role, a test id. */
  fieldProps?: Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "style" | "children">;
  /** Rendered between the magnifier and the text, inside the field (a mode chip). */
  prefix?: React.ReactNode;
  /**
   * Shows the clear button while the field has a value, and makes Escape clear
   * a non-empty query before it reaches the surface around the field.
   */
  onClear?: () => void;
  clearLabel?: string;
  /** Anything else trailing inside the field, after the clear button. */
  trailing?: React.ReactNode;
  /** Replaces the magnifier — a spinner while results refresh, say. */
  icon?: React.ReactNode;
  /** Marks the query itself as unusable (an invalid pattern). */
  invalid?: boolean;
}

/**
 * The app's search box: magnifier, text, and an optional clear button in one
 * field. Styling lives in `src/styles/components/search-field.css` so a bare
 * CSS consumer and this component draw the identical control.
 *
 * The whole field is the pointer target — pressing the magnifier or the
 * padding puts the caret in the text rather than doing nothing, which is what
 * a field drawn as one box has to mean.
 *
 * This is the inset well: a field that sits inside padding and shares its
 * header with other things (a rail, a palette header, a toolbar dropdown with
 * refresh and sort beside it). When the search box is itself the top edge of
 * a simple picker popover, use `PopoverSearchField` instead. A non-interactive
 * stand-in (a loading skeleton) draws `.search-field` with `data-size` directly
 * rather than copying the look, so it cannot drift from the live field.
 */
export function SearchField({
  size = "compact",
  inputRef,
  fieldClassName,
  fieldStyle,
  fieldProps,
  prefix,
  onClear,
  clearLabel = "Clear search",
  trailing,
  icon,
  invalid = false,
  className,
  value,
  ...inputProps
}: SearchFieldProps) {
  const localRef = React.useRef<HTMLInputElement | null>(null);

  const setRefs = React.useCallback(
    (el: HTMLInputElement | null) => {
      localRef.current = el;
      assignRef(inputRef, el);
    },
    [inputRef]
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    fieldProps?.onPointerDown?.(event);
    if (event.defaultPrevented) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("input, button, a, [role='button']")) return;
    // preventDefault keeps focus from landing on the field div first and
    // blurring the input on the way.
    event.preventDefault();
    localRef.current?.focus();
  };

  const hasValue = value !== undefined && value !== null && String(value).length > 0;

  // Escape clears a query before it closes anything: the first press empties
  // the field and is claimed here, the next one finds it empty and falls
  // through to the surface. Runs after the caller's own handler and stands
  // down if that handler claimed the key — a field whose Escape first closes
  // its own popover, say — and while an IME is composing, where Escape
  // cancels the composition rather than the query.
  const { onKeyDown } = inputProps;
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isPropagationStopped() ||
      event.nativeEvent.isComposing ||
      !onClear ||
      !hasValue ||
      inputProps.disabled ||
      inputProps.readOnly
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onClear();
  };

  return (
    <div
      {...fieldProps}
      data-size={size}
      data-invalid={invalid ? "true" : undefined}
      className={cn("search-field", fieldClassName)}
      style={fieldStyle}
      onPointerDown={handlePointerDown}
    >
      {icon ?? <Search className="search-field-icon" aria-hidden="true" />}
      {prefix}
      <input
        ref={setRefs}
        type="text"
        value={value}
        className={cn("search-field-input", className)}
        aria-invalid={invalid || undefined}
        {...inputProps}
        onKeyDown={handleKeyDown}
      />
      {onClear && hasValue && (
        <button
          type="button"
          className="search-field-clear"
          aria-label={clearLabel}
          disabled={inputProps.disabled}
          onClick={() => {
            onClear();
            localRef.current?.focus();
          }}
        >
          <X className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
      {trailing}
    </div>
  );
}

/**
 * For a `SearchField` inside a Radix layer (a popover): the layer closes on
 * Escape in a document capture listener, before the field ever sees the key,
 * so the field's own clear-first Escape never gets a turn. Pass this from the
 * layer's `onEscapeKeyDown` and a focused, non-empty query is cleared instead
 * of the layer closing — the next Escape finds it empty and closes as usual.
 */
export function clearSearchBeforeDismiss(
  event: KeyboardEvent,
  input: HTMLInputElement | null,
  onClear: () => void
): void {
  if (event.isComposing || !input || document.activeElement !== input || input.value === "") {
    return;
  }
  event.preventDefault();
  onClear();
}
