import { lazy, type ReactNode } from "react";
import {
  Blocks,
  Github,
  LayoutGrid,
  Mic,
  PanelRight,
  Keyboard,
  SquareTerminal,
  Settings as SettingsIcon,
  Settings2,
  LifeBuoy,
  Bell,
  KeyRound,
  Shield,
} from "lucide-react";
import { DaintreeIcon, FolderGit2, Plug, McpServerIcon } from "@/components/icons";
import { GeneralTab } from "./GeneralTab";

// ── Entry types ─────────────────────────────────────────────────────────

export interface SettingsTabEntry {
  readonly id: string;
  readonly scope: "global" | "project";
  readonly group: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly importKind: "eager" | "lazy";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous component storage
type AnyComponent = React.ComponentType<any>;

export interface LazySettingsTabEntry extends SettingsTabEntry {
  readonly importKind: "lazy";
  readonly importer: () => Promise<unknown>;
  readonly LazyComponent: AnyComponent;
  readonly needsSubtabs?: boolean;
  readonly needsOnClose?: boolean;
  readonly needsOnSettingsChange?: boolean;
}

export interface EagerSettingsTabEntry extends SettingsTabEntry {
  readonly importKind: "eager";
  readonly Component: AnyComponent;
}

export type AnySettingsTabEntry = LazySettingsTabEntry | EagerSettingsTabEntry;

// ── Lazy import thunks (module-level for referential stability) ─────────

const importAgentSettings = () => import("./AgentSettings");
const importTerminalSettingsTab = () => import("./TerminalSettingsTab");
const importTerminalAppearanceTab = () => import("./TerminalAppearanceTab");
const importGitHubSettingsTab = () => import("./GitHubSettingsTab");
const importTroubleshootingTab = () => import("./TroubleshootingTab");
const importNotificationSettingsTab = () => import("./NotificationSettingsTab");
const importPortalSettingsTab = () => import("./PortalSettingsTab");
const importKeyboardShortcutsTab = () => import("./KeyboardShortcutsTab");
const importWorktreeSettingsTab = () => import("./WorktreeSettingsTab");
const importToolbarSettingsTab = () => import("./ToolbarSettingsTab");
const importIntegrationsTab = () => import("./IntegrationsTab");
const importVoiceInputSettingsTab = () => import("./VoiceInputSettingsTab");
const importMcpServerSettingsTab = () => import("./McpServerSettingsTab");
const importDaintreeAssistantSettingsTab = () => import("./DaintreeAssistantSettingsTab");
const importEnvironmentSettingsTab = () => import("./EnvironmentSettingsTab");
const importPrivacyDataTab = () => import("./PrivacyDataTab");

// ── Lazy components (module-level — React requires stable lazy() refs) ──

const LazyAgentSettings = lazy(() =>
  importAgentSettings().then((m) => ({ default: m.AgentSettings }))
);
const LazyTerminalSettingsTab = lazy(() =>
  importTerminalSettingsTab().then((m) => ({ default: m.TerminalSettingsTab }))
);
const LazyTerminalAppearanceTab = lazy(() =>
  importTerminalAppearanceTab().then((m) => ({ default: m.TerminalAppearanceTab }))
);
const LazyGitHubSettingsTab = lazy(() =>
  importGitHubSettingsTab().then((m) => ({ default: m.GitHubSettingsTab }))
);
const LazyTroubleshootingTab = lazy(() =>
  importTroubleshootingTab().then((m) => ({ default: m.TroubleshootingTab }))
);
const LazyNotificationSettingsTab = lazy(() =>
  importNotificationSettingsTab().then((m) => ({ default: m.NotificationSettingsTab }))
);
const LazyPortalSettingsTab = lazy(() =>
  importPortalSettingsTab().then((m) => ({ default: m.PortalSettingsTab }))
);
const LazyKeyboardShortcutsTab = lazy(() =>
  importKeyboardShortcutsTab().then((m) => ({ default: m.KeyboardShortcutsTab }))
);
const LazyWorktreeSettingsTab = lazy(() =>
  importWorktreeSettingsTab().then((m) => ({ default: m.WorktreeSettingsTab }))
);
const LazyToolbarSettingsTab = lazy(() =>
  importToolbarSettingsTab().then((m) => ({ default: m.ToolbarSettingsTab }))
);
const LazyIntegrationsTab = lazy(() =>
  importIntegrationsTab().then((m) => ({ default: m.IntegrationsTab }))
);
const LazyVoiceInputSettingsTab = lazy(() =>
  importVoiceInputSettingsTab().then((m) => ({ default: m.VoiceInputSettingsTab }))
);
const LazyMcpServerSettingsTab = lazy(() =>
  importMcpServerSettingsTab().then((m) => ({ default: m.McpServerSettingsTab }))
);
const LazyDaintreeAssistantSettingsTab = lazy(() =>
  importDaintreeAssistantSettingsTab().then((m) => ({ default: m.DaintreeAssistantSettingsTab }))
);
const LazyEnvironmentSettingsTab = lazy(() =>
  importEnvironmentSettingsTab().then((m) => ({ default: m.EnvironmentSettingsTab }))
);
const LazyPrivacyDataTab = lazy(() =>
  importPrivacyDataTab().then((m) => ({ default: m.PrivacyDataTab }))
);

// ── Registry (module-level const — stable identity for Fuse.js WeakMap) ─

export const SETTINGS_REGISTRY = [
  // ═══ Global — General ═══
  {
    id: "general",
    scope: "global",
    group: "General",
    label: "General",
    icon: <Settings2 className="w-4 h-4" />,
    importKind: "eager",
    Component: GeneralTab,
  } satisfies EagerSettingsTabEntry,

  {
    id: "terminalAppearance",
    scope: "global",
    group: "General",
    label: "Appearance",
    icon: <SquareTerminal className="w-4 h-4" />,
    importKind: "lazy",
    importer: importTerminalAppearanceTab,
    LazyComponent: LazyTerminalAppearanceTab,
    needsSubtabs: true,
    needsOnClose: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "keyboard",
    scope: "global",
    group: "General",
    label: "Keyboard",
    icon: <Keyboard className="w-4 h-4" />,
    importKind: "lazy",
    importer: importKeyboardShortcutsTab,
    LazyComponent: LazyKeyboardShortcutsTab,
  } satisfies LazySettingsTabEntry,

  {
    id: "notifications",
    scope: "global",
    group: "General",
    label: "Notifications",
    icon: <Bell className="w-4 h-4" />,
    importKind: "lazy",
    importer: importNotificationSettingsTab,
    LazyComponent: LazyNotificationSettingsTab,
  } satisfies LazySettingsTabEntry,

  {
    id: "privacy",
    scope: "global",
    group: "General",
    label: "Privacy & Data",
    icon: <Shield className="w-4 h-4" />,
    importKind: "lazy",
    importer: importPrivacyDataTab,
    LazyComponent: LazyPrivacyDataTab,
    needsSubtabs: true,
  } satisfies LazySettingsTabEntry,

  // ═══ Global — Terminal ═══
  {
    id: "terminal",
    scope: "global",
    group: "Terminal",
    label: "Panel Grid",
    icon: <LayoutGrid className="w-4 h-4" />,
    importKind: "lazy",
    importer: importTerminalSettingsTab,
    LazyComponent: LazyTerminalSettingsTab,
    needsSubtabs: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "worktree",
    scope: "global",
    group: "Terminal",
    label: "Worktree",
    icon: <FolderGit2 className="w-4 h-4" />,
    importKind: "lazy",
    importer: importWorktreeSettingsTab,
    LazyComponent: LazyWorktreeSettingsTab,
  } satisfies LazySettingsTabEntry,

  {
    id: "toolbar",
    scope: "global",
    group: "Terminal",
    label: "Toolbar",
    icon: <SettingsIcon className="w-4 h-4" />,
    importKind: "lazy",
    importer: importToolbarSettingsTab,
    LazyComponent: LazyToolbarSettingsTab,
  } satisfies LazySettingsTabEntry,

  {
    id: "environment",
    scope: "global",
    group: "Terminal",
    label: "Environment",
    icon: <KeyRound className="w-4 h-4" />,
    importKind: "lazy",
    importer: importEnvironmentSettingsTab,
    LazyComponent: LazyEnvironmentSettingsTab,
  } satisfies LazySettingsTabEntry,

  // ═══ Global — Assistant ═══
  {
    id: "assistant",
    scope: "global",
    group: "Assistant",
    label: "Daintree Assistant",
    icon: <DaintreeIcon className="w-4 h-4" size={16} />,
    importKind: "lazy",
    importer: importDaintreeAssistantSettingsTab,
    LazyComponent: LazyDaintreeAssistantSettingsTab,
  } satisfies LazySettingsTabEntry,

  // ═══ Global — Integrations ═══
  {
    id: "agents",
    scope: "global",
    group: "Integrations",
    label: "CLI Agents",
    icon: <Plug className="w-4 h-4" />,
    importKind: "lazy",
    importer: importAgentSettings,
    LazyComponent: LazyAgentSettings,
    needsSubtabs: true,
    needsOnSettingsChange: true,
  } satisfies LazySettingsTabEntry,

  {
    id: "github",
    scope: "global",
    group: "Integrations",
    label: "GitHub",
    icon: <Github className="w-4 h-4" />,
    importKind: "lazy",
    importer: importGitHubSettingsTab,
    LazyComponent: LazyGitHubSettingsTab,
  } satisfies LazySettingsTabEntry,

  {
    id: "integrations",
    scope: "global",
    group: "Integrations",
    label: "Integrations",
    icon: <Blocks className="w-4 h-4" />,
    importKind: "lazy",
    importer: importIntegrationsTab,
    LazyComponent: LazyIntegrationsTab,
  } satisfies LazySettingsTabEntry,

  {
    id: "voice",
    scope: "global",
    group: "Integrations",
    label: "Voice Input",
    icon: <Mic className="w-4 h-4" />,
    importKind: "lazy",
    importer: importVoiceInputSettingsTab,
    LazyComponent: LazyVoiceInputSettingsTab,
  } satisfies LazySettingsTabEntry,

  {
    id: "portal",
    scope: "global",
    group: "Integrations",
    label: "Portal",
    icon: <PanelRight className="w-4 h-4" />,
    importKind: "lazy",
    importer: importPortalSettingsTab,
    LazyComponent: LazyPortalSettingsTab,
  } satisfies LazySettingsTabEntry,

  {
    id: "mcp",
    scope: "global",
    group: "Integrations",
    label: "MCP Server",
    icon: <McpServerIcon className="w-4 h-4" />,
    importKind: "lazy",
    importer: importMcpServerSettingsTab,
    LazyComponent: LazyMcpServerSettingsTab,
  } satisfies LazySettingsTabEntry,

  // ═══ Global — Support ═══
  {
    id: "troubleshooting",
    scope: "global",
    group: "Support",
    label: "Troubleshooting",
    icon: <LifeBuoy className="w-4 h-4" />,
    importKind: "lazy",
    importer: importTroubleshootingTab,
    LazyComponent: LazyTroubleshootingTab,
  } satisfies LazySettingsTabEntry,
] as const satisfies readonly AnySettingsTabEntry[];

// ── Project tab IDs (not in registry — rendered with unique prop patterns) ─

export const PROJECT_TAB_IDS = [
  "project:general",
  "project:context",
  "project:variables",
  "project:automation",
  "project:recipes",
  "project:commands",
  "project:notifications",
  "project:github",
] as const;

export type ProjectSettingsTab = (typeof PROJECT_TAB_IDS)[number];
export type GlobalSettingsTab = (typeof SETTINGS_REGISTRY)[number]["id"];
export type SettingsTab = GlobalSettingsTab | ProjectSettingsTab;
export type SettingsScope = "global" | "project";

// ── Derived maps ────────────────────────────────────────────────────────

const _entryMap = new Map(SETTINGS_REGISTRY.map((e) => [e.id, e]));

export function getSettingsTabEntry(id: string): AnySettingsTabEntry | undefined {
  return _entryMap.get(id);
}

export const globalTabTitles = Object.fromEntries(
  SETTINGS_REGISTRY.map((e) => [e.id, e.label])
) as Record<GlobalSettingsTab, string>;

export const globalTabIcons: Record<GlobalSettingsTab, ReactNode> = {
  general: <Settings2 className="w-5 h-5 text-text-secondary" />,
  keyboard: <Keyboard className="w-5 h-5 text-text-secondary" />,
  terminal: <LayoutGrid className="w-5 h-5 text-text-secondary" />,
  terminalAppearance: <SquareTerminal className="w-5 h-5 text-text-secondary" />,
  worktree: <FolderGit2 className="w-5 h-5 text-text-secondary" />,
  agents: <Plug className="w-5 h-5 text-text-secondary" />,
  assistant: <DaintreeIcon className="w-5 h-5 text-text-secondary" size={20} />,
  github: <Github className="w-5 h-5 text-text-secondary" />,
  portal: <PanelRight className="w-5 h-5 text-text-secondary" />,
  toolbar: <SettingsIcon className="w-5 h-5 text-text-secondary" />,
  notifications: <Bell className="w-5 h-5 text-text-secondary" />,
  integrations: <Blocks className="w-5 h-5 text-text-secondary" />,
  voice: <Mic className="w-5 h-5 text-text-secondary" />,
  mcp: <McpServerIcon className="w-5 h-5 text-text-secondary" />,
  environment: <KeyRound className="w-5 h-5 text-text-secondary" />,
  privacy: <Shield className="w-5 h-5 text-text-secondary" />,
  troubleshooting: <LifeBuoy className="w-5 h-5 text-text-secondary" />,
};

export function scopeForTab(tab: SettingsTab): SettingsScope {
  return tab.startsWith("project:") ? "project" : "global";
}

export function isSettingsTab(value: string): value is SettingsTab {
  return _entryMap.has(value) || (PROJECT_TAB_IDS as readonly string[]).includes(value);
}

export function preloadAllSettingsTabs(): void {
  for (const entry of SETTINGS_REGISTRY) {
    if (entry.importKind === "lazy") {
      void entry.importer();
    }
  }
}

// ── Nav group ordering ──────────────────────────────────────────────────

export interface SettingsNavGroup {
  label: string;
  scope: SettingsScope;
  entries: AnySettingsTabEntry[];
}

const GLOBAL_GROUP_ORDER = ["General", "Terminal", "Assistant", "Integrations", "Support"];

const _globalGroups: SettingsNavGroup[] = GLOBAL_GROUP_ORDER.map((label) => ({
  label,
  scope: "global" as const,
  entries: SETTINGS_REGISTRY.filter((e) => e.group === label),
})).filter((g) => g.entries.length > 0);

export function getSettingsNavGroups(scope: SettingsScope): SettingsNavGroup[] {
  if (scope === "global") return _globalGroups;

  return [
    {
      label: "Project",
      scope: "project",
      entries: [], // project tabs are not in the registry; rendered separately
    },
  ];
}
