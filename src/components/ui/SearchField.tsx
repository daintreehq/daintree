import * as React from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as React.RefObject<T | null>).current = value;
}

export type SearchFieldSize = "compact" | "palette";

export interface SearchFieldProps extends Omit<
  React.ComponentPropsWithoutRef<"input">,
  "size" | "prefix"
> {
  /** `compact` for rails and nav columns (28px), `palette` for palette headers. */
  size?: SearchFieldSize;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Classes for the visible field, not the inner input. */
  fieldClassName?: string;
  fieldStyle?: React.CSSProperties;
  /** Props for the field element itself — a landmark role, a test id. */
  fieldProps?: Omit<React.HTMLAttributes<HTMLDivElement>, "className" | "style" | "children">;
  /** Rendered between the magnifier and the text, inside the field (a mode chip). */
  prefix?: React.ReactNode;
  /** Shows the clear button while the field has a value. */
  onClear?: () => void;
  clearLabel?: string;
  /** Anything else trailing inside the field, after the clear button. */
  trailing?: React.ReactNode;
}

/**
 * The app's search box: magnifier, text, and an optional clear button in one
 * field. Styling lives in `src/styles/components/search-field.css` so a bare
 * CSS consumer and this component draw the identical control.
 *
 * The whole field is the pointer target — pressing the magnifier or the
 * padding puts the caret in the text rather than doing nothing, which is what
 * a field drawn as one box has to mean.
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

  return (
    <div
      {...fieldProps}
      data-size={size}
      className={cn("search-field", fieldClassName)}
      style={fieldStyle}
      onPointerDown={handlePointerDown}
    >
      <Search className="search-field-icon" aria-hidden="true" />
      {prefix}
      <input
        ref={setRefs}
        type="text"
        value={value}
        className={cn("search-field-input", className)}
        {...inputProps}
      />
      {onClear && hasValue && (
        <button
          type="button"
          className="search-field-clear"
          aria-label={clearLabel}
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
