import { lazy } from "react";
import { setPluginKitHost } from "@/components/PluginKit/kitHost";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import type { PluginProjectPresence } from "@shared/types/plugin";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { notify } from "@/lib/notify";
import { actionService } from "@/services/ActionService";
import { useNotificationStore } from "@/store/notificationStore";
import { usePluginRuntimeStore } from "@/store/pluginRuntimeStore";

// Off the kit's chunk, as it always was: react-diff-view, the tokenizer client
// and the viewer's stylesheet load with the first DiffView a view renders.
const DiffViewer = lazy(() =>
  import("@/components/Worktree/DiffViewer").then((m) => ({ default: m.DiffViewer }))
);

/**
 * Gives the plugin UI kit the app's own behaviour: actions through
 * ActionService, toasts through `notify()`, the worker over plugin IPC and
 * the worktree diff viewer. Called from the renderer's bootstrap before the
 * first render; the kit never imports this module.
 */
export function installAppPluginKitHost(): () => void {
  return setPluginKitHost({
    dispatchAction: (actionId, args, options) => actionService.dispatch(actionId, args, options),
    getAction: (actionId) => actionService.get(actionId, undefined, { includeSchemas: false }),
    deniesPluginDispatch: (actionId) => actionService.deniesPluginDispatch(actionId),
    selfNotifiesOnExecutionError: (actionId) =>
      actionService.selfNotifiesOnExecutionError(actionId),
    // A plugin's toast is its own, as on the worker's path: no event kind.
    showToast: (toast) => notify(toast),
    dismissToast: (id) => useNotificationStore.getState().dismissNotification(id),
    pluginDisplayName: (owner) =>
      usePluginRuntimeStore.getState().pluginMetaById.get(owner)?.displayName || undefined,
    invokePlugin: (owner, channel, payload) =>
      window.electron.plugin.invoke(owner, channel, payload),
    DiffViewer,
    importArtifacts: async (owner, files) => {
      refuseRemoteArtifacts();
      // The preload resolves each File to its path and records it in main as
      // chosen here; main imports only paths it recorded for this view.
      const paths = window.electron.files.getDroppedFilePaths([...files]);
      if (paths.some((p) => p === "")) {
        throw new Error(
          "ARTIFACT_SOURCE_UNSUPPORTED: only files from disk can be imported, not generated ones"
        );
      }
      return window.electron.plugin.importArtifacts(owner, paths);
    },
    artifactSource: async (owner, artifactId) => {
      refuseRemoteArtifacts();
      return window.electron.plugin.getArtifactSource(owner, artifactId);
    },
    releaseArtifactSource: (url) => {
      safeFireAndForget(window.electron.plugin.releaseArtifactSource(url), {
        context: "Releasing a plugin artifact source",
      });
    },
    watchPlaybackHold,
  });
}

/**
 * Artifacts live on the machine whose plugin made them, and a window attached
 * to a remote host has no route to play or fill that cache yet (#14100).
 */
function refuseRemoteArtifacts(): void {
  const hostId = window.__DAINTREE_HOST_ID__?.id;
  if (hostId && hostId !== LOCAL_HOST_ID) {
    throw new Error(
      "ARTIFACT_REMOTE_UNSUPPORTED: artifacts can't be played or imported in a window attached to a remote host"
    );
  }
}

/**
 * Hold playback while the document is hidden, this project's view is cached
 * behind another, or its project has left the foreground. A cached view keeps
 * reporting `visible` (#10965), so the cached and warm-activated edges are
 * main's; presence is the project-wide half (#13813).
 */
function watchPlaybackHold(onChange: (held: boolean) => void): () => void {
  const app = window.electron.app;
  const plugin = window.electron.plugin;
  let cached = app.isViewCached?.() === true;
  /** `undefined` until main has named this view's project; `null` for a view with none. */
  let projectId: string | null | undefined;
  let background = false;
  // A push is never older than a read it raced, so pushes that land before
  // the read answers are kept per project and win once the project is known.
  const early = new Map<string, PluginProjectPresence>();
  let last: boolean | null = null;
  const report = () => {
    const held = document.hidden || cached || background;
    if (held === last) return;
    last = held;
    onChange(held);
  };
  const offs = [
    app.onViewCached(() => {
      cached = true;
      report();
    }),
    app.onViewWarmActivated(() => {
      cached = false;
      report();
    }),
    plugin.onProjectPresenceChanged((presence) => {
      if (projectId === undefined) {
        early.set(presence.projectId, presence);
        return;
      }
      if (presence.projectId !== projectId) return;
      background = presence.state !== "foreground";
      report();
    }),
  ];
  const onVisibility = () => report();
  document.addEventListener("visibilitychange", onVisibility);
  let live = true;
  void plugin
    .getProjectPresence()
    .then((presence) => {
      if (!live) return;
      projectId = presence?.projectId ?? null;
      const latest = (projectId !== null ? early.get(projectId) : undefined) ?? presence;
      early.clear();
      background = latest !== null && latest.state !== "foreground";
      report();
    })
    .catch(() => {
      // No answer: the document and view signals still hold playback.
      projectId = null;
      early.clear();
    });
  report();
  return () => {
    live = false;
    document.removeEventListener("visibilitychange", onVisibility);
    for (const off of offs) off();
  };
}
