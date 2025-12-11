import { isRegisteredAgent } from "@/config/agents";
import type { TerminalKind, TerminalType } from "@/types";

export function isAgentTerminal(
  kindOrType?: TerminalKind | TerminalType,
  agentId?: string
): boolean {
  // Check kind first if available
  if (kindOrType === "agent" || agentId) return true;
  // Fall back to checking if type is a registered agent (backward compat)
  if (kindOrType && kindOrType !== "terminal") {
    return isRegisteredAgent(kindOrType);
  }
  return false;
}

export function hasAgentDefaults(
  kindOrType?: TerminalKind | TerminalType,
  agentId?: string
): boolean {
  return isAgentTerminal(kindOrType, agentId);
}

export function detectTerminalTypeFromCommand(_command: string): TerminalType {
  return "terminal";
}

export function detectTerminalTypeFromRunCommand(_icon?: string, _command?: string): TerminalType {
  return "terminal";
}
