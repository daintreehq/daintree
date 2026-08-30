import { Switch } from "@/components/ui/switch";

// The settings layer named these after colours; the primitive names them after
// what they mean. Mapping here keeps every existing call site untouched rather
// than pushing colour vocabulary into the shared UI surface.
const TONE_BY_COLOR_SCHEME = {
  accent: "neutral",
  amber: "warning",
  danger: "danger",
} as const;

type ColorScheme = keyof typeof TONE_BY_COLOR_SCHEME;

interface SettingsSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
  id?: string;
  name?: string;
  colorScheme?: ColorScheme;
  className?: string;
}

export function SettingsSwitch({
  checked,
  onCheckedChange,
  disabled,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  "aria-describedby": ariaDescribedby,
  "data-testid": dataTestId,
  id,
  name,
  colorScheme = "accent",
  className,
}: SettingsSwitchProps) {
  return (
    <Switch
      id={id}
      name={name}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      data-testid={dataTestId}
      tone={TONE_BY_COLOR_SCHEME[colorScheme]}
      className={className}
    />
  );
}
