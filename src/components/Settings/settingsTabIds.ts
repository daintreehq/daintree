// Tab ids and the tiny validators derived from them, kept free of component
// imports so boot-path consumers (useSettingsDialog) don't pull the full
// settingsTabRegistry chunk (GeneralTab + settings stores) into App's eager
// closure. settingsTabRegistry re-exports everything here and carries
// compile-time drift guards in both directions.

export const GLOBAL_SETTINGS_TAB_IDS = [
  "general",
  "terminalAppearance",
  "keyboard",
  "notifications",
  "privacy",
  "terminal",
  "worktree",
  "toolbar",
  "environment",
  "assistant",
  "agents",
  "code-forge",
  "integrations",
  "voice",
  "portal",
  "mcp",
  "plugins",
  "plugin-actions",
  "run-history",
  "troubleshooting",
] as const;

export const PROJECT_SETTINGS_TAB_IDS = [
  "project:general",
  "project:context",
  "project:variables",
  "project:automation",
  "project:recipes",
  "project:commands",
  "project:notifications",
  "project:code-forge",
  "project:plugins",
] as const;

export type GlobalSettingsTab = (typeof GLOBAL_SETTINGS_TAB_IDS)[number];
export type ProjectSettingsTab = (typeof PROJECT_SETTINGS_TAB_IDS)[number];
export type SettingsTab = GlobalSettingsTab | ProjectSettingsTab;
export type SettingsScope = "global" | "project";

const ALL_SETTINGS_TAB_IDS: ReadonlySet<string> = new Set<string>([
  ...GLOBAL_SETTINGS_TAB_IDS,
  ...PROJECT_SETTINGS_TAB_IDS,
]);

export function scopeForTab(tab: SettingsTab): SettingsScope {
  return tab.startsWith("project:") ? "project" : "global";
}

export function isSettingsTab(value: string): value is SettingsTab {
  return ALL_SETTINGS_TAB_IDS.has(value);
}
