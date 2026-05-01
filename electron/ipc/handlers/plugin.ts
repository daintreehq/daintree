import { ipcMain } from "electron";
import { CHANNELS } from "../channels.js";
import { pluginService } from "../../services/PluginService.js";
import {
  getPluginToolbarButtonIds,
  getToolbarButtonConfig,
} from "../../../shared/config/toolbarButtonRegistry.js";
import {
  getPluginPanelKinds,
  type PanelKindConfig,
} from "../../../shared/config/panelKindRegistry.js";
import { getPluginMenuItems } from "../../services/pluginMenuRegistry.js";
import { isTrustedRendererUrl } from "../../../shared/utils/trustedRenderer.js";
import type {
  LoadedPluginInfo,
  PluginIpcHandler,
  PluginIpcContext,
  PluginActionContribution,
  PluginActionDescriptor,
} from "../../../shared/types/plugin.js";
import type { ToolbarButtonConfig } from "../../../shared/config/toolbarButtonRegistry.js";
import { typedHandle } from "../utils.js";
import { assertIpcSecurityReady } from "../ipcGuard.js";

export function registerPluginHandlers(): () => void {
  const handlers: Array<() => void> = [];

  const handleList = async (): Promise<LoadedPluginInfo[]> => {
    return pluginService.listPlugins();
  };

  const handleToolbarButtons = async (): Promise<ToolbarButtonConfig[]> => {
    return getPluginToolbarButtonIds()
      .map((id) => getToolbarButtonConfig(id))
      .filter((c): c is ToolbarButtonConfig => c !== undefined);
  };

  const handleMenuItems = async () => {
    return getPluginMenuItems();
  };

  const handleValidateActionIds = async (actionIds: string[]): Promise<void> => {
    if (!Array.isArray(actionIds)) return;

    const knownIds = new Set(actionIds.filter((id): id is string => typeof id === "string"));

    // Plugin-contributed actions are registered dynamically in the renderer
    // after this snapshot runs, so their IDs won't appear in `knownIds`. Pull
    // the live plugin-action registry from the main-side PluginService and
    // treat those as known.
    for (const { id } of pluginService.listPluginActions()) {
      knownIds.add(id);
    }

    for (const id of getPluginToolbarButtonIds()) {
      const config = getToolbarButtonConfig(id);
      if (!config) continue;
      if (!knownIds.has(config.actionId)) {
        console.warn(
          `[Plugin] Unknown actionId "${config.actionId}" on toolbar button "${config.id}" (plugin: ${config.pluginId})`
        );
      }
    }

    for (const { pluginId, item } of getPluginMenuItems()) {
      if (!knownIds.has(item.actionId)) {
        console.warn(
          `[Plugin] Unknown actionId "${item.actionId}" on menu item "${item.label}" (plugin: ${pluginId})`
        );
      }
    }
  };

  // Trust model for plugin:actions-* channels: typedHandle deliberately omits
  // an isTrustedRendererUrl check because contextBridge only exposes
  // window.electron to trusted renderer frames (the app origin). Untrusted
  // iframes, <webview>, and portal WebContents have no access to this API,
  // so no per-request URL check is needed. PLUGIN_INVOKE has a check only
  // because it uses raw ipcMain.handle for its variadic signature, which
  // gives it direct access to event.senderFrame — the typed path here does
  // not and doesn't need it.
  const handleActionsGet = async (): Promise<PluginActionDescriptor[]> => {
    return pluginService.listPluginActions();
  };

  const handleActionsRegister = async (
    pluginId: string,
    contribution: PluginActionContribution
  ): Promise<void> => {
    pluginService.registerPluginAction(pluginId, contribution);
  };

  const handleActionsUnregister = async (pluginId: string, actionId: string): Promise<void> => {
    pluginService.unregisterPluginAction(pluginId, actionId);
  };

  const handlePanelKindsGet = async (): Promise<PanelKindConfig[]> => {
    return getPluginPanelKinds();
  };

  handlers.push(typedHandle(CHANNELS.PLUGIN_LIST, handleList));

  // plugin:invoke intentionally stays on raw ipcMain.handle: its variadic
  // `...args: unknown[]` signature and senderFrame.url trust check can't be
  // expressed through IpcInvokeMap without widening types to `unknown[]`,
  // which would silently defeat the compile-time safety the migration is for.
  assertIpcSecurityReady(CHANNELS.PLUGIN_INVOKE);
  ipcMain.handle(
    CHANNELS.PLUGIN_INVOKE,
    async (event, pluginId: string, channel: string, ...args: unknown[]) => {
      const senderUrl = event.senderFrame?.url;
      if (!senderUrl || !isTrustedRendererUrl(senderUrl)) {
        throw new Error(`plugin:invoke rejected: untrusted sender (url=${senderUrl ?? "unknown"})`);
      }
      const ctx: PluginIpcContext = {
        projectId: null,
        worktreeId: null,
        webContentsId: event.sender.id,
        pluginId,
      };
      return await pluginService.dispatchHandler(pluginId, channel, ctx, args);
    }
  );
  handlers.push(() => ipcMain.removeHandler(CHANNELS.PLUGIN_INVOKE));

  handlers.push(typedHandle(CHANNELS.PLUGIN_TOOLBAR_BUTTONS, handleToolbarButtons));
  handlers.push(typedHandle(CHANNELS.PLUGIN_MENU_ITEMS, handleMenuItems));
  handlers.push(typedHandle(CHANNELS.PLUGIN_VALIDATE_ACTION_IDS, handleValidateActionIds));
  handlers.push(typedHandle(CHANNELS.PLUGIN_ACTIONS_GET, handleActionsGet));
  handlers.push(typedHandle(CHANNELS.PLUGIN_ACTIONS_REGISTER, handleActionsRegister));
  handlers.push(typedHandle(CHANNELS.PLUGIN_ACTIONS_UNREGISTER, handleActionsUnregister));
  handlers.push(typedHandle(CHANNELS.PLUGIN_PANEL_KINDS_GET, handlePanelKindsGet));

  return () => handlers.forEach((cleanup) => cleanup());
}

export function registerPluginHandler(
  pluginId: string,
  channel: string,
  handler: PluginIpcHandler
): void {
  pluginService.registerHandler(pluginId, channel, handler);
}

export function removePluginHandlers(pluginId: string): void {
  pluginService.removeHandlers(pluginId);
}
