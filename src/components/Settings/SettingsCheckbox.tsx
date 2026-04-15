import { cn } from "@/lib/utils";

interface SettingsCheckboxProps {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function SettingsCheckbox({
  id,
  label,
  description,
  checked,
  onChange,
  disabled,
}: SettingsCheckboxProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex items-start gap-3 cursor-pointer",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="w-4 h-4 mt-0.5 rounded border-border-strong bg-daintree-bg text-daintree-accent focus:ring-daintree-accent focus:ring-2 focus:ring-offset-0 disabled:opacity-50"
      />
      <div className="flex-1">
        <span className="text-sm font-medium text-daintree-text">{label}</span>
        <p className="text-xs text-daintree-text/50 mt-0.5 select-text">{description}</p>
      </div>
    </label>
  );
}
