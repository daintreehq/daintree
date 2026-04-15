import { useId } from "react";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsSectionProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  iconColor?: string;
  children: ReactNode;
  id?: string;
  badge?: string;
}

export function SettingsSection({
  icon: Icon,
  title,
  description,
  iconColor = "text-daintree-text/70",
  children,
  id,
  badge,
}: SettingsSectionProps) {
  const headingId = useId();

  return (
    <div className="flex flex-col gap-3" id={id} role="group" aria-labelledby={headingId}>
      <div>
        <h4
          id={headingId}
          className="text-sm font-medium text-daintree-text mb-1.5 flex items-center gap-2 flex-wrap"
        >
          <Icon className={cn("w-4 h-4", iconColor)} aria-hidden="true" />
          {title}
          {badge && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-daintree-accent/10 border border-daintree-border/50 text-daintree-text/50 uppercase tracking-wide">
              {badge}
            </span>
          )}
        </h4>
        <p className="text-xs text-daintree-text/50 select-text">{description}</p>
      </div>
      {children}
    </div>
  );
}
