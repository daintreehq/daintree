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
    <div
      className="grid grid-cols-[minmax(0,1fr)] gap-3 scroll-mt-12"
      id={id}
      role="group"
      aria-labelledby={headingId}
    >
      {/* -mx-6/px-6 mirror the SettingsDialog scrollport's p-6 padding so the
          sticky header background bleeds edge-to-edge; keep them in sync. */}
      <div className="settings-section-header sticky top-0 z-20 -mx-6 px-6 pb-1.5">
        <h4
          id={headingId}
          className="text-sm font-medium text-daintree-text mb-1.5 flex items-center gap-2 flex-wrap"
        >
          <Icon className={cn("w-4 h-4", iconColor)} aria-hidden="true" />
          {title}
          {badge && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-status-info/10 border border-daintree-border/50 text-daintree-text/50 uppercase tracking-wide">
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
