import { SquareTerminal, Globe, FileText, GitBranch, Monitor, LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CanopyIcon } from "@/components/icons";
import { getAgentConfig } from "@/config/agents";
import type { ComponentType } from "react";

const ICON_MAP: Record<string, LucideIcon | ComponentType<Record<string, unknown>>> = {
  terminal: SquareTerminal,
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
  const agentConfig = getAgentConfig(iconId);
  if (agentConfig) {
    const AgentIcon = agentConfig.icon;
    return (
      <AgentIcon
        brandColor={color}
        className={cn("shrink-0", className)}
        size={size}
        aria-hidden="true"
      />
    );
  }

  const Icon = ICON_MAP[iconId] ?? SquareTerminal;
  return (
    <Icon
      style={color ? { color } : undefined}
      className={cn("shrink-0", className)}
      width={size}
      height={size}
      size={size}
      aria-hidden="true"
    />
  );
}
