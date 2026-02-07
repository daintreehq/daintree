import { Terminal, Globe, FileText, GitBranch, Monitor, LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CanopyIcon, ClaudeIcon, GeminiIcon, CodexIcon, OpenCodeIcon } from "@/components/icons";
import type { ComponentType } from "react";

const ICON_MAP: Record<string, LucideIcon | ComponentType<Record<string, unknown>>> = {
  terminal: Terminal,
  globe: Globe,
  "file-text": FileText,
  "git-branch": GitBranch,
  monitor: Monitor,
  canopy: CanopyIcon,
  claude: ClaudeIcon,
  gemini: GeminiIcon,
  codex: CodexIcon,
  opencode: OpenCodeIcon,
};

const AGENT_ICON_IDS = new Set(["claude", "gemini", "codex", "opencode"]);

export interface PanelKindIconProps {
  iconId: string;
  color?: string;
  size?: number;
  className?: string;
}

export function PanelKindIcon({ iconId, color, size = 16, className }: PanelKindIconProps) {
  const Icon = ICON_MAP[iconId] ?? Terminal;
  const isAgent = AGENT_ICON_IDS.has(iconId);

  return (
    <Icon
      {...(isAgent ? { brandColor: color } : { style: color ? { color } : undefined })}
      className={cn("shrink-0", className)}
      width={size}
      height={size}
      size={size}
      aria-hidden="true"
    />
  );
}
