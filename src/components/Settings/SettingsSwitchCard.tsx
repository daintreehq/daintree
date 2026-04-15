import type { ComponentType } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

const COLOR_SCHEMES = {
  accent: {
    enabled: "border-daintree-border text-daintree-text",
    icon: "text-daintree-accent",
    toggle: "bg-daintree-accent",
    focus: "focus-visible:outline-daintree-accent",
  },
  amber: {
    enabled: "border-daintree-border text-daintree-text",
    icon: "text-status-warning",
    toggle: "bg-status-warning",
    focus: "focus-visible:outline-status-warning",
  },
  danger: {
    enabled: "border-daintree-border text-daintree-text",
    icon: "text-status-error",
    toggle: "bg-status-error",
    focus: "focus-visible:outline-status-error",
  },
} as const;

interface SettingsSwitchCardProps {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  isEnabled: boolean;
  onChange: () => void;
  ariaLabel: string;
  disabled?: boolean;
  colorScheme?: keyof typeof COLOR_SCHEMES;
  variant?: "card" | "compact";
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  lifecycleBadge?: string;
}

export function SettingsSwitchCard({
  icon: Icon,
  title,
  subtitle,
  isEnabled,
  onChange,
  ariaLabel,
  disabled,
  colorScheme = "accent",
  variant = "card",
  isModified,
  onReset,
  resetAriaLabel,
  lifecycleBadge,
}: SettingsSwitchCardProps) {
  const scheme = COLOR_SCHEMES[colorScheme];
  const isCard = variant === "card";
  const showReset = isModified && onReset && !disabled;

  const button = (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={isEnabled}
      aria-label={ariaLabel}
      className={cn(
        "relative w-full flex items-center justify-between transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        isCard ? "p-4 rounded-[var(--radius-lg)] border hover:bg-tint/5" : "py-2",
        isEnabled ? scheme.enabled : "border-daintree-border text-daintree-text/70",
        scheme.focus,
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      {isModified && isCard && (
        <div
          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-daintree-accent"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center gap-3">
        {Icon && (
          <Icon
            className={cn("w-5 h-5", isEnabled ? scheme.icon : "text-daintree-text/50")}
            aria-hidden="true"
          />
        )}
        <div className="text-left">
          <div className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
            {title}
            {lifecycleBadge && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-daintree-accent/10 border border-daintree-border/50 text-daintree-text/50 uppercase tracking-wide">
                {lifecycleBadge}
              </span>
            )}
          </div>
          <div className="text-xs opacity-70">{subtitle}</div>
        </div>
      </div>
      <div
        className={cn(
          "w-11 h-6 shrink-0 rounded-full relative transition-colors",
          isEnabled ? scheme.toggle : "bg-daintree-border"
        )}
        aria-hidden="true"
      >
        <div
          className={cn(
            "absolute top-1 w-4 h-4 rounded-full transition-transform",
            isEnabled ? "translate-x-6 bg-text-inverse" : "translate-x-1 bg-daintree-text"
          )}
        />
      </div>
    </button>
  );

  if (!showReset) return button;

  return (
    <div className="group relative">
      {button}
      <button
        type="button"
        aria-label={resetAriaLabel ?? `Reset ${title} to default`}
        className={cn(
          "absolute top-1/2 -translate-y-1/2 z-10 p-1 rounded-sm",
          "text-daintree-text/40 hover:text-daintree-accent",
          "invisible group-hover:visible group-focus-within:visible focus-visible:visible",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent",
          "transition-colors",
          isCard ? "right-[4.5rem]" : "right-[3.25rem]"
        )}
        onClick={onReset}
      >
        <RotateCcw className="w-3 h-3" />
      </button>
    </div>
  );
}
