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
  /**
   * Search-only alternate names, per agent: one agent's alias can be another
   * agent's real command (agy's `/clear` answers to `new`, Claude has its own
   * `/new`), so an alias never applies beyond the agent it is declared for.
   */
  aliases?: Partial<Record<BuiltInAgentId, readonly string[]>>;
  /** Defaults to `command`; `skill` for a skill the agent ships built in. */
  kind?: CompletionKind;
  supportedAgents: readonly BuiltInAgentId[];
}

// Entries are grouped by the agents that support them and kept alphabetical
// within each group: `rankSlashCommands` returns the list untouched for an
// empty query, so array order is the order the menu shows on a bare `/`.
const BUILTIN_SLASH_COMMANDS: readonly BuiltinSlashCommandEntry[] = [
  // Shared by claude, gemini, codex and antigravity
  {
    id: "clear",
    label: "/clear",
    description: "Clear the terminal display",
    descriptions: {
      claude: "Reset display and attention buffer",
      codex: "Clear the terminal and start a new chat",
      antigravity: "Clear conversation and start a new one",
    },
    aliases: { antigravity: ["new"] },
    supportedAgents: ["claude", "gemini", "codex", "antigravity"],
  },
  {
    id: "copy",
    label: "/copy",
    description: "Copy last response to clipboard",
    descriptions: {
      antigravity:
        "Copy the last planner response to the clipboard, the n-th with '/copy n', or the /btw answer with '/copy btw'",
    },
    supportedAgents: ["claude", "gemini", "codex", "antigravity"],
  },
  {
    id: "diff",
    label: "/diff",
    description: "Show pending file changes",
    descriptions: {
      codex: "Show pending changes for review",
      antigravity: "View uncommitted changes and per-turn diffs",
    },
    supportedAgents: ["claude", "gemini", "codex", "antigravity"],
  },
  {
    id: "exit",
    label: "/exit",
    description: "Exit the session",
    descriptions: { claude: "Terminate session & cleanup", antigravity: "Exit the CLI" },
    aliases: { antigravity: ["quit"] },
    supportedAgents: ["claude", "gemini", "codex", "antigravity"],
  },
  {
    id: "mcp",
    label: "/mcp",
    description: "Manage Model Context Protocol servers",
    descriptions: {
      codex: "List configured MCP tools; use /mcp verbose for details",
      antigravity: "Manage MCP servers",
    },
    supportedAgents: ["claude", "gemini", "codex", "antigravity"],
  },
  {
    id: "model",
    label: "/model",
    description: "Switch active AI model",
    descriptions: {
      codex: "Switch model or reasoning settings",
      antigravity: "Set a model, or run a single prompt on another model",
    },
    supportedAgents: ["claude", "gemini", "codex", "antigravity"],
  },
  {
    id: "permissions",
    label: "/permissions",
    description: "Manage tool execution permissions",
    descriptions: { antigravity: "Manage tool permissions" },
    supportedAgents: ["claude", "gemini", "codex", "antigravity"],
  },

  // Shared by claude, gemini and codex. agy 1.4.10 has none of these: its
  // `/new` is only an alias of its own `/clear`.
  {
    id: "init",
    label: "/init",
    description: "Initialize project configuration",
    descriptions: { codex: "Scaffold AGENTS.md instructions" },
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "new",
    label: "/new",
    description: "Reset conversation context",
    supportedAgents: ["claude", "gemini", "codex"],
  },
  {
    id: "review",
    label: "/review",
    description: "Request code review of pending changes",
    descriptions: { codex: "Run a code review pass" },
    supportedAgents: ["claude", "gemini", "codex"],
  },

  // Shared by claude, gemini and antigravity
  {
    id: "help",
    label: "/help",
    description: "Show available commands",
    descriptions: {
      gemini: "Show help for available commands",
      antigravity: "Show available commands and keybindings",
    },
    supportedAgents: ["claude", "gemini", "antigravity"],
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

  // Shared by claude, codex and antigravity
  {
    id: "compact",
    label: "/compact",
    description: "Summarize history to save tokens",
    descriptions: {
      antigravity: "Compact the conversation now (summarize history to free up the context window)",
    },
    supportedAgents: ["claude", "codex", "antigravity"],
  },
  {
    id: "goal",
    label: "/goal",
    description: "Set a goal that must be met before stopping",
    descriptions: {
      codex: "Manage the session goal (edit, pause, resume, clear)",
      antigravity: "Run until the specified goal is completely finished",
    },
    supportedAgents: ["claude", "codex", "antigravity"],
  },
  {
    id: "hooks",
    label: "/hooks",
    description: "Manage execution event hooks",
    descriptions: {
      codex: "View and manage lifecycle hooks",
      antigravity: "Manage hook configurations for tool events",
    },
    supportedAgents: ["claude", "codex", "antigravity"],
  },
  {
    id: "resume",
    label: "/resume",
    description: "Rehydrate previous session context",
    descriptions: {
      codex: "Resume a saved chat",
      antigravity: "Browse and resume past conversations",
    },
    aliases: { antigravity: ["switch"] },
    supportedAgents: ["claude", "codex", "antigravity"],
  },
  {
    id: "statusline",
    label: "/statusline",
    description: "Customize UI status bar",
    descriptions: {
      codex: "Configure which items appear in the status line",
      antigravity: "Toggle the statusline",
    },
    supportedAgents: ["claude", "codex", "antigravity"],
  },
  {
    id: "usage",
    label: "/usage",
    description: "Show plan usage limits",
    descriptions: {
      codex: "View account usage or use a usage limit reset",
      antigravity: "View model quota usage",
    },
    aliases: { antigravity: ["quota"] },
    supportedAgents: ["claude", "codex", "antigravity"],
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

  // Shared by claude + antigravity
  {
    id: "add-dir",
    label: "/add-dir",
    description: "Add a directory to context",
    descriptions: { antigravity: "Add a directory to the workspace" },
    supportedAgents: ["claude", "antigravity"],
  },
  {
    id: "agents",
    label: "/agents",
    description: "Manage sub-agent orchestration",
    descriptions: { antigravity: "List available custom agents" },
    supportedAgents: ["claude", "antigravity"],
  },
  {
    id: "context",
    label: "/context",
    description: "Visualize current context usage as a colored grid",
    descriptions: { antigravity: "Visualize current context usage" },
    supportedAgents: ["claude", "antigravity"],
  },
  {
    id: "rewind",
    label: "/rewind",
    description: "Undo last turn(s) to fix hallucinations",
    descriptions: { antigravity: "Rewind conversation to a previous message" },
    aliases: { antigravity: ["undo"] },
    supportedAgents: ["claude", "antigravity"],
  },

  // Claude-only
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

  // Shared by codex + antigravity
  {
    id: "feedback",
    label: "/feedback",
    description: "Send logs to maintainers",
    descriptions: { antigravity: "Submit qualitative feedback to improve the agent" },
    supportedAgents: ["codex", "antigravity"],
  },
  {
    id: "fork",
    label: "/fork",
    description: "Fork the current chat",
    descriptions: {
      antigravity:
        "Create a branch of the current conversation at this point, optionally specifying a project ID to fork into",
    },
    aliases: { antigravity: ["branch"] },
    supportedAgents: ["codex", "antigravity"],
  },
  {
    id: "logout",
    label: "/logout",
    description: "Sign out of OpenAI account",
    descriptions: { antigravity: "Log out" },
    supportedAgents: ["codex", "antigravity"],
  },
  {
    id: "plan",
    label: "/plan",
    description: "Switch to Plan mode",
    descriptions: { antigravity: "Plan carefully before executing a task" },
    supportedAgents: ["codex", "antigravity"],
  },
  {
    id: "rename",
    label: "/rename",
    description: "Rename the current thread",
    descriptions: { antigravity: "Rename the current conversation" },
    supportedAgents: ["codex", "antigravity"],
  },
  {
    id: "skills",
    label: "/skills",
    description: "Browse and manage skills",
    descriptions: { antigravity: "List available skills" },
    supportedAgents: ["codex", "antigravity"],
  },
  {
    id: "title",
    label: "/title",
    description: "Configure which items appear in the terminal title",
    descriptions: { antigravity: "Toggle custom terminal window title" },
    supportedAgents: ["codex", "antigravity"],
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
    id: "side",
    label: "/side",
    description: "Start a side conversation in an ephemeral fork",
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

  // Antigravity-only.
  // Checked against a live agy 1.4.10 `/` menu (#15243); descriptions are agy's
  // own wording. To re-verify after an agy upgrade, type `/` in agy and diff
  // its built-in entries against every entry listing antigravity. The two
  // `kind: "skill"` entries are skills compiled into the binary that agy lists
  // beside its commands; the other skills it bundles under
  // `~/.gemini/antigravity-cli/builtin/skills/` stay out of its menu, so that
  // folder is deliberately not scanned.
  {
    id: "agy-customizations",
    label: "/agy-customizations",
    description: "Comprehensive guide and reference for the Antigravity Customization System",
    kind: "skill",
    supportedAgents: ["antigravity"],
  },
  {
    id: "antigravity-guide",
    label: "/antigravity-guide",
    description: "Comprehensive guide, quick reference, and sitemap for Google Antigravity",
    kind: "skill",
    supportedAgents: ["antigravity"],
  },
  {
    id: "artifact",
    label: "/artifact",
    description: "View and review artifacts",
    supportedAgents: ["antigravity"],
  },
  {
    id: "boost",
    label: "/boost",
    description: "Invoke the Boost multi-agent orchestrator for complex tasks",
    supportedAgents: ["antigravity"],
  },
  {
    id: "browser",
    label: "/browser",
    description: "Invoke a browser agent for web tasks",
    supportedAgents: ["antigravity"],
  },
  {
    id: "btw",
    label: "/btw",
    description: "Ask a side question without interrupting the current task",
    supportedAgents: ["antigravity"],
  },
  {
    id: "changelog",
    label: "/changelog",
    description: "Show release notes and changes",
    supportedAgents: ["antigravity"],
  },
  {
    id: "codesearch",
    label: "/codesearch",
    description: "Search code in the workspace (usage: /codesearch <query>)",
    aliases: { antigravity: ["cs"] },
    supportedAgents: ["antigravity"],
  },
  {
    id: "config",
    label: "/config",
    description: "Open settings panel",
    aliases: { antigravity: ["settings"] },
    supportedAgents: ["antigravity"],
  },
  {
    id: "credits",
    label: "/credits",
    description: "Show remaining G1 credits and purchase link",
    supportedAgents: ["antigravity"],
  },
  {
    id: "effort",
    label: "/effort",
    description: "Set the reasoning effort",
    supportedAgents: ["antigravity"],
  },
  {
    id: "grill-me",
    label: "/grill-me",
    description: "Interview me to align on a plan",
    supportedAgents: ["antigravity"],
  },
  {
    id: "keybindings",
    label: "/keybindings",
    description: "Set custom keybindings",
    supportedAgents: ["antigravity"],
  },
  {
    id: "learn",
    label: "/learn",
    description: "Reflect on recent successes or corrections to capture reusable skills or rules",
    supportedAgents: ["antigravity"],
  },
  {
    id: "open",
    label: "/open",
    description: "Open a file or view opened/edited files",
    supportedAgents: ["antigravity"],
  },
  {
    id: "plugin",
    label: "/plugin",
    description: "Manage, discover, install, uninstall, enable, and disable plugins",
    supportedAgents: ["antigravity"],
  },
  {
    id: "remote-control",
    label: "/remote-control",
    description: "Turn on remote control for this session (off to disable)",
    supportedAgents: ["antigravity"],
  },
  {
    id: "schedule",
    label: "/schedule",
    description: "Run an instruction on a recurring schedule or as a one-time timer",
    supportedAgents: ["antigravity"],
  },
  {
    id: "tasks",
    label: "/tasks",
    description: "View background tasks",
    supportedAgents: ["antigravity"],
  },
  {
    id: "teamwork",
    label: "/teamwork",
    description: "Invoke a team of agents to autonomously tackle large projects",
    supportedAgents: ["antigravity"],
  },
  {
    id: "voice",
    label: "/voice",
    description: "Dictate a prompt using your microphone",
    aliases: { antigravity: ["record"] },
    supportedAgents: ["antigravity"],
  },
];

export { BUILTIN_SLASH_COMMANDS };

export function getBuiltinSlashCommands(agentId: BuiltInAgentId): SlashCommand[] {
  return BUILTIN_SLASH_COMMANDS.filter((entry) => entry.supportedAgents.includes(agentId)).map(
    (entry) => {
      const command: SlashCommand = {
        id: entry.id,
        label: entry.label,
        description: entry.descriptions?.[agentId] ?? entry.description,
        scope: "built-in",
        agentId,
      };
      const aliases = entry.aliases?.[agentId];
      if (aliases) command.aliases = aliases;
      if (entry.kind) command.kind = entry.kind;
      return command;
    }
  );
}
