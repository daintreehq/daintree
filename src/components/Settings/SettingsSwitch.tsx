import { Switch, type SwitchProps } from "@/components/ui/switch";

// The settings layer named these after colours; the primitive names them after
// what they mean. Mapping here keeps every existing call site untouched rather
// than pushing colour vocabulary into the shared UI surface.
const TONE_BY_COLOR_SCHEME = {
  accent: "neutral",
  amber: "warning",
  danger: "danger",
} as const;

type ColorScheme = keyof typeof TONE_BY_COLOR_SCHEME;

/**
 * Everything but the look: the plugin kit's `Switch` forwards the DOM props a
 * plugin passes (ref, handlers, data attributes) through here, so a plugin
 * switch is this switch.
 */
type SettingsSwitchDomProps = Omit<
  SwitchProps,
  "size" | "tone" | "checked" | "defaultChecked" | "onCheckedChange"
>;

interface SettingsSwitchProps extends SettingsSwitchDomProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** The value shown couldn't be saved. */
  "aria-invalid"?: boolean;
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
  "aria-invalid": ariaInvalid,
  "data-testid": dataTestId,
  id,
  name,
  colorScheme = "accent",
  className,
  ...rest
}: SettingsSwitchProps) {
  return (
    <Switch
      {...rest}
      id={id}
      name={name}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      aria-invalid={ariaInvalid || undefined}
      data-testid={dataTestId}
      tone={TONE_BY_COLOR_SCHEME[colorScheme]}
      className={className}
    />
  );
}
