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
    id: "add-dir",
    label: "/add-dir",
    description: "Add a directory to context",
    scope: "built-in",
    agentId: "claude",
  },
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

export const GEMINI_BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "bug",
    label: "/bug",
    description: "File an issue report",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "chat",
    label: "/chat",
    description: "Manage conversation sessions (save, resume, share)",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "clear",
    label: "/clear",
    description: "Clear the terminal display",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "compress",
    label: "/compress",
    description: "Summarize history to save tokens",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "directory",
    label: "/directory",
    description: "Manage workspace boundaries",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "dir",
    label: "/dir",
    description: "Alias for /directory",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "exit",
    label: "/exit",
    description: "Exit the session",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "help",
    label: "/help",
    description: "Show help for available commands",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "mcp",
    label: "/mcp",
    description: "Manage Model Context Protocol servers",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "memory",
    label: "/memory",
    description: "Manage agent memory (add, refresh, show)",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "quit",
    label: "/quit",
    description: "Exit the session",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "restore",
    label: "/restore",
    description: "Undo recent file changes",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "settings",
    label: "/settings",
    description: "Edit settings configuration",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "stats",
    label: "/stats",
    description: "Show session statistics (tokens, latency)",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "theme",
    label: "/theme",
    description: "Customize CLI visual theme",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "tools",
    label: "/tools",
    description: "List enabled tools/capabilities",
    scope: "built-in",
    agentId: "gemini",
  },
  {
    id: "vim",
    label: "/vim",
    description: "Toggle Vim input mode",
    scope: "built-in",
    agentId: "gemini",
  },
] as const;

export const CODEX_BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    id: "approvals",
    label: "/approvals",
    description: "Set approval policy (auto/ask/never)",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "compact",
    label: "/compact",
    description: "Summarize history to save tokens",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "diff",
    label: "/diff",
    description: "Show pending changes for review",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "exit",
    label: "/exit",
    description: "Exit the session",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "init",
    label: "/init",
    description: "Scaffold AGENTS.md instructions",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "logout",
    label: "/logout",
    description: "Sign out of OpenAI account",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "mcp",
    label: "/mcp",
    description: "Manage Model Context Protocol servers",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "mention",
    label: "/mention",
    description: "Add file/symbol to context window",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "model",
    label: "/model",
    description: "Switch model or reasoning settings",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "new",
    label: "/new",
    description: "Reset conversation context",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "review",
    label: "/review",
    description: "Run a code review pass",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "status",
    label: "/status",
    description: "Show active config and usage",
    scope: "built-in",
    agentId: "codex",
  },
  {
    id: "undo",
    label: "/undo",
    description: "Revert the last conversation turn",
    scope: "built-in",
    agentId: "codex",
  },
] as const;
