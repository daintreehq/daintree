import type { ComponentType } from "react";
import {
  AlertCircle,
  Bell,
  GitPullRequest,
  Globe,
  Mic,
  MonitorPlay,
  Plug,
  SlidersHorizontal,
  SquareTerminal,
} from "lucide-react";
import { Folders } from "@/components/icons";
import { BUILT_IN_AGENT_IDS, isBuiltInAgentId } from "@shared/config/agentIds";
import type { AnyToolbarButtonId, ToolbarPinnedState } from "@/../../shared/types/toolbar";
import type { AgentSettings, CliAvailability } from "@shared/types";
import { isAgentToolbarVisible } from "../../../shared/utils/agentPinned";
import { getAgentConfig } from "@/config/agents";

export interface ToolbarButtonIconProps {
  className?: string;
}

export interface ToolbarButtonMetadata {
  label: string;
  icon: ComponentType<ToolbarButtonIconProps>;
  description: string;
}

// Built-in agent entries are derived from the canonical agent registry so the
// icon shown in Settings, the agent tray, and the overflow dropdown all
// resolve from the same source (#7666 / #7668).
const AGENT_METADATA: Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>> =
  Object.fromEntries(
    BUILT_IN_AGENT_IDS.map((id) => {
      const cfg = getAgentConfig(id);
      const name = cfg?.name ?? id;
      const Icon: ComponentType<ToolbarButtonIconProps> = cfg?.icon ?? SquareTerminal;
      return [
        id,
        {
          label: `${name} Agent`,
          icon: Icon,
          description: `Launch ${name} AI agent`,
        },
      ];
    })
  ) as Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>>;

export const TOOLBAR_BUTTON_METADATA: Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>> = {
  "agent-tray": {
    label: "Agent Tray",
    icon: Plug,
    description: "Dropdown for launching any agent and jumping into setup",
  },
  ...AGENT_METADATA,
  terminal: {
    label: "Terminal",
    icon: SquareTerminal,
    description: "Open new terminal",
  },
  browser: {
    label: "Browser",
    icon: Globe,
    description: "Open browser panel",
  },
  "dev-server": {
    label: "Dev Preview",
    icon: MonitorPlay,
    description: "Open dev preview panel",
  },
  "voice-recording": {
    label: "Voice recording",
    icon: Mic,
    description: "Persistent dictation indicator shown while recording is active",
  },
  "github-stats": {
    label: "GitHub Stats",
    icon: GitPullRequest,
    description: "GitHub issues, PRs, and commits",
  },
  "notification-center": {
    label: "Notifications",
    icon: Bell,
    description: "Notification history dropdown",
  },
  "copy-tree": {
    label: "Copy Context",
    icon: Folders,
    description: "Copy project context to clipboard",
  },
  settings: {
    label: "Settings",
    icon: SlidersHorizontal,
    description: "Open settings dialog",
  },
  problems: {
    label: "Problems",
    icon: AlertCircle,
    description: "Show problems panel",
  },
};

/**
 * Canonical visibility resolver for toolbar buttons. Both `Toolbar.tsx` and
 * `ToolbarSettingsTab.tsx` consume this so they can never disagree about
 * whether a button should appear (#7666).
 *
 * Agent IDs (entries in `BUILT_IN_AGENT_IDS`) route to `isAgentToolbarVisible`
 * — their pin lives in `agentSettingsStore`. Every other ID, including
 * `agent-tray` and plugin buttons, reads from the toolbar store's
 * `pinnedButtons` map: an explicit `false` hides; missing or `true` shows.
 */
export function isToolbarButtonVisible(
  buttonId: AnyToolbarButtonId,
  pinnedButtons: ToolbarPinnedState,
  agentSettings: AgentSettings | null | undefined,
  agentAvailability: CliAvailability | null | undefined
): boolean {
  if (isBuiltInAgentId(buttonId)) {
    return isAgentToolbarVisible(agentSettings?.agents?.[buttonId], agentAvailability?.[buttonId]);
  }
  return pinnedButtons[buttonId] !== false;
}
