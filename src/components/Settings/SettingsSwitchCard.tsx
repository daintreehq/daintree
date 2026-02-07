import type { ComponentType } from "react";
import { cn } from "@/lib/utils";

const COLOR_SCHEMES = {
  accent: {
    enabled: "bg-canopy-accent/10 border-canopy-accent text-canopy-accent",
    icon: "text-canopy-accent",
    toggle: "bg-canopy-accent",
  },
  amber: {
    enabled: "bg-amber-500/10 border-amber-500 text-amber-500",
    icon: "text-amber-500",
    toggle: "bg-amber-500",
  },
} as const;

interface SettingsSwitchCardProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  isEnabled: boolean;
  onChange: () => void;
  ariaLabel: string;
  disabled?: boolean;
  colorScheme?: keyof typeof COLOR_SCHEMES;
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
}: SettingsSwitchCardProps) {
  const scheme = COLOR_SCHEMES[colorScheme];

  return (
    <button
      onClick={onChange}
      disabled={disabled}
      role="switch"
      aria-checked={isEnabled}
      aria-label={ariaLabel}
      className={cn(
        "w-full flex items-center justify-between p-4 rounded-[var(--radius-lg)] border transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-canopy-accent focus-visible:outline-offset-2",
        isEnabled ? scheme.enabled : "border-canopy-border hover:bg-white/5 text-canopy-text/70",
        disabled && "opacity-50 cursor-not-allowed"
      )}
    >
      <div className="flex items-center gap-3">
        <Icon className={cn("w-5 h-5", isEnabled ? scheme.icon : "text-canopy-text/50")} />
        <div className="text-left">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs opacity-70">{subtitle}</div>
        </div>
      </div>
      <div
        className={cn(
          "w-11 h-6 rounded-full relative transition-colors",
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
