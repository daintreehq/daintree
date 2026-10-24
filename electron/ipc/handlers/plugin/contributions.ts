import type { PluginNotificationSilence } from "../../../../shared/types/ipc/maps.js";
import {
  type ToolbarButtonConfig,
  getPluginToolbarButtonIds,
  getToolbarButtonConfig,
} from "../../../../shared/config/toolbarButtonRegistry.js";
import {
  type PanelKindConfig,
  getPluginPanelKinds,
} from "../../../../shared/config/panelKindRegistry.js";
import {
  getProjectFileEditorChoices,
  setProjectFileEditorChoice,
} from "../../../services/plugin/projectFileEditorChoices.js";
import {
  getProjectHiddenLaunchGroups,
  isHiddenGroupId,
  setProjectLaunchGroupHidden,
} from "../../../services/plugin/projectHiddenLaunchGroups.js";
import {
  getPluginNotificationSilences,
  setPluginNotificationSilenced,
} from "../../../services/plugin/pluginNotificationSilences.js";
import {
  isSearchProviderKey,
  canSetSearchProviderFrom,
  setSearchProviderShown,
} from "../../../services/plugin/searchProviderPreferences.js";
import {
  isContextProviderPluginId,
  setContextProvidersEnabled,
} from "../../../services/plugin/contextProvidersOff.js";
import {
  searchContextProvider,
  resolveContextReferences,
} from "../../../services/plugin/contextProviderCalls.js";
import type {
  ContextProviderEntry,
  ContextProviderItem,
  ContextReference,
  ContextReferenceResolution,
} from "../../../../shared/types/pluginContextProvider.js";
import { getPluginMenuItems } from "../../../services/pluginMenuRegistry.js";
import { getPluginKeybindings } from "../../../services/pluginKeybindingRegistry.js";
import { getPluginContextMenuItems } from "../../../services/pluginContextMenuRegistry.js";
import {
  selectContributionsForProject,
  getPluginLaunchEntriesForProject,
  getPluginLayoutsForProject,
} from "../../../services/plugin/PluginContributionBroadcaster.js";
import {
  type PluginLaunchEntryConfig,
  type PluginLayoutConfig,
  type PluginSearchProviderInfo,
  type PluginSearchQueryRequest,
  type PluginSearchQueryResponse,
  type PluginActionDescriptor,
  type PluginActionContribution,
  type FileEditorChoices,
  type FileEditorChoiceKey,
  type FileEditorChoice,
  isFileEditorChoiceKey,
  isFileEditorChoice,
} from "../../../../shared/types/plugin.js";
import type { IpcContext } from "../../types.js";
import {
  projectIdFromPluginInstanceKey,
  isSafePluginInstanceId,
} from "../../../services/plugin/projectPluginIdentity.js";
import { getPluginService } from "./service.js";
import { assertSenderOwnsPluginInstance } from "./senderScope.js";

export async function handleToolbarButtons(ctx: IpcContext): Promise<ToolbarButtonConfig[]> {
  // Block the renderer's mount-time pull until the startup scan has settled,
  // otherwise a fast renderer can read an empty registry before any manifest
  // registers — leaving plugin toolbar buttons missing until the next mutation
  // pushes a fresh broadcast (#9285). Not startup activation: buttons register
  // at load, and one slow activate() must not hold them (#14127).
  await (await getPluginService()).waitForCatalog();
  const buttons = getPluginToolbarButtonIds()
    .map((id) => getToolbarButtonConfig(id))
    .filter((c): c is ToolbarButtonConfig => c !== undefined);
  // Scoped to the SENDER's project, not the active one: this pull is the
  // renderer's own mount-time path and must agree with what the push path
  // broadcast to that same view.
  return selectContributionsForProject(buttons, (c) => c.pluginId, ctx.projectId);
}

/** The SENDER's project's launch entries (#13788), behind the same init guard as toolbar buttons. */
export async function handleLaunchEntries(ctx: IpcContext): Promise<PluginLaunchEntryConfig[]> {
  await (await getPluginService()).waitForCatalog();
  return getPluginLaunchEntriesForProject(ctx.projectId);
}

/** The SENDER's project's layouts (#13780), behind the same init guard as toolbar buttons. */
export async function handleLayouts(ctx: IpcContext): Promise<PluginLayoutConfig[]> {
  await (await getPluginService()).waitForCatalog();
  return getPluginLayoutsForProject(ctx.projectId);
}

/** The plugin ids whose launcher group the SENDER's project hides; empty for a view with no project. */
export async function handleHiddenLaunchGroupsGet(ctx: IpcContext): Promise<string[]> {
  if (!ctx.projectId) return [];
  return getProjectHiddenLaunchGroups(ctx.projectId);
}

/**
 * Hide or show one plugin's launcher group in the SENDER's project. Shape-checked
 * only: an id that names no loaded plugin is remembered as asked, and simply
 * hides nothing until that plugin is there.
 */
export async function handleLaunchGroupHiddenSet(
  ctx: IpcContext,
  pluginId: string,
  hidden: boolean
): Promise<string[]> {
  if (!ctx.projectId) throw new Error("launch group: sender has no project");
  if (!isHiddenGroupId(pluginId)) throw new Error("launch group: malformed plugin id");
  if (typeof hidden !== "boolean") throw new Error("launch group: malformed hidden flag");
  return setProjectLaunchGroupHidden(ctx.projectId, pluginId, hidden);
}

/**
 * Every plugin whose notifications the user silenced (#13818), named for
 * Settings → Notifications. A plugin that isn't loaded is named by its
 * manifest id, so a silence outlives the plugin and can still be lifted.
 */
export async function handleNotificationSilencesGet(): Promise<PluginNotificationSilence[]> {
  const svc = await getPluginService();
  return getPluginNotificationSilences().map((pluginId) => ({
    pluginId,
    name: svc.getPluginDisplayName(pluginId),
    projectId: projectIdFromPluginInstanceKey(pluginId),
  }));
}

/**
 * Silence or unsilence one plugin instance's toasts and notifications. A
 * project plugin's instance id names its project, so the silence is that
 * project's alone. Shape-checked only: an id that names no loaded plugin is
 * remembered as asked, as the launcher's hidden groups are.
 */
export async function handleNotificationSilenceSet(
  pluginId: string,
  silenced: boolean
): Promise<PluginNotificationSilence[]> {
  if (typeof pluginId !== "string" || !isSafePluginInstanceId(pluginId)) {
    throw new Error("plugin notifications: malformed plugin id");
  }
  if (typeof silenced !== "boolean") {
    throw new Error("plugin notifications: malformed silenced flag");
  }
  setPluginNotificationSilenced(pluginId, silenced);
  return handleNotificationSilencesGet();
}

/** The quick switcher search providers the SENDER's project can see (#13792), with the user's choices. */
export async function handleSearchProvidersGet(
  ctx: IpcContext
): Promise<PluginSearchProviderInfo[]> {
  const service = await getPluginService();
  await service.waitForCatalog();
  return service.searchCoordinator.list(ctx.projectId);
}

/**
 * Ask one search provider for the SENDER's project. The project comes from the
 * sender, never the payload, so a view can only reach providers it can see; a
 * newer query from the same view to the same provider supersedes this one.
 */
export async function handleSearchProvidersQuery(
  ctx: IpcContext,
  request: PluginSearchQueryRequest
): Promise<PluginSearchQueryResponse> {
  if (
    !request ||
    typeof request !== "object" ||
    !isSearchProviderKey(request.providerKey) ||
    typeof request.query !== "string" ||
    (request.mode !== "scoped" && request.mode !== "blended")
  ) {
    throw new Error("search provider: malformed query");
  }
  const service = await getPluginService();
  return service.searchCoordinator.query(ctx.endpoint, ctx.projectId, {
    providerKey: request.providerKey,
    query: request.query,
    mode: request.mode,
  });
}

/** Abort every search the SENDER has in flight: its switcher closed or changed scope. */
export async function handleSearchProvidersCancel(ctx: IpcContext): Promise<void> {
  const service = await getPluginService();
  service.searchCoordinator.cancel(ctx.endpoint.endpointId);
}

/**
 * Show or hide one provider in the quick switcher. A project plugin's provider
 * can only be switched from its own project's views; an installed plugin's
 * choice is app-wide. A key that names no loaded provider is remembered as
 * asked. Returns the SENDER's project's providers as they now stand.
 */
export async function handleSearchProviderShownSet(
  ctx: IpcContext,
  key: string,
  shown: boolean
): Promise<PluginSearchProviderInfo[]> {
  if (!isSearchProviderKey(key)) throw new Error("search provider: malformed key");
  if (typeof shown !== "boolean") throw new Error("search provider: malformed shown flag");
  if (!canSetSearchProviderFrom(key, ctx.projectId)) {
    throw new Error("search provider: belongs to another project");
  }
  setSearchProviderShown(key, shown);
  const service = await getPluginService();
  return service.searchCoordinator.list(ctx.projectId);
}

/** The `@` context providers the sender's project sees, and which of them hold their prefix (#13795). */
export async function handleContextProvidersGet(ctx: IpcContext): Promise<ContextProviderEntry[]> {
  const service = await getPluginService();
  await service.waitForCatalog();
  return service.getContextProvidersForProject(ctx.projectId);
}

/** The provider holding `prefix` in the sender's project, asked for matches to `query` alone. */
export async function handleContextProvidersSearch(
  ctx: IpcContext,
  prefix: string,
  query: string
): Promise<ContextProviderItem[]> {
  return searchContextProvider(await getPluginService(), ctx.projectId, prefix, query);
}

/** A draft's references, read now in the sender's project, in the order sent. */
export async function handleContextProvidersResolve(
  ctx: IpcContext,
  references: ContextReference[]
): Promise<ContextReferenceResolution[]> {
  return resolveContextReferences(await getPluginService(), ctx.projectId, references);
}

/**
 * Switch one plugin's context providers on or off. Only a plugin whose
 * providers the sender's project can see: one project's settings never reach
 * another project's plugin.
 */
export async function handleContextProvidersEnabledSet(
  ctx: IpcContext,
  pluginId: string,
  enabled: boolean
): Promise<ContextProviderEntry[]> {
  if (!isContextProviderPluginId(pluginId))
    throw new Error("context providers: malformed plugin id");
  if (typeof enabled !== "boolean") throw new Error("context providers: malformed enabled flag");
  const service = await getPluginService();
  if (!service.getContextProvidersForProject(ctx.projectId).some((e) => e.pluginId === pluginId)) {
    throw new Error("context providers: no such provider in this project");
  }
  setContextProvidersEnabled(pluginId, enabled);
  return service.getContextProvidersForProject(ctx.projectId);
}

export async function handleKeybindings(ctx: IpcContext) {
  await (await getPluginService()).waitForCatalog();
  return selectContributionsForProject(getPluginKeybindings(), (e) => e.pluginId, ctx.projectId);
}

export async function handleContextMenuItems(ctx: IpcContext) {
  // Same init-race guard as `handleToolbarButtons` — block until the startup
  // scan settles so the renderer's mount-time pull can't observe an empty
  // registry before plugins finish registering (#9285).
  await (await getPluginService()).waitForCatalog();
  return selectContributionsForProject(
    getPluginContextMenuItems(),
    (e) => e.pluginId,
    ctx.projectId
  );
}

export async function handleValidateActionIds(actionIds: string[]): Promise<void> {
  if (!Array.isArray(actionIds)) return;

  const knownIds = new Set(actionIds.filter((id): id is string => typeof id === "string"));

  // Plugin-contributed actions are registered dynamically in the renderer
  // after this snapshot runs, so their IDs won't appear in `knownIds`. Pull
  // the live plugin-action registry from the main-side PluginService and
  // treat those as known.
  for (const { id } of (await getPluginService()).listPluginActions()) {
    knownIds.add(id);
  }

  for (const id of getPluginToolbarButtonIds()) {
    const config = getToolbarButtonConfig(id);
    // A popover button dispatches nothing.
    if (!config || config.actionId === undefined) continue;
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
export async function handleActionsGet(ctx: IpcContext): Promise<PluginActionDescriptor[]> {
  const pluginService = await getPluginService();
  await pluginService.waitForCatalog();
  return selectContributionsForProject(
    pluginService.listPluginActions(),
    (a) => a.pluginId,
    ctx.projectId
  );
}

export async function handleActionsRegister(
  ctx: IpcContext,
  pluginId: string,
  contribution: PluginActionContribution
): Promise<void> {
  assertSenderOwnsPluginInstance(ctx, pluginId);
  (await getPluginService()).registerPluginAction(pluginId, contribution);
}

export async function handleActionsUnregister(
  ctx: IpcContext,
  pluginId: string,
  actionId: string
): Promise<void> {
  assertSenderOwnsPluginInstance(ctx, pluginId);
  (await getPluginService()).unregisterPluginAction(pluginId, actionId);
}

export async function handlePanelKindsGet(ctx: IpcContext): Promise<PanelKindConfig[]> {
  await (await getPluginService()).waitForCatalog();
  return selectContributionsForProject(getPluginPanelKinds(), (c) => c.extensionId, ctx.projectId);
}

/** The SENDER's project's "Edit with…" answers (#13809); empty for a view with no project. */
export async function handleFileEditorChoicesGet(ctx: IpcContext): Promise<FileEditorChoices> {
  if (!ctx.projectId) return {};
  return getProjectFileEditorChoices(ctx.projectId);
}

/**
 * Remember (or, with `null`, forget) one "Edit with…" answer in the SENDER's
 * project. Shape-checked only: an answer naming an editor that isn't on offer
 * right now simply never matches, and falls back to the host's own.
 */
export async function handleFileEditorChoiceSet(
  ctx: IpcContext,
  key: FileEditorChoiceKey,
  choice: FileEditorChoice | null
): Promise<FileEditorChoices> {
  if (!ctx.projectId) throw new Error("file editor choice: sender has no project");
  if (!isFileEditorChoiceKey(key)) throw new Error("file editor choice: malformed key");
  if (choice !== null && !isFileEditorChoice(choice)) {
    throw new Error("file editor choice: malformed choice");
  }
  return setProjectFileEditorChoice(ctx.projectId, key, choice);
}
