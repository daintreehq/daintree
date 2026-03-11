import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

const COLOR_SCHEMES = {
  accent: {
    enabled: "border-canopy-border text-canopy-text",
    icon: "text-canopy-accent",
    toggle: "bg-canopy-accent",
    focus: "focus-visible:outline-canopy-accent",
  },
  amber: {
    enabled: "border-canopy-border text-canopy-text",
    icon: "text-status-warning",
    toggle: "bg-status-warning",
    focus: "focus-visible:outline-status-warning",
  },
  danger: {
    enabled: "border-canopy-border text-canopy-text",
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
}: SettingsSwitchCardProps) {
  const scheme = COLOR_SCHEMES[colorScheme];
  const isCard = variant === "card";

  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={isEnabled}
      aria-label={ariaLabel}
      className={cn(
        "w-full flex items-center justify-between transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2",
        isCard ? "p-4 rounded-[var(--radius-lg)] border hover:bg-white/5" : "py-2",
        isEnabled ? scheme.enabled : "border-canopy-border text-canopy-text/70",
        scheme.focus,
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <div className="flex items-center gap-3">
        {Icon && (
          <Icon
            className={cn("w-5 h-5", isEnabled ? scheme.icon : "text-canopy-text/50")}
            aria-hidden="true"
          />
        )}
        <div className="text-left">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs opacity-70">{subtitle}</div>
        </div>
      </div>
      <div
        className={cn(
          "w-11 h-6 shrink-0 rounded-full relative transition-colors",
          isEnabled ? scheme.toggle : "bg-canopy-border"
        )}
        aria-hidden="true"
      >
        <div
          className={cn(
            "absolute top-1 w-4 h-4 rounded-full bg-white transition-transform",
            isEnabled ? "translate-x-6" : "translate-x-1"
          )}
        />
      </div>
    </button>
  );
}
