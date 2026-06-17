import { SquareTerminal, Globe, Settings } from "lucide-react";
import { getBrandColorHex } from "@/lib/colorUtils";
import type { PanelKind } from "@/types";
import { AGENT_REGISTRY } from "@/config/agents";
import { getEffectiveAgentIds, getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import { isAssistantOnlyAgentId } from "@shared/config/agentIds";
import { resolveAgentIcon } from "@/config/agentIcons";

export interface LaunchOption {
  id: string;
  /** Agent id when this option launches an agent; absent for plain terminal/browser. Plain string so plugin-contributed agent ids are accepted, not just built-ins. */
  launchAgentId?: string;
  kind?: PanelKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}

export function getLaunchOptions(): LaunchOption[] {
  // Iterate the effective registry so plugin-contributed agents (merged below
  // built-ins by `getEffectiveRegistry`) are launchable here too, not just the
  // built-in set. Built-in metadata (presets, tooltip) lives in the richer
  // renderer `AGENT_REGISTRY`; plugin agents fall back to the effective config.
  const agentOptions: LaunchOption[] = getEffectiveAgentIds()
    // Assistant-only agents are never launchable from the New Terminal palette.
    .filter((id) => !isAssistantOnlyAgentId(id))
    .map((id) => {
    const builtIn = AGENT_REGISTRY[id];
    const config = builtIn ?? getEffectiveAgentConfig(id);
    const Icon = resolveAgentIcon(config?.iconId ?? id);
    const presetCount = builtIn?.presets?.length ?? 0;
    const description = builtIn?.tooltip ?? "";
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
