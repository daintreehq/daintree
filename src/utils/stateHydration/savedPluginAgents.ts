import type { TerminalState } from "@shared/types/ipc/terminal";
import { getPluginAgentRegistry, setPluginAgentRegistry } from "@shared/config/pluginAgentRegistry";
import { isRegisteredAgent } from "@/config/agents";
import { logWarn } from "@/utils/logger";
import { inferKind, resolveRespawnAgentId } from "./statePatcher";

/**
 * Brings the plugin agents in before a restore reads them (#16470). A saved
 * plugin pane is rebuilt from its agent's resume declaration, so without one it
 * drops its session id and starts over, and on a cold start nothing else can
 * have delivered it: the plugin host starts on first-interactive, which waits
 * for this restore. Only a saved pane naming an unknown agent asks, so a
 * workspace with none pays nothing.
 */
export async function loadSavedPanesPluginAgents(
  savedPanels: readonly (TerminalState | undefined)[] | undefined,
  projectId: string | null
): Promise<void> {
  const plugin = typeof window !== "undefined" ? window.electron?.plugin : undefined;
  if (!plugin?.getAgents) return;
  const namesUnknownAgent = savedPanels?.some((saved) => {
    if (saved === undefined) return false;
    const agentId = resolveRespawnAgentId(saved, inferKind(saved, projectId));
    return agentId !== undefined && !isRegisteredAgent(agentId);
  });
  if (!namesUnknownAgent) return;

  const known = getPluginAgentRegistry();
  try {
    const agents = await plugin.getAgents({ forRestore: true });
    // A broadcast heard while this was out is newer than the answer.
    if (getPluginAgentRegistry() === known) setPluginAgentRegistry(agents);
  } catch (error) {
    logWarn("[StateHydration] Couldn't load plugin agents for restore", { error });
  }
}
