import * as Switch from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

// The OFF state used to paint the thumb `bg-daintree-text` — a near-black
// filled circle sitting in a pale track, which reads as an illuminated
// "on" indicator rather than an off one. The solid high-contrast fill is now
// reserved for the ON track, the OFF thumb is a mid-tone that cannot be
// mistaken for a lit state, and the OFF track carries a defined boundary so
// the control is still discernible against the page (WCAG 1.4.11).
// An inset ring rather than a border: `border` would shrink the track's content
// box and shift the checked thumb 2px off its resting inset.
const OFF_TRACK = "bg-surface-input ring-1 ring-inset ring-border-strong";
const OFF_THUMB = "bg-text-muted";
const ON_THUMB = "data-[state=checked]:bg-text-inverse";

const COLOR_SCHEMES = {
  accent: {
    track: `${OFF_TRACK} data-[state=checked]:bg-daintree-text data-[state=checked]:ring-0`,
    thumb: `${OFF_THUMB} ${ON_THUMB}`,
    focus: "focus-visible:outline-daintree-accent",
  },
  amber: {
    track: `${OFF_TRACK} data-[state=checked]:bg-status-warning data-[state=checked]:ring-0`,
    thumb: `${OFF_THUMB} ${ON_THUMB}`,
    focus: "focus-visible:outline-status-warning",
  },
  danger: {
    track: `${OFF_TRACK} data-[state=checked]:bg-status-error data-[state=checked]:ring-0`,
    thumb: `${OFF_THUMB} ${ON_THUMB}`,
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
      data-testid={dataTestId}
      className={cn(
        "relative inline-flex items-center shrink-0 rounded-full transition-colors duration-200 ease-out",
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
          "block rounded-full shadow-sm transition-transform duration-100 ease-[var(--ease-out-expo)]",
          "w-4 h-4 translate-x-1 data-[state=checked]:translate-x-6",
          scheme.thumb
        )}
      />
    </Switch.Root>
  );
}
