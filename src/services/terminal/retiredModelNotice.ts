import { notify } from "@/lib/notify";
import { pluralize } from "@/lib/pluralize";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";

/** How long after one drop another of the same model joins its bar. */
const BURST_WINDOW_MS = 10_000;

/** Open bursts by agent and model: at most one per declared retirement. */
const bursts = new Map<string, { startedAt: number; lastAt: number; count: number }>();

/**
 * Says that a launch had a retired model taken out (#15652). Nothing on the
 * pane shows that change: its title already reads as the bare agent name for
 * an id the picker no longer lists, so without this a model an account can
 * still use would disappear unseen.
 *
 * A project restore relaunches every pane that saved the model at once. A
 * grid-bar never coalesces, so the burst is counted here and each drop
 * replaces the bar (and its inbox row) the burst already raised.
 */
export function notifyRetiredModelDropped(
  agentId: string,
  modelIds: readonly string[],
  address: { panelId?: string; worktreeId?: string } = {}
): void {
  if (modelIds.length === 0) return;
  const agentName = getEffectiveAgentConfig(agentId)?.name ?? agentId;
  const models = modelIds.join(", ");
  const key = `retired-model:${agentId}:${models}`;
  const now = Date.now();
  const open = bursts.get(key);
  const burst =
    open && now - open.lastAt < BURST_WINDOW_MS
      ? { ...open, lastAt: now, count: open.count + 1 }
      : { startedAt: now, lastAt: now, count: 1 };
  bursts.set(key, burst);

  const retired = modelIds.length === 1 ? "which has been retired" : "which have been retired";
  const removed = modelIds.length === 1 ? "it was" : "they were";
  const message =
    burst.count === 1
      ? `This ${agentName} pane was set to ${models}, ${retired}, so ${removed} removed from its launch.`
      : `${pluralize(burst.count, `${agentName} pane`)} were set to ${models}, ${retired}, so ${removed} removed from their launches.`;
  notify({
    type: "warning",
    placement: "grid-bar",
    title: "Retired model removed",
    message,
    // One pane's address only while the bar speaks for one pane.
    context: { eventKind: "recovery", ...(burst.count === 1 ? address : {}) },
    replaceKey: `${key}:${burst.startedAt}`,
  });
}
