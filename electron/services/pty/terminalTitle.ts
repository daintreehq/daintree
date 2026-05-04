import { AGENT_REGISTRY } from "../../../shared/config/agentRegistry.js";
import type { TerminalInfo } from "./types.js";

/**
 * Backend-side identity for internal decisions (activity monitor pattern
 * lookup, event routing). Detection wins; during the boot window the launch
 * hint is used so cold-launched terminals start monitoring before the
 * process-tree poll has caught up.
 */
export function getLiveAgentId(terminal: TerminalInfo): string | undefined {
  return terminal.detectedAgentId ?? terminal.launchAgentId;
}

/**
 * Compute the default panel title for a terminal given its current chrome
 * identity. Used by the PTY host so the renderer can sync `panel.title` when
 * `titleMode === "default"`.
 *
 * Kept in lockstep with the renderer terminal chrome rule:
 *   - `src/store/slices/panelRegistry/helpers.ts` → `getDefaultTitle`
 *   - `src/store/listeners/panel/identityReducer.ts`
 *
 * Detection wins; launch affinity remains agent-branded until an explicit
 * exited state says the agent has ended. If you change the rule here, update
 * those files too.
 */
export function computeDefaultTitle(terminal: TerminalInfo): string {
  const chromeId =
    terminal.detectedAgentId ??
    (terminal.agentState === "exited" || terminal.isExited ? undefined : terminal.launchAgentId);
  if (!chromeId) return "Terminal";
  const config = AGENT_REGISTRY[chromeId];
  return config?.name ?? String(chromeId);
}
