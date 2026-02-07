import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsSectionProps {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
  iconColor?: string;
  children: ReactNode;
}

export function SettingsSection({
  icon: Icon,
  title,
  description,
  iconColor = "text-canopy-text/70",
  children,
}: SettingsSectionProps) {
  return (
    <div className="space-y-4">
      <div>
        <h4 className="text-sm font-medium text-canopy-text mb-2 flex items-center gap-2">
          <Icon className={cn("w-4 h-4", iconColor)} />
          {title}
        </h4>
        <p className="text-xs text-canopy-text/50 mb-4">{description}</p>
      </div>
      {children}
    </div>
  );
}
