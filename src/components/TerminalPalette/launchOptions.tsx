import { SquareTerminal, Globe, Settings } from "lucide-react";
import { getBrandColorHex } from "@/lib/colorUtils";
import type { TerminalType, PanelKind } from "@/types";
import { AGENT_REGISTRY } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { resolveAgentIcon } from "@/config/agentIcons";

export interface LaunchOption {
  id: string;
  type: TerminalType;
  kind?: PanelKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}

export function getLaunchOptions(): LaunchOption[] {
  const agentOptions: LaunchOption[] = BUILT_IN_AGENT_IDS.map((id) => {
    const config = AGENT_REGISTRY[id];
    const Icon = resolveAgentIcon(config?.iconId ?? id);
    return {
      id,
      type: id as TerminalType,
      label: config?.name ?? id,
      description: config?.tooltip ?? "",
      icon: <Icon className="w-4 h-4" brandColor={getBrandColorHex(id)} />,
    };
  });

  return [
    ...agentOptions,
    {
      id: "terminal",
      type: "terminal",
      label: "Terminal",
      description: "Standard system shell (zsh/bash/powershell).",
      icon: <SquareTerminal className="w-4 h-4" />,
    },
    {
      id: "browser",
      type: "terminal",
      kind: "browser",
      label: "Browser",
      description: "Embed localhost dev server preview.",
      icon: <Globe className="w-4 h-4 text-status-info" />,
    },
  ];
}

export function getMoreAgentsOption(): LaunchOption {
  return {
    id: "more-agents",
    type: "terminal",
    label: "More agents...",
    description: "Configure which agents appear in this menu",
    icon: <Settings className="w-4 h-4 text-daintree-text/50" />,
  };
}
