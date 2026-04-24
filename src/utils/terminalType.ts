import type { PanelKind } from "@/types";
import { isBuiltInAgentId, type BuiltInAgentId } from "@shared/config/agentIds";
import type { TerminalRuntimeIdentity } from "@shared/types/panel";

export interface RuntimeAgentIdentityInput {
  detectedAgentId?: string;
  runtimeIdentity?: TerminalRuntimeIdentity;
  everDetectedAgent?: boolean;
  launchAgentId?: string;
}

/**
 * Is this terminal currently hosting an agent? Detection-only. Launch hints
 * do not count. See `docs/architecture/terminal-identity.md`.
 */
export function isAgentTerminal(terminal: {
  detectedAgentId?: string;
  runtimeIdentity?: TerminalRuntimeIdentity;
  everDetectedAgent?: boolean;
  launchAgentId?: string;
  kind?: PanelKind;
}): boolean {
  if (terminal.detectedAgentId) {
    return true;
  }
  if (terminal.runtimeIdentity) {
    return terminal.runtimeIdentity.kind === "agent";
  }
  return false;
}

export const isRuntimeAgentTerminal = isAgentTerminal;

export function getRuntimeAgentId(
  terminal: RuntimeAgentIdentityInput | undefined
): string | undefined {
  if (!terminal) return undefined;
  if (terminal.detectedAgentId) {
    return terminal.detectedAgentId;
  }
  if (terminal.runtimeIdentity) {
    return terminal.runtimeIdentity.kind === "agent" ? terminal.runtimeIdentity.agentId : undefined;
  }
  return undefined;
}

export function getBuiltInRuntimeAgentId(
  terminal: RuntimeAgentIdentityInput | undefined
): BuiltInAgentId | undefined {
  const agentId = getRuntimeAgentId(terminal);
  return isBuiltInAgentId(agentId) ? agentId : undefined;
}

/**
 * Non-chrome grouping helper. Runtime identity wins; launch intent is only a
 * boot-window fallback before any detector result has ever committed.
 */
export function getRuntimeOrBootAgentId(
  terminal: RuntimeAgentIdentityInput | undefined
): string | undefined {
  const runtimeAgentId = getRuntimeAgentId(terminal);
  if (runtimeAgentId) return runtimeAgentId;
  if (terminal?.launchAgentId && terminal.everDetectedAgent !== true) {
    return terminal.launchAgentId;
  }
  return undefined;
}

// Pure utility — accept HMR in place so edits don't propagate into a full
// page reload. Consumers call these functions at render time; the new
// definitions are picked up on the next render automatically.
if (import.meta.hot) {
  import.meta.hot.accept();
}
