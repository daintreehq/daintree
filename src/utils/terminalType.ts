import type { PanelKind } from "@/types";
import type { BuiltInAgentId } from "@shared/config/agentIds";

/**
 * Whether this terminal is currently hosting an agent. Under the unified
 * identity model (see `docs/architecture/terminal-identity.md`), agent-ness
 * is a live state: detection wins; if detection has ever fired and is now
 * cleared, the terminal is a plain shell; otherwise the launch hint stands
 * in during the boot window.
 */
export function isAgentTerminal(terminal: {
  detectedAgentId?: BuiltInAgentId;
  everDetectedAgent?: boolean;
  launchAgentId?: string;
  kind?: PanelKind;
}): boolean {
  if (terminal.detectedAgentId) return true;
  if (terminal.everDetectedAgent) return false;
  return Boolean(terminal.launchAgentId);
}

/**
 * Runtime-aware agent terminal predicate — alias of `isAgentTerminal` kept
 * for call-site readability where "runtime" emphasises that detection drives
 * the decision.
 */
export const isRuntimeAgentTerminal = isAgentTerminal;
