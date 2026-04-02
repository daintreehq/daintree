import type { BuiltInAgentId } from "../config/agentIds.js";

export type SlashCommandScope = "built-in" | "global" | "user" | "project";

export interface SlashCommand {
  id: string;
  label: string; // e.g. "/compact"
  description: string;
  scope: SlashCommandScope;
  agentId: BuiltInAgentId;
  sourcePath?: string;
  kind?: "command" | "skill";
}

export interface SlashCommandListRequest {
  agentId: BuiltInAgentId;
  projectPath?: string;
}

export interface BuiltinSlashCommandEntry {
  id: string;
  label: string;
  description: string;
  descriptions?: Partial<Record<BuiltInAgentId, string>>;
  supportedAgents: readonly BuiltInAgentId[];
}

const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommandEntry[] = [
  // Shared by all three agents (claude, gemini, codex)
  {
    id: "bug",
    label: "/bug",
    description: "File an issue report",
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "copy",
    label: "/copy",
    description: "Copy last response to clipboard",
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "cost",
    label: "/cost",
    description: "Show estimated costs (alias for /stats)",
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "diff",
    label: "/diff",
    description: "Show pending file changes",
    descriptions: { codex: "Show pending changes for review" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "exit",
    label: "/exit",
    description: "Exit the session",
    descriptions: { claude: "Terminate session & cleanup" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "help",
    label: "/help",
    description: "Show available commands",
    descriptions: { gemini: "Show help for available commands" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "init",
    label: "/init",
    description: "Initialize project configuration",
    descriptions: { codex: "Scaffold AGENTS.md instructions" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "mcp",
    label: "/mcp",
    description: "Manage Model Context Protocol servers",
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "model",
    label: "/model",
    description: "Switch active AI model",
    descriptions: { codex: "Switch model or reasoning settings" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "new",
    label: "/new",
    description: "Reset conversation context",
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "permissions",
    label: "/permissions",
    description: "Manage tool execution permissions",
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "review",
    label: "/review",
    description: "Request code review of pending changes",
    descriptions: { codex: "Run a code review pass" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "security-review",
    label: "/security-review",
    description: "Security-focused code review",
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "settings",
    label: "/settings",
    description: "Open settings configuration",
    descriptions: { gemini: "Edit settings configuration" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "stats",
    label: "/stats",
    description: "Show token usage and session statistics",
    descriptions: { gemini: "Show session statistics (tokens, latency)" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "tools",
    label: "/tools",
    description: "List available tools and capabilities",
    descriptions: { gemini: "List enabled tools/capabilities" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "undo",
    label: "/undo",
    description: "Revert the last conversation turn",
    supportedAgents: ["claude", "gemini", "codex"],
  },

  // Shared by claude + gemini
  {
    id: "clear",
    label: "/clear",
    description: "Clear the terminal display",
    descriptions: { claude: "Reset display and attention buffer" },
    supportedAgents: ["claude", "gemini"],
  },

  // Shared by claude + codex
  {
    id: "compact",
    label: "/compact",
    description: "Summarize history to save tokens",
    supportedAgents: ["claude", "codex"],
  },

  // Claude-only
  {
    id: "add-dir",
    label: "/add-dir",
    description: "Add a directory to context",
    supportedAgents: ["claude"],
  },
  {
    id: "agents",
    label: "/agents",
    description: "Manage sub-agent orchestration",
    supportedAgents: ["claude"],
  },
  {
    id: "context",
    label: "/context",
    description: "Visualize current context usage as a colored grid",
    supportedAgents: ["claude"],
  },
  {
    id: "doctor",
    label: "/doctor",
    description: "Diagnostic health check",
    supportedAgents: ["claude"],
  },
  {
    id: "export",
    label: "/export",
    description: "Dump conversation log to file",
    supportedAgents: ["claude"],
  },
  {
    id: "extra-usage",
    label: "/extra-usage",
    description: "Access and configure extra usage when limits are hit",
    supportedAgents: ["claude"],
  },
  {
    id: "hooks",
    label: "/hooks",
    description: "Manage execution event hooks",
    supportedAgents: ["claude"],
  },
  {
    id: "resume",
    label: "/resume",
    description: "Rehydrate previous session context",
    supportedAgents: ["claude"],
  },
  {
    id: "rewind",
    label: "/rewind",
    description: "Undo last turn(s) to fix hallucinations",
    supportedAgents: ["claude"],
  },
  {
    id: "sandbox",
    label: "/sandbox",
    description: "Enable restricted execution env",
    supportedAgents: ["claude"],
  },
  {
    id: "statusline",
    label: "/statusline",
    description: "Customize UI status bar",
    supportedAgents: ["claude"],
  },
  {
    id: "terminal-setup",
    label: "/terminal-setup",
    description: "Configure keybindings",
    supportedAgents: ["claude"],
  },
  {
    id: "todos",
    label: "/todos",
    description: "Inspect agent task queue",
    supportedAgents: ["claude"],
  },
  {
    id: "usage",
    label: "/usage",
    description: "Show plan usage limits",
    supportedAgents: ["claude"],
  },

  // Gemini-only
  {
    id: "chat",
    label: "/chat",
    description: "Manage conversation sessions (save, resume, share)",
    supportedAgents: ["gemini"],
  },
  {
    id: "compress",
    label: "/compress",
    description: "Summarize history to save tokens",
    supportedAgents: ["gemini"],
  },
  {
    id: "dir",
    label: "/dir",
    description: "Alias for /directory",
    supportedAgents: ["gemini"],
  },
  {
    id: "directory",
    label: "/directory",
    description: "Manage workspace boundaries",
    supportedAgents: ["gemini"],
  },
  {
    id: "memory",
    label: "/memory",
    description: "Manage agent memory (add, refresh, show)",
    supportedAgents: ["gemini"],
  },
  {
    id: "quit",
    label: "/quit",
    description: "Exit the session",
    supportedAgents: ["gemini"],
  },
  {
    id: "restore",
    label: "/restore",
    description: "Undo recent file changes",
    supportedAgents: ["gemini"],
  },
  {
    id: "theme",
    label: "/theme",
    description: "Customize CLI visual theme",
    supportedAgents: ["gemini"],
  },
  {
    id: "vim",
    label: "/vim",
    description: "Toggle Vim input mode",
    supportedAgents: ["gemini"],
  },

  // Codex-only
  {
    id: "approvals",
    label: "/approvals",
    description: "Set approval policy (auto/ask/never)",
    supportedAgents: ["codex"],
  },
  {
    id: "logout",
    label: "/logout",
    description: "Sign out of OpenAI account",
    supportedAgents: ["codex"],
  },
  {
    id: "mention",
    label: "/mention",
    description: "Add file/symbol to context window",
    supportedAgents: ["codex"],
  },
  {
    id: "status",
    label: "/status",
    description: "Show active config and usage",
    supportedAgents: ["codex"],
  },
];

export { BUILTIN_SLASH_COMMANDS };

export function getBuiltinSlashCommands(agentId: BuiltInAgentId): SlashCommand[] {
  return BUILTIN_SLASH_COMMANDS.filter((entry) => entry.supportedAgents.includes(agentId)).map(
    (entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.descriptions?.[agentId] ?? entry.description,
      scope: "built-in" as const,
      agentId,
    })
  );
}
