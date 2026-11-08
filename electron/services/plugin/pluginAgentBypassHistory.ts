import { store } from "../../store.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getPluginBypassArgHistory } from "../../../shared/types/agentSettings.js";
import type { PluginAgentContribution } from "../../../shared/types/plugin.js";

/** Oldest declarations drop past this, so a plugin re-released many times can't grow it unbounded. */
export const MAX_BYPASS_DECLARATIONS_PER_AGENT = 32;

/**
 * Record the permission-bypass args these plugin agents declare (#16374) in
 * `agentSettings.pluginBypassArgHistory`, so restore, restart and resume can
 * strip a flag a pane saved under a declaration they can no longer see: the
 * plugin catalog loads after restore, and an update or a same-id user agent
 * replaces the declaration. Strip-only and append-only, because a saved pane
 * can outlive any number of updates. Writes, and tells every view, only when
 * something new was declared, so an unchanged plugin costs a read.
 */
export function recordPluginAgentBypassArgs(
  agents: readonly Pick<PluginAgentContribution, "id" | "permissionBypassArgs">[]
): void {
  const declared = agents.filter((agent) => (agent.permissionBypassArgs?.length ?? 0) > 0);
  if (declared.length === 0) return;

  const raw = store.get("agentSettings") as unknown;
  const settings =
    raw !== null && typeof raw === "object" ? (raw as { pluginBypassArgHistory?: unknown }) : {};
  const stored = settings.pluginBypassArgHistory;
  const next = Object.create(null) as Record<string, string[][]>;
  if (stored !== null && typeof stored === "object") {
    for (const agentId of Object.keys(stored)) {
      const history = getPluginBypassArgHistory(settings, agentId);
      if (history.length > 0) next[agentId] = history;
    }
  }

  let changed = false;
  for (const agent of declared) {
    const args = [...(agent.permissionBypassArgs ?? [])];
    const history = Object.hasOwn(next, agent.id) ? (next[agent.id] as string[][]) : [];
    if (history.some((known) => known.join("\0") === args.join("\0"))) continue;
    next[agent.id] = [...history, args].slice(-MAX_BYPASS_DECLARATIONS_PER_AGENT);
    changed = true;
  }
  if (!changed) return;

  store.set("agentSettings.pluginBypassArgHistory", next);
  broadcastToRenderer(CHANNELS.AGENT_SETTINGS_CHANGED, store.get("agentSettings"));
}
