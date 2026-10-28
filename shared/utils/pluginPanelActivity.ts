import {
  PLUGIN_PANEL_ACTIVITY_REASON_MAX,
  type PluginPanelActivity,
  type PluginPanelActivityState,
} from "../types/plugin.js";
import { readField } from "./pluginWorktreeCardStatus.js";

export type PluginPanelActivityResult =
  | { ok: true; panelId: string; activity: PluginPanelActivity | null }
  | { ok: false; error: string };

const ALLOWED_KEYS = new Set(["state", "reason"]);

const STATES: ReadonlySet<PluginPanelActivityState> = new Set([
  "working",
  "waiting",
  "finished",
  "failed",
]);

/**
 * Vet one `host.setPanelActivity(panelId, activity)` call (#13820). `null` and
 * `undefined` both clear. Returns a fresh plain copy, so nothing the plugin
 * still holds can change what the host stores. Shared by the in-process host,
 * the worker proxy and the mock host so every host accepts and refuses exactly
 * the same calls. Whether the panel is one the plugin may report on is the
 * host's check, not this one's.
 */
export function validatePluginPanelActivity(
  panelId: unknown,
  activity: unknown
): PluginPanelActivityResult {
  if (typeof panelId !== "string" || panelId.length === 0) {
    return { ok: false, error: "panelId must be a non-empty string" };
  }
  if (activity === null || activity === undefined) return { ok: true, panelId, activity: null };
  if (typeof activity !== "object" || Array.isArray(activity)) {
    return { ok: false, error: "activity must be an object with a state, or null" };
  }
  const unknownKey = Object.keys(activity).find((key) => !ALLOWED_KEYS.has(key));
  if (unknownKey !== undefined) {
    return { ok: false, error: `activity has an unsupported field "${unknownKey}"` };
  }
  const state = readField(activity, "state");
  if (typeof state !== "string" || !STATES.has(state as PluginPanelActivityState)) {
    return {
      ok: false,
      error: 'activity.state must be "working", "waiting", "finished" or "failed"',
    };
  }
  const reason = readField(activity, "reason");
  let trimmed: string | undefined;
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== "string") return { ok: false, error: "activity.reason must be a string" };
    trimmed = reason.trim();
    if (trimmed.length === 0) return { ok: false, error: "activity.reason must not be empty" };
    if (/[\r\n]/.test(trimmed)) {
      return { ok: false, error: "activity.reason must be a single line" };
    }
    if (trimmed.length > PLUGIN_PANEL_ACTIVITY_REASON_MAX) {
      return {
        ok: false,
        error: `activity.reason must be at most ${PLUGIN_PANEL_ACTIVITY_REASON_MAX} characters`,
      };
    }
  }
  return {
    ok: true,
    panelId,
    activity: {
      state: state as PluginPanelActivityState,
      ...(trimmed !== undefined ? { reason: trimmed } : {}),
    },
  };
}

/** Whether two vetted reports would draw the same mark. */
export function samePanelActivity(
  a: PluginPanelActivity | undefined,
  b: PluginPanelActivity
): boolean {
  return a !== undefined && a.state === b.state && a.reason === b.reason;
}
