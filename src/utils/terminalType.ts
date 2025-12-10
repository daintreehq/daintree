import type { TerminalType } from "@/types";

export function isAgentTerminal(type: TerminalType): boolean {
  return type === "claude" || type === "gemini" || type === "codex";
}

export function hasAgentDefaults(type: TerminalType): boolean {
  return isAgentTerminal(type);
}

export function detectTerminalTypeFromCommand(_command: string): TerminalType {
  return "terminal";
}

export function detectTerminalTypeFromRunCommand(
  _icon?: string,
  _command?: string
): TerminalType {
  return "terminal";
}
