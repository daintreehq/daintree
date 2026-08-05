import type { ComponentType } from "react";
import {
  AlertCircle,
  Bell,
  GitPullRequest,
  Globe,
  Mic,
  MonitorPlay,
  SlidersHorizontal,
  SquareMenu,
  SquareTerminal,
} from "lucide-react";
import { FolderTree, Folders, History, Package, Plus } from "@/components/icons";
import {
  BUILT_IN_AGENT_IDS,
  isBuiltInAgentId,
  isAssistantOnlyAgentId,
} from "@shared/config/agentIds";
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
          label: `${name} agent`,
          icon: Icon,
          description: `Launch ${name} AI agent`,
        },
      ];
    })
  ) as Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>>;

export const TOOLBAR_BUTTON_METADATA: Partial<Record<AnyToolbarButtonId, ToolbarButtonMetadata>> = {
  launcher: {
    label: "Launcher",
    icon: Plus,
    description: "Dropdown for launching any agent or panel and pinning it to the toolbar",
  },
  "plugin-tray": {
    label: "Plugin tray",
    icon: Package,
    description: "Dropdown collecting every plugin's toolbar buttons",
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
  "file-browser": {
    label: "Browse files",
    icon: FolderTree,
    description: "Open the file browser for the active worktree or workspace",
  },
  "dev-server": {
    label: "Dev preview",
    icon: MonitorPlay,
    description: "Open dev preview panel",
  },
  "voice-recording": {
    label: "Voice recording",
    icon: Mic,
    description: "Persistent dictation indicator shown while recording is active",
  },
  "forge-stats": {
    label: "Repository stats",
    icon: GitPullRequest,
    description: "Issues, PRs, and commits",
  },
  "notification-center": {
    label: "Notifications",
    icon: Bell,
    description: "Notification history dropdown",
  },
  "copy-tree": {
    label: "Copy context",
    icon: Folders,
    description: "Copy project context to clipboard",
  },
  "command-palette": {
    label: "Command palette",
    icon: SquareMenu,
    description: "Search and run any action",
  },
  "resume-sessions": {
    label: "Resume session",
    icon: History,
    description: "Browse and resume closed agent sessions",
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
 * Canonical resolver for whether a button gets its own top-level toolbar slot.
 * Both `Toolbar.tsx` and `ToolbarSettingsTab.tsx` consume this so they can
 * never disagree (#7666).
 *
 * Agent IDs (entries in `BUILT_IN_AGENT_IDS`) route to `isAgentToolbarVisible`
 * — their pin lives in `agentSettingsStore`. Built-in IDs, including
 * `launcher` and `plugin-tray`, read from the toolbar store's
 * `pinnedButtons` map: an explicit `false` hides; missing or `true` shows.
 *
 * Registered plugin contributions invert that default (#11304): they reach the
 * user through the plugin tray, so a top-level slot is opt-in and requires an
 * explicit `true`. `isPluginContribution` is passed by callers that hold the
 * live broadcast config map — registry membership is the discriminator, never
 * string-parsing the dotted id, so a built-in that ever gains a dot can't be
 * mistaken for a plugin. It defaults to `false` so callers without that map
 * (e.g. `LauncherQuickActions`) keep their existing behavior.
 */
export function isToolbarButtonVisible(
  buttonId: AnyToolbarButtonId,
  pinnedButtons: ToolbarPinnedState,
  agentSettings: AgentSettings | null | undefined,
  agentAvailability: CliAvailability | null | undefined,
  isPluginContribution = false
): boolean {
  if (isBuiltInAgentId(buttonId)) {
    // Assistant-only agents are never offered as launchable toolbar buttons,
    // even when installed or somehow pinned — they exist only for the
    // Daintree Assistant overlay.
    if (isAssistantOnlyAgentId(buttonId)) return false;
    return isAgentToolbarVisible(agentSettings?.agents?.[buttonId], agentAvailability?.[buttonId]);
  }
  if (isPluginContribution) return pinnedButtons[buttonId] === true;
  return pinnedButtons[buttonId] !== false;
}
