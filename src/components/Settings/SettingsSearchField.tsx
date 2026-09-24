import { useImperativeHandle, useRef, type Ref } from "react";
import { SearchField } from "@/components/ui/SearchField";

interface SettingsSearchFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Names the field for assistive tech; the visible placeholder is a hint, not a label. */
  label: string;
  placeholder: string;
  disabled?: boolean;
  ref?: Ref<HTMLInputElement>;
}

/**
 * The filter field above a long settings list (shortcuts, commands) — the
 * shared search field, so it matches the settings nav search beside it rather
 * than the form `Input` the rest of the page's fields use.
 *
 * Escape clears a non-empty query and stops there, so it never also closes the
 * dialog; on an empty field it blurs and lets the dialog have the next Escape.
 */
export function SettingsSearchField({
  value,
  onChange,
  label,
  placeholder,
  disabled,
  ref,
}: SettingsSearchFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!, []);

  return (
    <SearchField
      size="compact"
      fieldClassName="flex-1"
      inputRef={inputRef}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClear={() => onChange("")}
      // "Clear", not the family default: the empty state below the list owns
      // "Clear search", and two buttons with one name are indistinguishable.
      clearLabel="Clear"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        if (value !== "") {
          e.stopPropagation();
          onChange("");
        } else {
          inputRef.current?.blur();
        }
      }}
      placeholder={placeholder}
      aria-label={label}
      disabled={disabled}
    />
  );
}
