export const BUILT_IN_AGENT_IDS = [
  "claude",
  "gemini",
  "codex",
  "opencode",
  "cursor",
  "kiro",
  "copilot",
  "goose",
  "crush",
  "qwen",
  "interpreter",
] as const;

export type BuiltInAgentId = (typeof BUILT_IN_AGENT_IDS)[number];

export const BUILT_IN_TERMINAL_TYPES = ["terminal", ...BUILT_IN_AGENT_IDS] as const;

export type BuiltInTerminalType = (typeof BUILT_IN_TERMINAL_TYPES)[number];

export type AgentKeyAction = `agent.${BuiltInAgentId}`;

export const BUILT_IN_AGENT_KEY_ACTIONS: readonly AgentKeyAction[] = BUILT_IN_AGENT_IDS.map(
  (id) => `agent.${id}` as AgentKeyAction
);

export function isBuiltInAgentId(value: unknown): value is BuiltInAgentId {
  return typeof value === "string" && (BUILT_IN_AGENT_IDS as readonly string[]).includes(value);
}
