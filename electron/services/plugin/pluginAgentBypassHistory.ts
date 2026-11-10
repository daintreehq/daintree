import { store } from "../../store.js";
import { broadcastToRenderer } from "../../ipc/utils.js";
import { CHANNELS } from "../../ipc/channels.js";
import { getPluginBypassArgHistory } from "../../../shared/types/agentSettings.js";
/**
 * Record the permission-bypass args the effective plugin agents declare
 * (#16374) in `agentSettings.pluginBypassArgHistory`, so restore, restart and
 * resume can strip a flag a pane saved under a declaration they can no longer
 * see: the plugin catalog loads after restore, and an update or a same-id user
 * agent replaces the declaration. Called with the plugin agent registry after
 * every change to it, since an unload can promote another plugin's agent.
 *
 * Strip-only and append-only, with no cap: a saved pane can outlive any number
 * of updates, and only a declaration not seen before adds an entry. Writes, and
 * tells every view, only then, so an unchanged registry costs a read.
 */
export function recordPluginAgentBypassArgs(
  agents: readonly { id: string; permissionBypassArgs?: readonly string[] }[]
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
    next[agent.id] = [...history, args];
    changed = true;
  }
  if (!changed) return;

  store.set("agentSettings.pluginBypassArgHistory", next);
  broadcastToRenderer(CHANNELS.AGENT_SETTINGS_CHANGED, store.get("agentSettings"));
}
