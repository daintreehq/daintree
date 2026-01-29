import { Terminal, Globe, FileText, GitBranch, Monitor, LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CanopyIcon } from "@/components/icons";
import type { ComponentType } from "react";

const ICON_MAP: Record<
  string,
  | LucideIcon
  | ComponentType<{
      className?: string;
      style?: Record<string, string>;
      width?: number;
      height?: number;
    }>
> = {
  terminal: Terminal,
  globe: Globe,
  "file-text": FileText,
  "git-branch": GitBranch,
  monitor: Monitor,
  canopy: CanopyIcon,
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
      style={color ? { color } : undefined}
      className={cn("shrink-0", className)}
      width={size}
      height={size}
      aria-hidden="true"
    />
  );
}
