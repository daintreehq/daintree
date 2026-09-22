import { useId } from "react";
import type { ComponentType } from "react";
import { RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsSwitch } from "./SettingsSwitch";

const COLOR_SCHEMES = {
  accent: { icon: "text-accent-primary" },
  amber: { icon: "text-status-warning" },
  danger: { icon: "text-status-error" },
};

interface SettingsSwitchCardProps {
  id?: string;
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
  id,
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
  const descriptionId = useId();
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
    <span className="text-3xs px-1.5 py-0.5 rounded-sm font-medium bg-text-secondary/10 text-text-secondary dark:bg-text-secondary/20">
      {scope === "project" ? "Project" : scope === "global" ? "Global" : "Default"}
    </span>
  ) : null;

  const card = (
    <div
      className={cn(
        "relative w-full flex items-center justify-between transition-colors",
        isCard ? "p-4 rounded-[var(--radius-lg)] border hover:bg-tint/5" : "py-2",
        // An off setting is still an available setting: it keeps full title contrast, and
        // only the switch position says which way it is set. Dimming the label too made
        // every off row read as disabled — and the genuinely disabled case below already
        // owns that treatment.
        "border-border-default text-text-primary",
        !disabled && "cursor-pointer",
        disabled && "opacity-50"
      )}
      onClick={disabled ? undefined : handleCardClick}
    >
      {isModified && isCard && (
        <div
          className="status-mark absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-state-modified"
          aria-hidden="true"
        />
      )}
      <div className="flex items-center gap-3 flex-1">
        {Icon && (
          <Icon
            // Neutral in both positions by default. Six enabled rows in one pane meant six
            // accent glyphs, i.e. accent standing for membership rather than for the one
            // load-bearing signal in the focus region. An explicit `colorScheme` still opts
            // a card into a status hue where the hue itself is the point. `text-muted` is
            // not an option for either position: it has no dark-theme contrast floor.
            className={cn(
              "w-5 h-5",
              isEnabled && colorScheme !== "accent" ? scheme.icon : "text-text-secondary"
            )}
            aria-hidden="true"
          />
        )}
        <div className="text-left">
          <div className="text-sm font-medium flex items-center gap-1.5 flex-wrap">
            {title}
            {scopeBadge}
            {lifecycleBadge && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-3xs font-medium bg-overlay-subtle border border-daintree-border/50 text-text-secondary uppercase tracking-wide">
                {lifecycleBadge}
              </span>
            )}
          </div>
          <div id={descriptionId} className="text-xs text-text-secondary">
            {subtitle}
          </div>
        </div>
      </div>
      <SettingsSwitch
        checked={isEnabled}
        onCheckedChange={onChange}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={descriptionId}
        colorScheme={colorScheme}
      />
    </div>
  );

  if (!showReset) {
    return (
      <div id={id} className="grid grid-cols-subgrid col-span-full gap-2">
        {card}
      </div>
    );
  }

  return (
    <div id={id} className="grid grid-cols-subgrid col-span-full gap-2">
      <div className="group relative">
        <button
          type="button"
          aria-label={resetAriaLabel ?? `Reset ${title} to default`}
          className={cn(
            "absolute top-1/2 -translate-y-1/2 z-10 p-1 rounded-sm",
            "text-daintree-text/40 hover:text-text-primary",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary",
            "transition-colors",
            isCard ? "right-[4.5rem]" : "right-[3.25rem]"
          )}
          onClick={onReset}
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        {card}
      </div>
    </div>
  );
}
