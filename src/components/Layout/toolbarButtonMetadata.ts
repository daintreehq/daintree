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
// `@shared/...` because these are value imports — the type-only spelling above
// is erased at compile time and never has to resolve at runtime.
import {
  decodeLauncherItemToolbarButtonId,
  isLauncherItemToolbarButtonId,
} from "@shared/types/toolbar";
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
 * Left-toolbar groups, in the order they render (#11681).
 *
 * A divider is drawn wherever the group changes, so this array is the single
 * source of both the ordering and the separator positions. It replaces the
 * old `AGENT_TOOLBAR_IDS` predicate, which described an agent/non-agent flip
 * rather than a group: once a user reordered the toolbar, that flip landed
 * dividers in arbitrary positions and could split the agent brand marks.
 *
 * `utilities` trails deliberately. Any built-in a user drags onto the left
 * side — settings, notifications, copy-tree — plus every plugin contribution
 * lands there, and calling those "panels" would be a lie. On a normal layout
 * the group is empty and the row reads `[launcher] │ [agents] │ [panels]`.
 */
export const TOOLBAR_BUTTON_GROUP_ORDER = ["launcher", "agents", "panels", "utilities"] as const;

export type ToolbarButtonGroup = (typeof TOOLBAR_BUTTON_GROUP_ORDER)[number];

/**
 * A `Map`, not an object literal, because `getToolbarButtonGroup` looks up ids
 * that include plugin contributions — bracket-indexing a plain object with a
 * key the registry supplies would inherit `Object.prototype` members.
 */
const BUILT_IN_TOOLBAR_GROUPS: ReadonlyMap<AnyToolbarButtonId, ToolbarButtonGroup> = new Map<
  AnyToolbarButtonId,
  ToolbarButtonGroup
>([
  ["launcher", "launcher"],
  ["terminal", "panels"],
  ["file-browser", "panels"],
  ["browser", "panels"],
  ["dev-server", "panels"],
]);

/**
 * Canonical resolver for which left-toolbar group a button belongs to (#11681).
 *
 * Declared data, never derived from position: the group is a pure function of
 * the id and must stay that way. It is deliberately absent from `ToolbarLayout`
 * and `ToolbarPinnedState` — the side arrays reconcile last-writer-wins across
 * project views, so making array position carry meaning beyond display order
 * reopens the data loss #11667/#11671 had to unpick.
 *
 * Dispatch order mirrors `isToolbarButtonVisible` below: agent ids first,
 * registered plugin contributions second (registry membership is the
 * discriminator, never string-parsing the dotted id), launcher items third
 * (#12217 — a prefix the other two can never carry), then the built-in table,
 * and finally the trailing `utilities` fallback for anything unclassified.
 */
export function getToolbarButtonGroup(
  buttonId: AnyToolbarButtonId,
  isPluginContribution = false
): ToolbarButtonGroup {
  if (isBuiltInAgentId(buttonId)) return "agents";
  if (isPluginContribution) return "utilities";
  // Launcher items (#12217) group by the category their id declares, so a
  // pinned plugin agent stands with the built-in agents and a pinned Review
  // panel with the panel buttons rather than all of them landing in the
  // trailing `utilities` catch-all. A recipe is neither, so it does.
  const launcherItem = decodeLauncherItemToolbarButtonId(buttonId);
  if (launcherItem) {
    if (launcherItem.category === "agent") return "agents";
    if (launcherItem.category === "panel") return "panels";
    return "utilities";
  }
  return BUILT_IN_TOOLBAR_GROUPS.get(buttonId) ?? "utilities";
}

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
  // Launcher items invert the built-in default for the same reason plugin
  // contributions do (#12217): they already reach the user through the
  // launcher, so a top-level slot is opt-in and needs the explicit `true` the
  // pin writes. Without this, "absent means visible" would put every launcher
  // item that ever held a position onto the toolbar.
  if (isLauncherItemToolbarButtonId(buttonId)) return pinnedButtons[buttonId] === true;
  return pinnedButtons[buttonId] !== false;
}
