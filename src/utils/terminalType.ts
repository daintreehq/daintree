import type { PanelKind } from "@/types";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import type { AgentState } from "@shared/types/agent";
import type { TerminalRuntimeIdentity } from "@shared/types/panel";
import { deriveTerminalChrome } from "./terminalChrome";

export interface RuntimeAgentIdentityInput {
  detectedAgentId?: string;
  runtimeIdentity?: TerminalRuntimeIdentity;
  everDetectedAgent?: boolean;
  launchAgentId?: string;
  agentState?: AgentState | string;
  runtimeStatus?: string;
  exitCode?: number | null;
}

/**
 * A "demoted ex-agent" is a legacy record where the agent was once detected
 * (`everDetectedAgent`) but the live detector has cleared and no agentState
 * has been written. Chrome keeps showing the launch identity for visual
 * continuity, but for runtime purposes (focus fallback, agent grouping,
 * agent-targeted actions) the panel is no longer an agent.
 */
function isDemotedExAgent(terminal: RuntimeAgentIdentityInput): boolean {
  if (terminal.detectedAgentId) return false;
  if (terminal.runtimeIdentity?.kind === "agent" && terminal.runtimeIdentity.agentId) return false;
  if (terminal.agentState) return false;
  return Boolean(terminal.launchAgentId) && terminal.everDetectedAgent === true;
}

/**
 * Is this terminal currently agent-addressable?
 *
 * Live detection wins, but a launchAgentId is durable agent affinity while the
 * terminal has not received a strong exit signal. This keeps restored and
 * toolbar-launched agent terminals wired for agent chrome/activity before the
 * transient detector fields rehydrate. Sticky-but-cleared legacy records
 * (`everDetectedAgent` true with no live detection or agentState) are treated
 * as non-agent for runtime purposes.
 */
export function isAgentTerminal(terminal: {
  detectedAgentId?: string;
  runtimeIdentity?: TerminalRuntimeIdentity;
  everDetectedAgent?: boolean;
  launchAgentId?: string;
  agentState?: AgentState | string;
  runtimeStatus?: string;
  exitCode?: number | null;
  kind?: PanelKind;
}): boolean {
  if (isDemotedExAgent(terminal)) return false;
  return deriveTerminalChrome(terminal).isAgent;
}

export const isRuntimeAgentTerminal = isAgentTerminal;

export function getRuntimeAgentId(
  terminal: RuntimeAgentIdentityInput | undefined
): string | undefined {
  if (!terminal) return undefined;
  if (isDemotedExAgent(terminal)) return undefined;
  return deriveTerminalChrome(terminal).agentId ?? undefined;
}

export function getBuiltInRuntimeAgentId(
  terminal: RuntimeAgentIdentityInput | undefined
): BuiltInAgentId | undefined {
  const agentId = getRuntimeAgentId(terminal);
  return isBuiltInAgentId(agentId) ? agentId : undefined;
}

/**
 * Non-chrome grouping helper. Kept as a named wrapper for older call sites;
 * it now follows the same durable agent-affinity rule as terminal chrome.
 */
export function getRuntimeOrBootAgentId(
  terminal: RuntimeAgentIdentityInput | undefined
): string | undefined {
  return getRuntimeAgentId(terminal);
}

// Pure utility — accept HMR in place so edits don't propagate into a full
// page reload. Consumers call these functions at render time; the new
// definitions are picked up on the next render automatically.
if (import.meta.hot) {
  import.meta.hot.accept();
}
