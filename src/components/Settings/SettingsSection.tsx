import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsSectionProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  iconColor?: string;
  children: ReactNode;
  id?: string;
}

export function SettingsSection({
  icon: Icon,
  title,
  description,
  iconColor = "text-canopy-text/70",
  children,
  id,
}: SettingsSectionProps) {
  return (
    <div className="space-y-6" id={id}>
      <div>
        <h4 className="text-sm font-medium text-canopy-text mb-1.5 flex items-center gap-2">
          <Icon className={cn("w-4 h-4", iconColor)} aria-hidden="true" />
          {title}
        </h4>
        <p className="text-xs text-canopy-text/50">{description}</p>
      </div>
      {children}
    </div>
  );
}
