import { lazy } from "react";
import { setPluginKitHost } from "@/components/PluginKit/kitHost";
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
  });
}
