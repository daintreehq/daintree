import type { PanelKind } from "@/types";
import type { BuiltInAgentId } from "@shared/config/agentIds";

/**
 * Is this terminal currently hosting an agent? Detection-only. Launch hints
 * do not count. See `docs/architecture/terminal-identity.md`.
 */
export function isAgentTerminal(terminal: {
  detectedAgentId?: BuiltInAgentId;
  everDetectedAgent?: boolean;
  launchAgentId?: string;
  kind?: PanelKind;
}): boolean {
  return Boolean(terminal.detectedAgentId);
}

export const isRuntimeAgentTerminal = isAgentTerminal;

// Pure utility — accept HMR in place so edits don't propagate into a full
// page reload. Consumers call these functions at render time; the new
// definitions are picked up on the next render automatically.
if (import.meta.hot) {
  import.meta.hot.accept();
}
