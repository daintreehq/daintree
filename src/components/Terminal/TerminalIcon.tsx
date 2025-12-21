import { Terminal, Globe } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TerminalType, TerminalKind } from "@/types";
import { getAgentConfig, isRegisteredAgent } from "@/config/agents";

export interface TerminalIconProps {
  type?: TerminalType;
  kind?: TerminalKind;
  agentId?: string;
  className?: string;
  brandColor?: string;
}

export function TerminalIcon({ type, kind, agentId, className, brandColor }: TerminalIconProps) {
  const finalProps = {
    className: cn("w-4 h-4", className),
    "aria-hidden": "true" as const,
  };

  // Browser panes get a globe icon
  if (kind === "browser") {
    return <Globe {...finalProps} className={cn(finalProps.className, "text-blue-400")} />;
  }

  // Get effective agent ID - either from explicit agentId prop or from type (backward compat)
  const effectiveAgentId = agentId ?? (type && isRegisteredAgent(type) ? type : undefined);

  if (effectiveAgentId) {
    const config = getAgentConfig(effectiveAgentId);
    if (config) {
      const Icon = config.icon;
      return <Icon {...finalProps} brandColor={brandColor ?? config.color} />;
    }
  }

  // Fallback to generic terminal icon
  return <Terminal {...finalProps} />;
}
