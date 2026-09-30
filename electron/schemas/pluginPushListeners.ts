import type { PluginPushListenerKey } from "../services/plugin/pluginPushListenerRegistry.js";

/**
 * Boundary parser for `plugin:report-push-listeners`: the renderer's full set
 * of `[transportChannel, panelId | null]` pairs with at least one plugin push
 * subscriber.
 *
 * Refusing a report is always safe — the registry then treats the renderer as
 * unknown and delivers every push to it — so anything malformed or oversized
 * returns `null` rather than a partial list. A partial list would be worse
 * than none: a pair left out reads as "no subscriber here" and would be
 * skipped.
 */

/** Pairs one report may carry; far above what any set of open panels subscribes. */
export const MAX_REPORTED_PUSH_LISTENERS = 4096;
/** `plugin:{pluginId}:{channel}` — plugin ids and channel names are both short. */
const MAX_CHANNEL_LENGTH = 1024;
const MAX_PANEL_ID_LENGTH = 512;

export function parsePushListenerReport(payload: unknown): PluginPushListenerKey[] | null {
  if (!Array.isArray(payload) || payload.length > MAX_REPORTED_PUSH_LISTENERS) return null;
  const out: PluginPushListenerKey[] = [];
  for (const item of payload as unknown[]) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [channel, panelId] = item as unknown[];
    if (
      typeof channel !== "string" ||
      !channel.startsWith("plugin:") ||
      channel.length > MAX_CHANNEL_LENGTH
    ) {
      return null;
    }
    if (
      panelId !== null &&
      (typeof panelId !== "string" || panelId.length === 0 || panelId.length > MAX_PANEL_ID_LENGTH)
    ) {
      return null;
    }
    out.push([channel, panelId]);
  }
  return out;
}
