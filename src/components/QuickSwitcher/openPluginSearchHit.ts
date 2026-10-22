import { actionService } from "@/services/ActionService";
import { isPanelLimitError } from "@/services/actions/definitions/panelLimitError";
import { notify } from "@/lib/notify";
import { logError, logWarn } from "@/utils/logger";
import { getPanelKindConfig } from "@shared/config/panelKindRegistry";
import { isOwnPluginAction } from "@shared/utils/remotePluginContributions";
import { isBuiltInActionId } from "@shared/utils/builtInActionIds";
import type { PluginSearchHit } from "@/hooks/usePluginSearch";

/**
 * Open a plugin search result (#13792) through the path its kind of target
 * already uses, so a result can do nothing a launcher row couldn't: a panel
 * through `panel.openPluginPanel`, which reuses an open one and hands it the
 * result's args as its `openRequest`, or a command through the plugin's own
 * action. Main resolved the target; ownership is checked again here, at the
 * point of dispatch, so a stale or forged row is never a side door.
 */
export function openPluginSearchHit(hit: PluginSearchHit): void {
  const { target } = hit.row;
  let dispatched: ReturnType<typeof actionService.dispatch>;
  if (target.type === "panel") {
    if (getPanelKindConfig(target.panelKindId)?.extensionId !== hit.pluginId) {
      logWarn("[PluginSearch] Refused a result whose panel isn't its plugin's own", {
        providerKey: hit.providerKey,
      });
      return;
    }
    dispatched = actionService.dispatch(
      "panel.openPluginPanel",
      { kind: target.panelKindId, initialArgs: target.args, reuseExisting: true },
      { source: "user" }
    );
  } else {
    if (!isOwnPluginAction(hit.pluginId, target.actionId) || isBuiltInActionId(target.actionId)) {
      logWarn("[PluginSearch] Refused a result whose command isn't its plugin's own", {
        providerKey: hit.providerKey,
      });
      return;
    }
    dispatched = actionService.dispatch(target.actionId, target.args, { source: "user" });
  }

  void dispatched
    .then((result) => {
      if (result.ok) return;
      if (target.type === "panel" && isPanelLimitError(result.error.message)) return;
      logError("Plugin search result refused", result.error);
      notify({
        type: "error",
        title: `Couldn't open ${hit.row.label.replace(/…$/, "")}`,
        // The plugin's own wording can name internal ids, so the toast says
        // where to look instead.
        message: `${hit.pluginName} didn't complete it. Check the plugin in Settings → Plugins, then try again.`,
        priority: "high",
        context: { eventKind: "uiFeedback" },
        action: { label: "Retry", onClick: () => openPluginSearchHit(hit) },
      });
    })
    .catch((error) => logError("Plugin search result failed", error));
}
