import type { ComponentType } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsSwitch } from "./SettingsSwitch";

const COLOR_SCHEMES = {
  accent: { icon: "text-daintree-accent" },
  amber: { icon: "text-status-warning" },
  danger: { icon: "text-status-error" },
};

interface SettingsSwitchCardProps {
  icon?: ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  isEnabled: boolean;
  onChange: () => void;
  ariaLabel: string;
  disabled?: boolean;
  colorScheme?: "accent" | "amber" | "danger";
  variant?: "card" | "compact";
  isModified?: boolean;
  onReset?: () => void;
  resetAriaLabel?: string;
  lifecycleBadge?: string;
  scope?: "default" | "global" | "project";
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
  scope,
}: SettingsSwitchCardProps) {
  const scheme = COLOR_SCHEMES[colorScheme] ?? COLOR_SCHEMES.accent;
  const isCard = variant === "card";
  const showReset = isModified && onReset && !disabled;

  const handleCardClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('[role="switch"]') || target.closest('button[type="button"]')) {
      return;
    }
    onChange();
  };

  const scopeBadge = scope ? (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
        scope === "project"
          ? "bg-daintree-accent/10 text-daintree-accent dark:bg-daintree-accent/20"
          : scope === "global"
            ? "bg-blue-500/10 text-blue-500 dark:bg-blue-500/20"
            : "bg-text-secondary/10 text-text-secondary dark:bg-text-secondary/20"
      }`}
    >
      {scope === "project" ? "Project" : scope === "global" ? "Global" : "Default"}
    </span>
  ) : null;

  const card = (
    <div
      className={cn(
        "relative w-full flex items-center justify-between transition",
        isCard ? "p-4 rounded-[var(--radius-lg)] border hover:bg-tint/5" : "py-2",
        "border-daintree-border text-daintree-text/70",
        isEnabled && "border-daintree-border text-daintree-text",
        disabled && "opacity-50"
      )}
      onClick={disabled ? undefined : handleCardClick}
    >
      {isModified && isCard && (
        <div
          className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-daintree-accent"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center gap-3 flex-1">
        {Icon && (
          <Icon
            className={cn("w-5 h-5", isEnabled ? scheme.icon : "text-daintree-text/50")}
            aria-hidden="true"
          />
        )}
        <div className="text-left">
          <div className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
            {title}
            {scopeBadge}
            {lifecycleBadge && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-daintree-accent/10 border border-daintree-border/50 text-daintree-text/50 uppercase tracking-wide">
                {lifecycleBadge}
              </span>
            )}
          </div>
          <div className="text-xs opacity-70">{subtitle}</div>
        </div>
      </div>
      <SettingsSwitch
        checked={isEnabled}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
        colorScheme={colorScheme}
      />
    </div>
  );

  if (!showReset) return card;

  return (
    <div className="group relative">
      {card}
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
