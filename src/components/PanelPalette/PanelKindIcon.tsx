import {
  SquareTerminal,
  Globe,
  FileText,
  Monitor,
  MonitorPlay,
  StickyNote,
  LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { BrandMark, DaintreeIcon, FolderGit2 } from "@/components/icons";
import { getAgentConfig } from "@/config/agents";
import type { ComponentType } from "react";

const ICON_MAP: Record<string, LucideIcon | ComponentType<Record<string, unknown>>> = {
  terminal: SquareTerminal,
  globe: Globe,
  "file-text": FileText,
  "git-branch": FolderGit2,
  monitor: Monitor,
  "monitor-play": MonitorPlay,
  "sticky-note": StickyNote,
  daintree: DaintreeIcon,
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
    const brandColor = color ?? agentConfig.color;
    return (
      <BrandMark brandColor={brandColor} size={size} className={cn("shrink-0", className)}>
        <AgentIcon brandColor={brandColor} size={size} aria-hidden="true" />
      </BrandMark>
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
