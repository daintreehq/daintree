export interface SlashCommand {
  id: string;
  label: string;
  description: string;
}

export const MOCK_SLASH_COMMANDS: SlashCommand[] = [
  { id: "help", label: "/help", description: "Show available commands" },
  { id: "clear", label: "/clear", description: "Clear terminal output" },
  { id: "reset", label: "/reset", description: "Reset terminal state" },
  { id: "copytree", label: "/copytree", description: "Generate codebase context" },
  { id: "history", label: "/history", description: "Show command history" },
  { id: "cwd", label: "/cwd", description: "Print current working directory" },
  { id: "open", label: "/open", description: "Open a file or directory" },
];
