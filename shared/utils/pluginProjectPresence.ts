import type { PluginProjectPresence, PluginProjectPresenceState } from "../types/plugin.js";

/**
 * Dispatched on a remote view's `window` when its link came back and pushes
 * from its host may have been lost, so `useProjectPresence()` reads again. A
 * host-internal edge, like the `window.electron.app` cache edges: an event
 * rather than an import because a bundled view carries its own copy of the SDK.
 */
export const PLUGIN_VIEW_RESYNC_EVENT = "daintree:plugin-view-resync";

export function isPluginProjectPresenceState(value: unknown): value is PluginProjectPresenceState {
  return value === "foreground" || value === "background" || value === "closed";
}

/**
 * Build a frozen {@link PluginProjectPresence} from an untrusted value (a
 * payload rebuilt by the worker port's or the renderer bridge's structured
 * clone) by explicit assignment, so no extra field survives. `null` for
 * anything that is not one.
 */
export function toPluginProjectPresence(value: unknown): PluginProjectPresence | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { projectId?: unknown; state?: unknown };
  if (typeof raw.projectId !== "string" || raw.projectId.length === 0) return null;
  if (!isPluginProjectPresenceState(raw.state)) return null;
  return Object.freeze({ projectId: raw.projectId, state: raw.state });
}
