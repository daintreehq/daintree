import type { ConfigBundleSectionId } from "../types/configBundle.js";

/**
 * What may travel from one machine to another, shared by Export/Import
 * Configuration (#11889) and Copy settings to a host (#13346) so the two can't
 * drift apart.
 *
 * Ownership (`electron/storeOwnership.ts`) says where a value lives, never
 * whether copying it makes sense, so this is a separate, positive list down to
 * fields: a setting that isn't named here stays on its machine, including every
 * one added after this was written. Never listed, on purpose:
 *
 * - Credentials of any kind (`userConfig`, `forgeCredentials`, the API key in
 *   `appAgentConfig`, the MCP server key and port).
 * - Consent and trust (`canopyMode`, plugin capability and MCP consent, project
 *   plugin trust, agent MCP access).
 * - Per-project and run state (project env, the worktree issue map, parked and
 *   snoozed runs, run history, audit records, `appState`).
 * - Plugin installs, which Settings → Hosts → Plugins handles one at a time.
 * - Behavioural terminal settings: several are hydrated once per window at
 *   boot, so a copy couldn't refresh the windows already open on the host.
 */

export type PortableSettingsCategoryId =
  | "customAgents"
  | "agentSettings"
  | "assistantModels"
  | "agentDefaults"
  | "notifications"
  | "worktreePath"
  | "globalRecipes"
  | "hibernation"
  | "sessionRestore"
  | "idleTerminals"
  | "updateChecks"
  | "globalEnvironment"
  | "permissionBypass"
  | "device";

export interface PortableSettingsCategory {
  id: PortableSettingsCategoryId;
  label: string;
  description: string;
  sections: readonly ConfigBundleSectionId[];
  /** Ticked when Copy settings opens. */
  selectedByDefault: boolean;
  /**
   * How Daintree looks and responds to someone sitting at that machine. A
   * window here attached to the host keeps drawing with this machine's.
   */
  device: boolean;
  /**
   * Carried by Export Configuration. A file is imported with no per-category
   * choice, so anything that should only travel when asked for stays out.
   */
  inFile: boolean;
}

export const PORTABLE_SETTINGS_CATEGORIES: readonly PortableSettingsCategory[] = [
  {
    id: "customAgents",
    label: "Custom agents",
    description: "Agents added beyond the built-in ones",
    sections: ["userAgentRegistry"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "agentSettings",
    label: "Agent settings",
    description: "Flags, presets and their environment variables, per agent",
    sections: ["agentSettings"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "assistantModels",
    label: "Assistant models",
    description: "The model each agent uses when it runs the assistant",
    sections: ["assistantModels"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "agentDefaults",
    label: "Default agents",
    description: "The agent new terminals start with, and the one the assistant runs",
    sections: ["agentDefaults"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "notifications",
    label: "Notifications",
    description: "Alerts, sounds and quiet hours",
    sections: ["notificationSettings"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "worktreePath",
    label: "Worktree path pattern",
    description: "Where new worktrees are created",
    sections: ["worktreeConfig"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "globalRecipes",
    label: "Global recipes",
    description: "Recipes offered in every project. Copying one never runs it",
    sections: ["globalRecipes"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "hibernation",
    label: "Project hibernation",
    description: "Closing projects left unused for a while",
    sections: ["hibernation"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "sessionRestore",
    label: "Session restore",
    description: "Whether a relaunch reopens every live project, from the next start",
    sections: ["sessionRestore"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "idleTerminals",
    label: "Idle terminals",
    description: "Alerts about idle terminals, and closing idle background ones",
    sections: ["idleTerminalNotify", "idleBackgroundAutoClose"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "updateChecks",
    label: "Update checks",
    description: "Checking for agent CLI and plugin updates",
    sections: ["agentUpdateChecks", "pluginUpdateChecks"],
    selectedByDefault: true,
    device: false,
    inFile: true,
  },
  {
    id: "globalEnvironment",
    label: "Global environment variables",
    description: "Given to every terminal. Names and values that look like secrets stay here",
    sections: ["globalEnvironment"],
    selectedByDefault: false,
    device: false,
    inFile: false,
  },
  {
    id: "permissionBypass",
    label: "Permission bypass",
    description: "Skipping agents' permission prompts, globally, per agent and per preset",
    sections: ["permissionBypass"],
    selectedByDefault: false,
    device: false,
    inFile: false,
  },
  {
    id: "device",
    label: "Theme and keyboard shortcuts",
    description: "For using that machine directly. Windows here keep this machine's",
    sections: ["appTheme", "keybindingOverrides"],
    selectedByDefault: false,
    device: true,
    inFile: true,
  },
];

/** Sections Export Configuration writes and Import Configuration accepts. */
export const FILE_BUNDLE_SECTION_IDS: readonly ConfigBundleSectionId[] =
  PORTABLE_SETTINGS_CATEGORIES.filter((category) => category.inFile).flatMap(
    (category) => category.sections
  );

export function isFileBundleSectionId(value: string): value is ConfigBundleSectionId {
  return (FILE_BUNDLE_SECTION_IDS as readonly string[]).includes(value);
}

export function categoryOfSection(
  section: ConfigBundleSectionId
): PortableSettingsCategory | undefined {
  return PORTABLE_SETTINGS_CATEGORIES.find((category) => category.sections.includes(section));
}

/**
 * Per-agent preferences that travel. `dangerous*` is permission posture and
 * travels only in its own opt-in section; `worktreePresets` is bookkeeping
 * keyed by worktree ids that mean nothing on another machine; the retired
 * `selected`/`enabled` keys and anything unnamed stay behind.
 */
export const AGENT_SETTINGS_PORTABLE_FIELDS = [
  "pinned",
  "customFlags",
  "inlineMode",
  "shareClipboardDirectory",
  "decorativeEffects",
  "presetId",
  "customPresets",
  "globalEnv",
] as const;

/** Fields of one custom preset that travel. Its bypass override goes with Permission bypass. */
export const AGENT_PRESET_PORTABLE_FIELDS = [
  "id",
  "name",
  "description",
  "env",
  "args",
  "customFlags",
  "inlineMode",
  "color",
  "fallbacks",
] as const;

/** An agent's own permission-bypass fields. */
export const AGENT_BYPASS_FIELDS = ["dangerousMode", "dangerousEnabled", "dangerousArgs"] as const;

/** A preset's permission-bypass override. */
export const PRESET_BYPASS_FIELDS = ["dangerousMode", "dangerousEnabled"] as const;
