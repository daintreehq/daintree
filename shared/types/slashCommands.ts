import type { LegacyAgentType } from "./domain.js";

export type SlashCommandScope = "built-in" | "global" | "user" | "project";

export interface SlashCommand {
  id: string;
  label: string; // e.g. "/compact"
  description: string;
  scope: SlashCommandScope;
  agentId: LegacyAgentType;
  sourcePath?: string;
}

export interface SlashCommandListRequest {
  agentId: LegacyAgentType;
  projectPath?: string;
}

export const CLAUDE_BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "agents",
    label: "/agents",
    description: "Manage sub-agent orchestration",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "clear",
    label: "/clear",
    description: "Reset display and attention buffer",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "compact",
    label: "/compact",
    description: "Summarize history to save tokens",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "doctor",
    label: "/doctor",
    description: "Diagnostic health check",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "exit",
    label: "/exit",
    description: "Terminate session & cleanup",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "export",
    label: "/export",
    description: "Dump conversation log to file",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "hooks",
    label: "/hooks",
    description: "Manage execution event hooks",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "mcp",
    label: "/mcp",
    description: "Manage Model Context Protocol servers",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "resume",
    label: "/resume",
    description: "Rehydrate previous session context",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "rewind",
    label: "/rewind",
    description: "Undo last turn(s) to fix hallucinations",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "sandbox",
    label: "/sandbox",
    description: "Enable restricted execution env",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "statusline",
    label: "/statusline",
    description: "Customize UI status bar",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "terminal-setup",
    label: "/terminal-setup",
    description: "Configure keybindings",
    scope: "built-in",
    agentId: "claude",
  },
  {
    id: "todos",
    label: "/todos",
    description: "Inspect agent task queue",
    scope: "built-in",
    agentId: "claude",
  },
] as const;
