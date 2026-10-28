/**
 * The project-plugin lifecycle seam.
 *
 * Both halves are deliberately fire-and-forget dynamic imports. `PluginService`
 * is a ~4,400-line module kept off `electron/window/`'s static graph on purpose
 * (#9285), and neither the switch path nor the close path may wait on plugin
 * work: a project switch must not block on a `.daintree/plugins/` scan, and a
 * close must not fail because a plugin's teardown threw.
 *
 * The two edges are sourced from where the *intent* lives, not from where the
 * teardown happens. `cleanupEntry` is reached by memory-pressure eviction, LRU
 * trimming, hibernation, a cold-start rollback and window disposal with no way
 * to tell them apart — and the user-facing close never reaches it at all. So
 * "opened" hangs off the switch (which is what actually brings a project into
 * use), and "closed" hangs off each operation's commit point: right after the
 * `closed` status write for `project:close`, `project:sleep` and the idle
 * background sweep, and right before `project:remove` deletes the row. Eviction
 * is not a close: the project is still open, its terminals still run, and its
 * plugins must survive the renderer being reclaimed.
 *
 * The same two edges are what plugins are told about a project's presence
 * (#13813), recorded synchronously so a plugin the open goes on to load already
 * finds its project open.
 */
import { getProjectPresenceTracker } from "../services/ProjectPresenceTracker.js";

/** A project came into use in some window. Idempotent; also the reconcile trigger. */
export function notifyProjectPluginsOpened(projectId: string, projectPath: string): void {
  if (!projectId || !projectPath) return;
  getProjectPresenceTracker().markOpened(projectId);
  void import("../services/PluginService.js")
    .then(({ pluginService }) => pluginService.onProjectOpened(projectId, projectPath))
    .catch((err: unknown) => {
      console.error("[projectPluginLifecycle] onProjectOpened failed:", err);
    });
}

/** This project stopped being live — closed, removed, slept or auto-parked. Unload everything it owns. */
export function notifyProjectPluginsClosed(projectId: string): void {
  if (!projectId) return;
  getProjectPresenceTracker().markClosed(projectId);
  void import("../services/PluginService.js")
    .then(({ pluginService }) => pluginService.onProjectClosed(projectId))
    .catch((err: unknown) => {
      console.error("[projectPluginLifecycle] onProjectClosed failed:", err);
    });
}

/**
 * This project was removed from Daintree, not just closed: forget which
 * installed packages it had enabled per project, so nothing reloads into a
 * project id that no longer exists. Sent after {@link notifyProjectPluginsClosed}.
 */
export function notifyProjectPluginsRemoved(projectId: string): void {
  if (!projectId) return;
  void import("../services/PluginService.js")
    .then(({ pluginService }) => pluginService.forgetProjectInstances(projectId))
    .catch((err: unknown) => {
      console.error("[projectPluginLifecycle] forgetProjectInstances failed:", err);
    });
}
