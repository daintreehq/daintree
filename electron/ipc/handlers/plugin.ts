import { ipcMain, dialog } from "electron";
import { writeFile } from "node:fs/promises";
import { CHANNELS } from "../channels.js";
import { defineIpcNamespace, op } from "../define.js";
import { getPluginActionAuditService } from "../../services/PluginActionAuditService.js";
import {
  PLUGIN_AUDIT_MAX_RECORDS,
  PLUGIN_AUDIT_MIN_RECORDS,
  type PluginActionAuditRecord,
  type PluginAuditConfig,
} from "../../../shared/types/ipc/pluginAudit.js";
import { PLUGIN_METHOD_CHANNELS } from "./plugin.preload.js";
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
import { getPluginKeybindings } from "../../services/pluginKeybindingRegistry.js";
import { getPluginContextMenuItems } from "../../services/pluginContextMenuRegistry.js";
import {
  getRegisteredForgeProviders,
  type RegisteredForgeProvider,
} from "../../services/forgeProviderRegistry.js";
import { getFileDecorationImpls } from "../../services/fileDecorationRegistry.js";
import type { FileDecoration } from "../../../shared/types/forge.js";
import { isTrustedRendererUrl } from "../../../shared/utils/trustedRenderer.js";
import type {
  LoadedPluginInfo,
  PluginIpcHandler,
  PluginIpcContext,
  PluginActionContribution,
  PluginActionDescriptor,
} from "../../../shared/types/plugin.js";
import type { ToolbarButtonConfig } from "../../../shared/config/toolbarButtonRegistry.js";
import { assertIpcSecurityReady } from "../ipcGuard.js";

async function handleList(): Promise<LoadedPluginInfo[]> {
  return pluginService.listPlugins();
}

async function handleSetEnabled(pluginId: string, enabled: boolean): Promise<void> {
  pluginService.setEnabled(pluginId, enabled);
}

async function handleToolbarButtons(): Promise<ToolbarButtonConfig[]> {
  // Block the renderer's mount-time pull until startup activation has settled,
  // otherwise a fast renderer can read an empty registry before any plugin's
  // activate() runs — leaving plugin toolbar buttons missing until the next
  // mutation pushes a fresh broadcast (#9285).
  await pluginService.waitForInit();
  return getPluginToolbarButtonIds()
    .map((id) => getToolbarButtonConfig(id))
    .filter((c): c is ToolbarButtonConfig => c !== undefined);
}

async function handleMenuItems() {
  return getPluginMenuItems();
}

async function handleKeybindings() {
  return getPluginKeybindings();
}

async function handleContextMenuItems() {
  return getPluginContextMenuItems();
}

async function handleValidateActionIds(actionIds: string[]): Promise<void> {
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
}

// Trust model for plugin:actions-* channels: defineIpcNamespace deliberately
// omits an isTrustedRendererUrl check because contextBridge only exposes
// window.electron to trusted renderer frames (the app origin). Untrusted
// iframes, <webview>, and portal WebContents have no access to this API,
// so no per-request URL check is needed. PLUGIN_INVOKE has a check only
// because it uses raw ipcMain.handle for its variadic signature, which
// gives it direct access to event.senderFrame — the typed path here does
// not and doesn't need it.
async function handleActionsGet(): Promise<PluginActionDescriptor[]> {
  await pluginService.waitForInit();
  return pluginService.listPluginActions();
}

async function handleActionsRegister(
  pluginId: string,
  contribution: PluginActionContribution
): Promise<void> {
  pluginService.registerPluginAction(pluginId, contribution);
}

async function handleActionsUnregister(pluginId: string, actionId: string): Promise<void> {
  pluginService.unregisterPluginAction(pluginId, actionId);
}

async function handlePanelKindsGet(): Promise<PanelKindConfig[]> {
  await pluginService.waitForInit();
  return getPluginPanelKinds();
}

async function handleForgeProvidersGet(): Promise<RegisteredForgeProvider[]> {
  return getRegisteredForgeProviders();
}

/**
 * Per-provider budget for a single `provideDecorations` call. A provider that
 * never settles its promise would otherwise hang the whole IPC invocation
 * (and the renderer's pull) indefinitely — `Promise.allSettled` only handles
 * rejection, not a promise that simply never resolves. On expiry the slow
 * provider is treated like a rejecting one (skipped + logged); healthy
 * providers for the same scope are unaffected.
 */
const DECORATION_PROVIDER_TIMEOUT_MS = 3000;

const DECORATION_TIMEOUT = Symbol("decoration-timeout");

/**
 * A non-empty string is "present" for merge purposes. Empty string counts as
 * absent so it can't block a later provider from supplying a real value.
 */
function presentString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Resolve per-file decorations for `scope` over the given `paths` by invoking
 * every plugin impl whose declared scopes match. Results merge with
 * first-writer-wins semantics per field (badge/tooltip/color independently):
 * the first provider in plugin load order that returns a non-empty value for a
 * field on a path keeps it. The host treats every decoration opaquely — it
 * never inspects what a badge means. A provider that throws, rejects, or
 * exceeds {@link DECORATION_PROVIDER_TIMEOUT_MS} is skipped (logged) so one
 * bad plugin can't blank or stall the whole row. Only the requested paths are
 * returned — a provider that decorates unrequested paths can't leak them.
 */
async function handleFileDecorationsGet(
  scope: string,
  paths: string[]
): Promise<Record<string, FileDecoration>> {
  if (typeof scope !== "string" || scope.length === 0) return {};
  if (!Array.isArray(paths) || paths.length === 0) return {};
  const cleanPaths = [
    ...new Set(paths.filter((p): p is string => typeof p === "string" && p.length > 0)),
  ];
  if (cleanPaths.length === 0) return {};
  const requested = new Set(cleanPaths);

  // Implicit activation: any plugin that declares a provider for this scope is
  // forced to `activate()` before the impl lookup, so providers bound during
  // activate() are queryable on the first pull. No-op once already activated.
  await pluginService.activatePluginsForFileDecorationScope(scope);

  const impls = getFileDecorationImpls(scope);
  if (impls.length === 0) return {};

  const merged: Record<string, FileDecoration> = {};
  const results = await Promise.allSettled(
    impls.map(({ impl }) =>
      Promise.race([
        impl.provideDecorations(scope, cleanPaths),
        new Promise<typeof DECORATION_TIMEOUT>((resolve) =>
          setTimeout(() => resolve(DECORATION_TIMEOUT), DECORATION_PROVIDER_TIMEOUT_MS)
        ),
      ])
    )
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const { pluginId, contributionId } = impls[i];
    if (r.status === "rejected") {
      console.warn(
        `[Plugin] fileDecorationProvider "${pluginId}.${contributionId}" failed for scope "${scope}":`,
        r.reason
      );
      continue;
    }
    if (r.value === DECORATION_TIMEOUT) {
      console.warn(
        `[Plugin] fileDecorationProvider "${pluginId}.${contributionId}" timed out after ${DECORATION_PROVIDER_TIMEOUT_MS}ms for scope "${scope}"`
      );
      continue;
    }
    if (!r.value || typeof r.value !== "object") continue;
    for (const [path, decoration] of Object.entries(r.value)) {
      // Enforce the requested-paths contract at the host boundary so a
      // misbehaving provider can't widen the result set.
      if (!requested.has(path)) continue;
      if (!decoration || typeof decoration !== "object") continue;
      const target = merged[path] ?? (merged[path] = {});
      if (target.badge === undefined) {
        const badge = presentString(decoration.badge);
        if (badge !== undefined) target.badge = badge;
      }
      if (target.tooltip === undefined) {
        const tooltip = presentString(decoration.tooltip);
        if (tooltip !== undefined) target.tooltip = tooltip;
      }
      if (target.color === undefined) {
        const color = presentString(decoration.color);
        if (color !== undefined) target.color = color;
      }
    }
  }

  // Drop paths that ended up with no fields (a provider returned an entry but
  // every field was empty) so the renderer's "decorated?" check stays cheap.
  for (const [path, decoration] of Object.entries(merged)) {
    if (
      decoration.badge === undefined &&
      decoration.tooltip === undefined &&
      decoration.color === undefined
    ) {
      delete merged[path];
    }
  }

  return merged;
}

// ── Plugin-action audit log ───────────────────────────────────────────────

async function handleGetAuditRecords(): Promise<PluginActionAuditRecord[]> {
  return getPluginActionAuditService().getRecords();
}

async function handleGetAuditConfig(): Promise<PluginAuditConfig> {
  return getPluginActionAuditService().getConfig();
}

async function handleClearAuditLog(): Promise<void> {
  getPluginActionAuditService().clear();
}

async function handleSetAuditEnabled(enabled: boolean): Promise<PluginAuditConfig> {
  if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
  return getPluginActionAuditService().setEnabled(enabled);
}

async function handleSetAuditMaxRecords(max: number): Promise<PluginAuditConfig> {
  if (typeof max !== "number" || !Number.isFinite(max) || !Number.isInteger(max)) {
    throw new Error("max must be a finite integer");
  }
  if (max < PLUGIN_AUDIT_MIN_RECORDS || max > PLUGIN_AUDIT_MAX_RECORDS) {
    throw new Error(
      `max must be between ${PLUGIN_AUDIT_MIN_RECORDS} and ${PLUGIN_AUDIT_MAX_RECORDS}`
    );
  }
  return getPluginActionAuditService().setMaxRecords(max);
}

async function handleExportAuditLog(records: PluginActionAuditRecord[]): Promise<boolean> {
  if (!Array.isArray(records)) throw new Error("records must be an array");
  const ndjsonContent = getPluginActionAuditService().exportRecords(records) + "\n";
  const now = Date.now();
  const defaultFilename = `plugin-audit-log-${new Date(now).toISOString().replace(/[:.]/g, "-")}.ndjson`;
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: "Export plugin audit log",
    defaultPath: defaultFilename,
    filters: [{ name: "NDJSON Files", extensions: ["ndjson"] }],
  });
  if (canceled || !filePath) return false;
  await writeFile(filePath, ndjsonContent, "utf-8");
  return true;
}

export const pluginNamespace = defineIpcNamespace({
  name: "plugin",
  ops: {
    list: op(PLUGIN_METHOD_CHANNELS.list, handleList),
    setEnabled: op(PLUGIN_METHOD_CHANNELS.setEnabled, handleSetEnabled),
    toolbarButtons: op(PLUGIN_METHOD_CHANNELS.toolbarButtons, handleToolbarButtons),
    menuItems: op(PLUGIN_METHOD_CHANNELS.menuItems, handleMenuItems),
    keybindings: op(PLUGIN_METHOD_CHANNELS.keybindings, handleKeybindings),
    contextMenuItems: op(PLUGIN_METHOD_CHANNELS.contextMenuItems, handleContextMenuItems),
    validateActionIds: op(PLUGIN_METHOD_CHANNELS.validateActionIds, handleValidateActionIds),
    getActions: op(PLUGIN_METHOD_CHANNELS.getActions, handleActionsGet),
    registerAction: op(PLUGIN_METHOD_CHANNELS.registerAction, handleActionsRegister),
    unregisterAction: op(PLUGIN_METHOD_CHANNELS.unregisterAction, handleActionsUnregister),
    getPanelKinds: op(PLUGIN_METHOD_CHANNELS.getPanelKinds, handlePanelKindsGet),
    getForgeProviders: op(PLUGIN_METHOD_CHANNELS.getForgeProviders, handleForgeProvidersGet),
    getDecorations: op(PLUGIN_METHOD_CHANNELS.getDecorations, handleFileDecorationsGet),
    getAuditRecords: op(PLUGIN_METHOD_CHANNELS.getAuditRecords, handleGetAuditRecords),
    getAuditConfig: op(PLUGIN_METHOD_CHANNELS.getAuditConfig, handleGetAuditConfig),
    clearAuditLog: op(PLUGIN_METHOD_CHANNELS.clearAuditLog, handleClearAuditLog),
    setAuditEnabled: op(PLUGIN_METHOD_CHANNELS.setAuditEnabled, handleSetAuditEnabled),
    setAuditMaxRecords: op(PLUGIN_METHOD_CHANNELS.setAuditMaxRecords, handleSetAuditMaxRecords),
    exportAuditLog: op(PLUGIN_METHOD_CHANNELS.exportAuditLog, handleExportAuditLog),
  },
});

export function registerPluginHandlers(): () => void {
  const cleanups: Array<() => void> = [pluginNamespace.register()];

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
  cleanups.push(() => ipcMain.removeHandler(CHANNELS.PLUGIN_INVOKE));

  return () => cleanups.forEach((cleanup) => cleanup());
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
