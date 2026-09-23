import { useImperativeHandle, useRef, type Ref } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";

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
 * The filter field above a long settings list (shortcuts, commands). The shared
 * `Input` carries the focus ring, so the field needs no focus handling of its
 * own; the magnifier and the clear button sit inside its padding.
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
    <div className="relative min-w-0 flex-1">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-secondary"
        aria-hidden="true"
      />
      <Input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
        className="pl-8 pr-8"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          aria-label="Clear"
          className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded-[var(--radius-sm)] text-text-secondary hover:text-text-primary hover:bg-overlay-soft transition-colors duration-150 ease-out"
        >
          <X className="w-3 h-3" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
