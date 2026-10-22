import { defineIpcNamespace, op } from "../define.js";
import { CHANNELS } from "../channels.js";
import { broadcastToProjectRenderers } from "../utils.js";
import {
  getProjectPresenceTracker,
  type ProjectPresenceTracker,
} from "../../services/ProjectPresenceTracker.js";
import type { PluginProjectPresence } from "../../../shared/types/plugin.js";
import type { IpcContext } from "../types.js";
import { PLUGIN_PROJECT_PRESENCE_METHOD_CHANNELS } from "./pluginProjectPresence.preload.js";

let tracker: ProjectPresenceTracker | undefined;

export const pluginProjectPresenceNamespace = defineIpcNamespace({
  name: "pluginProjectPresence",
  ops: {
    getProjectPresence: op(
      PLUGIN_PROJECT_PRESENCE_METHOD_CHANNELS.getProjectPresence,
      (ctx: IpcContext): PluginProjectPresence | null => {
        // The asking view's own project, resolved from its sender and never
        // taken as an argument, so a view learns nothing about any other.
        if (ctx.projectId === null) return null;
        const state = (tracker ?? getProjectPresenceTracker()).getState(ctx.projectId);
        return { projectId: ctx.projectId, state };
      },
      { withContext: true }
    ),
  },
});

/**
 * The view half of project presence (#13813): `getProjectPresence` for the
 * current state, and every change pushed to that project's own renderers,
 * cached ones included, for `useProjectPresence()` in the SDK.
 */
export function registerPluginProjectPresenceHandlers(
  source: ProjectPresenceTracker = getProjectPresenceTracker()
): () => void {
  tracker = source;
  const unregister = pluginProjectPresenceNamespace.register();
  const unsubscribe = source.subscribe((changes) => {
    for (const presence of changes) {
      broadcastToProjectRenderers(
        presence.projectId,
        CHANNELS.PLUGIN_PROJECT_PRESENCE_CHANGED,
        presence
      );
    }
  });
  return () => {
    unsubscribe();
    unregister();
    tracker = undefined;
  };
}
