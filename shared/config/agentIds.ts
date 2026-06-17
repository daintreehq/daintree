// Order: most popular -> least popular among solo / indie developers
// (April 2026 popularity research). Drives the display order in Agents
// Setup, the Launch List, the Toolbar agent group, and any UI iterating
// the registry.
export const BUILT_IN_AGENT_IDS = [
  "claude",
  "opencode",
  "aider",
  "gemini",
  "antigravity",
  "codex",
  "cursor",
  "copilot",
  "goose",
  "amp",
  "crush",
  "qwen",
  "kimi",
  "interpreter",
  "mistral",
  "kiro",
  "daintree-assistant",
] as const;

export type BuiltInAgentId = (typeof BUILT_IN_AGENT_IDS)[number];

// Agents that are registered and detected (so the Daintree Assistant overlay
// can favour them) but must NEVER be offered as a standalone, launchable
// coding agent. They are too narrow to treat as a general CLI — they only
// make sense as the Daintree assistant. Launch surfaces (toolbar, launch
// list, setup wizard, agent keybindings) iterate `LAUNCHABLE_AGENT_IDS`
// instead of `BUILT_IN_AGENT_IDS` so these stay hidden everywhere a user
// could spawn an agent directly.
export const ASSISTANT_ONLY_AGENT_IDS = ["daintree-assistant"] as const;

export type AssistantOnlyAgentId = (typeof ASSISTANT_ONLY_AGENT_IDS)[number];

export function isAssistantOnlyAgentId(value: unknown): value is AssistantOnlyAgentId {
  return (
    typeof value === "string" && (ASSISTANT_ONLY_AGENT_IDS as readonly string[]).includes(value)
  );
}

/** Built-in agents a user can launch directly — excludes assistant-only agents. */
export const LAUNCHABLE_AGENT_IDS = BUILT_IN_AGENT_IDS.filter(
  (id) => !isAssistantOnlyAgentId(id)
) as readonly BuiltInAgentId[];

export const BUILT_IN_TERMINAL_TYPES = ["terminal", ...BUILT_IN_AGENT_IDS] as const;

export type BuiltInTerminalType = (typeof BUILT_IN_TERMINAL_TYPES)[number];

export type AgentKeyAction = `agent.${BuiltInAgentId}`;

// Keybinding actions are generated only for launchable agents — an
// assistant-only agent has no direct-launch action to bind.
export const BUILT_IN_AGENT_KEY_ACTIONS: readonly AgentKeyAction[] = LAUNCHABLE_AGENT_IDS.map(
  (id) => `agent.${id}` as AgentKeyAction
);

export function isBuiltInAgentId(value: unknown): value is BuiltInAgentId {
  return typeof value === "string" && (BUILT_IN_AGENT_IDS as readonly string[]).includes(value);
}
