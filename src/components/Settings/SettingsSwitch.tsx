import * as Switch from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

const COLOR_SCHEMES = {
  accent: {
    track: "bg-daintree-border data-[state=checked]:bg-daintree-accent",
    thumb: "bg-daintree-text data-[state=checked]:bg-text-inverse",
    focus: "focus-visible:outline-daintree-accent",
  },
  amber: {
    track: "bg-daintree-border data-[state=checked]:bg-status-warning",
    thumb: "bg-daintree-text data-[state=checked]:bg-text-inverse",
    focus: "focus-visible:outline-status-warning",
  },
  danger: {
    track: "bg-daintree-border data-[state=checked]:bg-status-error",
    thumb: "bg-daintree-text data-[state=checked]:bg-text-inverse",
    focus: "focus-visible:outline-status-error",
  },
} as const;

type ColorScheme = keyof typeof COLOR_SCHEMES;

interface SettingsSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
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
  id,
  name,
  colorScheme = "accent",
  className,
}: SettingsSwitchProps) {
  const scheme = COLOR_SCHEMES[colorScheme];

  return (
    <Switch.Root
      id={id}
      name={name}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      aria-describedby={ariaDescribedby}
      className={cn(
        "relative inline-flex shrink-0 rounded-full transition-colors duration-150 ease-in-out",
        "w-11 h-6",
        scheme.track,
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        scheme.focus,
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
    >
      <Switch.Thumb
        className={cn(
          "block rounded-full shadow-sm transition-transform duration-150 ease-in-out",
          "w-4 h-4 translate-x-1 data-[state=checked]:translate-x-6",
          scheme.thumb
        )}
      />
    </Switch.Root>
  );
}
