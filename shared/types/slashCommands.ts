import type { BuiltInAgentId } from "../config/agentIds.js";
import type { CompletionKind, CompletionTrigger } from "./completionSources.js";

export type SlashCommandScope = "built-in" | "global" | "user" | "project";

export interface SlashCommand {
  id: string;
  label: string; // display token, e.g. "/compact" or "Plugin Creator"
  description: string;
  scope: SlashCommandScope;
  agentId: BuiltInAgentId;
  sourcePath?: string;
  kind?: CompletionKind;
  /**
   * The canonical token inserted when the command is chosen (e.g. `/compact`,
   * `$plugin-creator`). Distinct from `label` (display) so a capability whose
   * name differs from its token can be expressed. Optional: absent when the
   * label *is* the token (built-ins), where consumers fall back to `label`.
   */
  insertText?: string;
  /**
   * Extra search-only tokens matched during ranking but never displayed or
   * inserted. Mirrors `searchAliases` on the panel-kind registry.
   */
  aliases?: readonly string[];
  /**
   * Which trigger opens this completion (`/`, `$`, `@`). Stamped by the
   * discovery engine; absent on the renderer's built-in fallback, where it is
   * treated as `"/"`. The renderer filters the slash menu to `trigger === "/"`
   * so an agent's `$` capabilities never leak into the `/` list.
   */
  trigger?: CompletionTrigger;
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

// Entries are grouped by the agents that support them and kept alphabetical
// within each group: `rankSlashCommands` returns the list untouched for an
// empty query, so array order is the order the menu shows on a bare `/`.
const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommandEntry[] = [
  // Shared by all three agents (claude, gemini, codex)
  {
    id: "clear",
    label: "/clear",
    description: "Clear the terminal display",
    descriptions: {
      claude: "Reset display and attention buffer",
      codex: "Clear the terminal and start a new chat",
    },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "copy",
    label: "/copy",
    description: "Copy last response to clipboard",
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

  // Shared by claude + gemini.
  // None of these exist in Codex 0.147.0 (verified against the installed
  // binary's command table), so codex is deliberately absent here.
  {
    id: "bug",
    label: "/bug",
    description: "File an issue report",
    supportedAgents: ["claude", "gemini"],
  },
  {
    id: "cost",
    label: "/cost",
    description: "Show estimated costs (alias for /stats)",
    supportedAgents: ["claude", "gemini"],
  },
  {
    id: "help",
    label: "/help",
    description: "Show available commands",
    descriptions: { gemini: "Show help for available commands" },
    supportedAgents: ["claude", "gemini"],
  },
  {
    id: "security-review",
    label: "/security-review",
    description: "Security-focused code review",
    supportedAgents: ["claude", "gemini"],
  },
  {
    id: "settings",
    label: "/settings",
    description: "Open settings configuration",
    descriptions: { gemini: "Edit settings configuration" },
    supportedAgents: ["claude", "gemini"],
  },
  {
    id: "stats",
    label: "/stats",
    description: "Show token usage and session statistics",
    descriptions: { gemini: "Show session statistics (tokens, latency)" },
    supportedAgents: ["claude", "gemini"],
  },
  {
    id: "tools",
    label: "/tools",
    description: "List available tools and capabilities",
    descriptions: { gemini: "List enabled tools/capabilities" },
    supportedAgents: ["claude", "gemini"],
  },
  {
    id: "undo",
    label: "/undo",
    description: "Revert the last conversation turn",
    supportedAgents: ["claude", "gemini"],
  },

  // Shared by claude + codex
  {
    id: "compact",
    label: "/compact",
    description: "Summarize history to save tokens",
    supportedAgents: ["claude", "codex"],
  },
  {
    id: "goal",
    label: "/goal",
    description: "Set a goal that must be met before stopping",
    descriptions: { codex: "Manage the session goal (edit, pause, resume, clear)" },
    supportedAgents: ["claude", "codex"],
  },
  {
    id: "hooks",
    label: "/hooks",
    description: "Manage execution event hooks",
    descriptions: { codex: "View and manage lifecycle hooks" },
    supportedAgents: ["claude", "codex"],
  },
  {
    id: "resume",
    label: "/resume",
    description: "Rehydrate previous session context",
    descriptions: { codex: "Resume a saved chat" },
    supportedAgents: ["claude", "codex"],
  },
  {
    id: "statusline",
    label: "/statusline",
    description: "Customize UI status bar",
    descriptions: { codex: "Configure which items appear in the status line" },
    supportedAgents: ["claude", "codex"],
  },
  {
    id: "usage",
    label: "/usage",
    description: "Show plan usage limits",
    descriptions: { codex: "View account usage or use a usage limit reset" },
    supportedAgents: ["claude", "codex"],
  },

  // Shared by gemini + codex
  {
    id: "theme",
    label: "/theme",
    description: "Customize CLI visual theme",
    descriptions: { codex: "Choose a syntax highlighting theme" },
    supportedAgents: ["gemini", "codex"],
  },
  {
    id: "vim",
    label: "/vim",
    description: "Toggle Vim input mode",
    descriptions: { codex: "Toggle Vim mode for the composer" },
    supportedAgents: ["gemini", "codex"],
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

  // Codex-only.
  // Refreshed against installed Codex v0.147.0 (#11843). The catalog mirrors
  // the command set Codex's own `/` popup lists: to re-verify after a Codex
  // upgrade, open the CLI, type `/`, and diff the popup against these entries.
  // Deliberately excluded: `/apps`, `/sandbox-add-read-dir` and
  // `/setup-default-sandbox` exist in the binary but are context-gated and
  // unreachable in a normal session; `/btw` and `/quit` are aliases Codex
  // hides from its own list; `/debug-config`, `/rollout`, `/test-approval`,
  // `/debug-m-drop` and `/debug-m-update` are internal debug commands.
  {
    id: "agent",
    label: "/agent",
    description: "Switch the active agent thread",
    supportedAgents: ["codex"],
  },
  {
    id: "app",
    label: "/app",
    description: "Continue this session in the desktop app",
    supportedAgents: ["codex"],
  },
  {
    id: "approve",
    label: "/approve",
    description: "Approve one retry of a recent auto-review denial",
    supportedAgents: ["codex"],
  },
  {
    id: "archive",
    label: "/archive",
    description: "Archive this session and exit",
    supportedAgents: ["codex"],
  },
  {
    id: "delete",
    label: "/delete",
    description: "Permanently delete this session and exit",
    supportedAgents: ["codex"],
  },
  {
    id: "experimental",
    label: "/experimental",
    description: "Toggle experimental features",
    supportedAgents: ["codex"],
  },
  {
    id: "fast",
    label: "/fast",
    description: "1.5x speed, increased usage",
    supportedAgents: ["codex"],
  },
  {
    id: "feedback",
    label: "/feedback",
    description: "Send logs to maintainers",
    supportedAgents: ["codex"],
  },
  {
    id: "fork",
    label: "/fork",
    description: "Fork the current chat",
    supportedAgents: ["codex"],
  },
  {
    id: "ide",
    label: "/ide",
    description: "Include selection, open files, and context from your IDE",
    supportedAgents: ["codex"],
  },
  {
    id: "import",
    label: "/import",
    description: "Import setup, this project, and recent chats from Claude Code",
    supportedAgents: ["codex"],
  },
  {
    id: "keymap",
    label: "/keymap",
    description: "Remap TUI shortcuts",
    supportedAgents: ["codex"],
  },
  {
    id: "logout",
    label: "/logout",
    description: "Sign out of OpenAI account",
    supportedAgents: ["codex"],
  },
  {
    id: "memories",
    label: "/memories",
    description: "Configure memory use and generation",
    supportedAgents: ["codex"],
  },
  {
    id: "mention",
    label: "/mention",
    description: "Mention a file",
    supportedAgents: ["codex"],
  },
  {
    id: "personality",
    label: "/personality",
    description: "Adjust the assistant's personality",
    supportedAgents: ["codex"],
  },
  {
    id: "pets",
    label: "/pets",
    description: "Choose or hide the terminal pet",
    supportedAgents: ["codex"],
  },
  {
    id: "plan",
    label: "/plan",
    description: "Switch to Plan mode",
    supportedAgents: ["codex"],
  },
  {
    id: "plugins",
    label: "/plugins",
    description: "Manage installed plugins",
    supportedAgents: ["codex"],
  },
  {
    id: "ps",
    label: "/ps",
    description: "List background terminals",
    supportedAgents: ["codex"],
  },
  {
    id: "raw",
    label: "/raw",
    description: "Toggle raw scrollback mode for copy-friendly selection",
    supportedAgents: ["codex"],
  },
  {
    id: "rename",
    label: "/rename",
    description: "Rename the current thread",
    supportedAgents: ["codex"],
  },
  {
    id: "side",
    label: "/side",
    description: "Start a side conversation in an ephemeral fork",
    supportedAgents: ["codex"],
  },
  {
    id: "skills",
    label: "/skills",
    description: "Browse and manage skills",
    supportedAgents: ["codex"],
  },
  {
    id: "status",
    label: "/status",
    description: "Show active config and usage",
    supportedAgents: ["codex"],
  },
  {
    id: "stop",
    label: "/stop",
    description: "Stop all background terminals",
    supportedAgents: ["codex"],
  },
  {
    id: "subagents",
    label: "/subagents",
    description: "Switch the active agent thread",
    supportedAgents: ["codex"],
  },
  {
    id: "title",
    label: "/title",
    description: "Configure which items appear in the terminal title",
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
