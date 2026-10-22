import type { PluginProjectPresence, PluginProjectPresenceState } from "../types/plugin.js";

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
