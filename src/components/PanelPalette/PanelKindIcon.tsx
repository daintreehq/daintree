import { cn } from "@/lib/utils";
import { BrandMark } from "@/components/icons";
import { DEFAULT_PANEL_ICON, resolvePluginIcon } from "@/components/icons/pluginIconRegistry";
import { getAgentConfig } from "@/config/agents";

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

  // Panel chrome also renders built-ins and resume entries, so an unknown id
  // falls back to the terminal glyph rather than the plugin package one.
  const Icon = resolvePluginIcon(iconId, DEFAULT_PANEL_ICON);
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
