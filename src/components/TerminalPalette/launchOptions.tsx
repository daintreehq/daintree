import { SquareTerminal, Globe, Settings } from "lucide-react";
import { getBrandColorHex } from "@/lib/colorUtils";
import type { PanelKind } from "@/types";
import type { BuiltInAgentId } from "@shared/config/agentIds";
import { AGENT_REGISTRY } from "@/config/agents";
import { BUILT_IN_AGENT_IDS } from "@shared/config/agentIds";
import { resolveAgentIcon } from "@/config/agentIcons";

export interface LaunchOption {
  id: string;
  /** Agent id when this option launches an agent; absent for plain terminal/browser. */
  launchAgentId?: BuiltInAgentId;
  kind?: PanelKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}

export function getLaunchOptions(): LaunchOption[] {
  const agentOptions: LaunchOption[] = BUILT_IN_AGENT_IDS.map((id) => {
    const config = AGENT_REGISTRY[id];
    const Icon = resolveAgentIcon(config?.iconId ?? id);
    const presetCount = config?.presets?.length ?? 0;
    const description = config?.tooltip ?? "";
    const presetSuffix = presetCount > 0 ? ` (${presetCount} presets)` : "";
    return {
      id,
      launchAgentId: id,
      label: config?.name ?? id,
      description: `${description}${presetSuffix}`.trim(),
      icon: <Icon className="w-4 h-4" brandColor={getBrandColorHex(id)} />,
    };
  });

  return [
    ...agentOptions,
    {
      id: "terminal",
      label: "Terminal",
      description: "Standard system shell (zsh/bash/powershell).",
      icon: <SquareTerminal className="w-4 h-4" />,
    },
    {
      id: "browser",
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
    label: "More agents...",
    description: "Configure which agents appear in this menu",
    icon: <Settings className="w-4 h-4 text-daintree-text/50" />,
  };
}
