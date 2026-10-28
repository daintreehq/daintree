import type { AgentToolsRelaunchSession } from "../../../shared/types/ipc/pluginAgentMcp.js";
import { pluginMcpGrantRegistry, type PluginMcpGrant } from "./grantRegistry.js";
import type { AgentMcpToolScope } from "./types.js";

/**
 * The agent launches in each project that could have been handed plugin tools,
 * by terminal id. Kept for every such launch, including those that got none:
 * an agent started before a plugin was switched on is exactly the one that
 * needs a relaunch to see it. Cleared wherever the pane's MCP config is
 * revoked (PTY exit, a failed spawn), so it lives as long as the grants do.
 */
const launchesByTerminal = new Map<string, string>();

export function recordPluginToolsLaunch(terminalId: string, projectId: string): void {
  launchesByTerminal.set(terminalId, projectId);
}

export function forgetPluginToolsLaunch(terminalId: string): void {
  launchesByTerminal.delete(terminalId);
}

/** Test seam. */
export function clearPluginToolsLaunches(): void {
  launchesByTerminal.clear();
}

/** What a launch in the project would be handed now, per plugin instance. */
export interface EligiblePluginTools {
  readonly pluginInstanceId: string;
  readonly pluginDisplayName: string;
  readonly scope: AgentMcpToolScope;
}

/** A scope's tool groups, order aside; null for a scope without any. */
function groupsKey(scope: AgentMcpToolScope): string | null {
  return scope.pluginGroups === undefined
    ? null
    : scope.pluginGroups
        .map((group) => `${group.id}:${group.access}`)
        .sort()
        .join(",");
}

function sameScope(a: AgentMcpToolScope, b: AgentMcpToolScope): boolean {
  return (
    a.databases === b.databases &&
    (a.databaseWrites === true) === (b.databaseWrites === true) &&
    a.pluginEndpointId === b.pluginEndpointId &&
    groupsKey(a) === groupsKey(b)
  );
}

/**
 * The running agents in the project whose live grants don't match what a
 * launch would be handed now: a plugin they have no grant for, or one whose
 * grant reaches a different set of tools. Grants a compatible reload kept are
 * live and unchanged, so a reload alone never lists an agent; a plugin whose
 * access was taken away is no longer eligible, so losing it doesn't either —
 * a relaunch wouldn't bring it back.
 */
export function listRelaunchNeeded(
  projectId: string,
  eligible: readonly EligiblePluginTools[],
  grantsFor: (terminalId: string) => readonly PluginMcpGrant[] = (terminalId) =>
    pluginMcpGrantRegistry.listForTerminal(terminalId)
): AgentToolsRelaunchSession[] {
  const sessions: AgentToolsRelaunchSession[] = [];
  for (const [terminalId, launchProjectId] of launchesByTerminal) {
    if (launchProjectId !== projectId) continue;
    const grants = grantsFor(terminalId);
    const changed = eligible.filter(
      (tools) =>
        !grants.some(
          (grant) =>
            grant.pluginInstanceId === tools.pluginInstanceId && sameScope(grant.scope, tools.scope)
        )
    );
    if (changed.length > 0) {
      sessions.push({
        terminalId,
        pluginDisplayNames: changed.map((tools) => tools.pluginDisplayName),
      });
    }
  }
  return sessions;
}
