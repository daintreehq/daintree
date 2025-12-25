import { Terminal, Globe, FileText, GitBranch, Monitor, LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const ICON_MAP: Record<string, LucideIcon> = {
  terminal: Terminal,
  globe: Globe,
  "file-text": FileText,
  "git-branch": GitBranch,
  monitor: Monitor,
};

export interface PanelKindIconProps {
  iconId: string;
  color?: string;
  size?: number;
  className?: string;
}

export function PanelKindIcon({ iconId, color, size = 16, className }: PanelKindIconProps) {
  const Icon = ICON_MAP[iconId] ?? Terminal;

  return (
    <Icon
      style={{ color }}
      className={cn("shrink-0", className)}
      width={size}
      height={size}
      aria-hidden="true"
    />
  );
}
