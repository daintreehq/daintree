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
  "grok",
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
] as const;

export type BuiltInAgentId = (typeof BUILT_IN_AGENT_IDS)[number];

// Agents Daintree no longer ships. Stored settings, hibernated assistant
// sessions and hand-edited recipes can still name them, so readers drop them.
export const RETIRED_AGENT_IDS: readonly string[] = ["daintree-assistant"];

export function isRetiredAgentId(value: unknown): boolean {
  return typeof value === "string" && RETIRED_AGENT_IDS.includes(value);
}

export const BUILT_IN_TERMINAL_TYPES = ["terminal", ...BUILT_IN_AGENT_IDS] as const;

export type BuiltInTerminalType = (typeof BUILT_IN_TERMINAL_TYPES)[number];

export type AgentKeyAction = `agent.${BuiltInAgentId}`;

export const BUILT_IN_AGENT_KEY_ACTIONS: readonly AgentKeyAction[] = BUILT_IN_AGENT_IDS.map(
  (id) => `agent.${id}` as AgentKeyAction
);

export function isBuiltInAgentId(value: unknown): value is BuiltInAgentId {
  return typeof value === "string" && (BUILT_IN_AGENT_IDS as readonly string[]).includes(value);
}
