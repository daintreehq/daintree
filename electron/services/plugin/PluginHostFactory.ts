import path from "path";
import { randomUUID } from "node:crypto";

import { getPluginCapabilityConsentStore } from "../plugin-capability/instances.js";
import { admitPluginToast } from "./pluginToastBudget.js";
import {
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "./projectPluginIdentity.js";
import {
  getPanelKindConfig,
  toRuntimePanelKindId,
} from "../../../shared/config/panelKindRegistry.js";
import {
  isPluginCustomIconRef,
  makePluginCustomIconKey,
} from "../../../shared/config/pluginCustomIcon.js";
import type { PluginUIPromptDispatcher, PromptRequestOptions } from "./PluginUIPromptDispatcher.js";
import { resolvePluginFrontend } from "./pluginFrontendRouting.js";
import { assertPluginCallerDrives } from "./pluginDriveLease.js";
import {
  interruptLaunchedAgent,
  launchedAgentProject,
  type LaunchedAgentPty,
  recordPluginLaunch,
  sendKeysToLaunchedAgent,
  submitToLaunchedAgent,
  validateLaunchedAgentId,
  validateSendKeysCall,
} from "./pluginLaunchedAgents.js";
import { PluginFrontendMethod } from "./pluginFrontendRequests.js";
import { assertSettingsKey } from "./PluginSettingsManager.js";
import type {
  PluginServiceCallContext,
  PluginServiceProvideContribution,
  PluginServicesApi,
} from "../../../shared/types/pluginServices.js";
import { assertStorageKey, type ExplicitStorageTarget } from "./PluginStorageManager.js";
import { createListenerFailureState, invokeTrackedListener } from "./pluginCallbackUtils.js";
import {
  WorktreeChangeTracker,
  createSubscriptionCoalescer,
  resolveSubscriptionDebounceMs,
  resolveSubscriptionDebounceMsOr,
} from "./pluginSubscriptionCoalescing.js";
import { isChannelSchema } from "./PluginChannelRegistry.js";
import { abortErrorFor } from "./pluginAbortError.js";
import {
  checkedSchemaOptions,
  openPluginDatabase,
  resolvePluginDatabaseLocation,
} from "./pluginDatabase.js";
import {
  PLUGIN_PANEL_ACTIVITY_MAX_PANELS,
  PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT,
  type PluginDatabaseApi,
  type PluginDatabaseContribution,
  type PluginTaskApi,
  type PluginWorktreeSetupStepHandler,
} from "../../../shared/types/plugin.js";
import {
  inertPluginTaskHandle,
  validatePluginTaskProgress,
  validatePluginTaskResult,
  validatePluginTaskStart,
} from "../../../shared/utils/pluginTasks.js";
import type { PluginTaskRecord } from "./PluginTaskRegistry.js";
import {
  databaseBackupApprovers,
  databaseWriteAuthorizers,
  fsWriteApprovers,
  pushListenerObservers,
} from "./pluginInternalApprovers.js";
import { agentMcpEndpointRegistry } from "../pluginAgentMcp/endpointRegistry.js";
import { validateAgentMcpTools } from "../pluginAgentMcp/validateTools.js";
import type { AgentMcpToolInvoker } from "../pluginAgentMcp/types.js";

import { events } from "../events.js";
import { getPtyClient } from "../../window/serviceRefs.js";
import {
  registerForgeProviderImpl,
  unregisterForgeProviderImpl,
  validateForgeImplRoles,
} from "../forgeProviderRegistry.js";
import { buildStoredCredentials } from "../forge/forgeCredentialUtils.js";
import {
  registerFileDecorationProviderImpl,
  unregisterFileDecorationProviderImpl,
  scopeMatchesPattern,
} from "../fileDecorationRegistry.js";
import {
  registerWorktreeDeleteNotesBinding,
  unregisterWorktreeDeleteNotesBinding,
  type WorktreeDeleteNotesBinding,
} from "./worktreeDeleteNotesRegistry.js";
import {
  isWorktreeSetupStepDeclared,
  registerWorktreeSetupStepHandler,
  unregisterWorktreeSetupStepHandler,
} from "../worktreeSetupStepRegistry.js";
import { bindSearchProviderImpl } from "./pluginSearchProviderRegistry.js";
import {
  registerContextProviderImpl,
  unregisterContextProviderImpl,
} from "../contextProviderRegistry.js";
import { broadcastToRenderer, broadcastToProjectRenderers } from "../../ipc/utils.js";
import {
  PLUGIN_PUSH_MAX_PAYLOAD_BYTES,
  PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES,
  PLUGIN_TERMINAL_SCREEN_MAX_LINES,
} from "../../../shared/config/pluginBudgets.js";
import {
  admitPluginTerminalScreenRead,
  readPluginTerminalScreen,
} from "./pluginTerminalScreenRead.js";
import { isAssistantTerminalRecord } from "../assistantTerminal.js";
import { assertPayloadWithinLimit, snapshotPayload } from "./pluginPayloadLimits.js";
import { resolveInvokeTimeoutMs, runWithInvokeDeadline } from "./pluginInvokeDeadline.js";
import {
  PLUGIN_STATE_PANEL_ACTIVITY,
  PLUGIN_STATE_PANEL_BADGES,
  flushPluginPushes,
  getPluginStatePublisher,
  routePluginPush,
  withPushFlushBarrier,
} from "./pluginPushBatcher.js";
import { getPluginPushListenerRegistry } from "./pluginPushListenerRegistry.js";
import { isAppError } from "../../utils/errorTypes.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { maskTerminalInOtherProject } from "../../../shared/utils/terminalInOtherProject.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  isBuiltInActionId,
  PluginNotifyOptionsSchema,
  PluginPanelBadgeSchema,
  PluginToastOptionsSchema,
  PluginToolbarButtonRuntimeStateSchema,
} from "../../schemas/plugin.js";
import {
  normalizePanelMenuItems,
  samePanelMenuItems,
} from "../../../shared/utils/pluginPanelMenuItems.js";
import {
  applyPluginContextEntry,
  validatePluginContextEntry,
} from "../../../shared/utils/pluginContextKeys.js";
import {
  sameWorktreeCardStatus,
  validatePluginWorktreeCardStatus,
} from "../../../shared/utils/pluginWorktreeCardStatus.js";
import {
  sameWorktreeReviewChecks,
  validatePluginWorktreeReviewChecks,
} from "../../../shared/utils/pluginWorktreeReviewChecks.js";
import {
  sameTerminalStatus,
  validatePluginTerminalStatus,
} from "../../../shared/utils/pluginTerminalStatus.js";
import {
  samePanelActivity,
  validatePluginPanelActivity,
} from "../../../shared/utils/pluginPanelActivity.js";
import { makeForgeProviderId } from "../../../shared/utils/forgeProviderIds.js";
import { forgeProviderRoles } from "../../../shared/utils/forgeProviderRoles.js";
import { toPluginWorktreeStatus } from "../../../shared/utils/pluginWorktreeSnapshot.js";
import type { AgentStateChangePayload } from "../../../shared/utils/pluginAgentSnapshot.js";
import {
  toPluginTerminalLifecycleEvent,
  type TerminalLifecycleObservation,
} from "../../../shared/utils/pluginTerminalLifecycle.js";
import {
  toPluginAllAgentsSnapshot,
  UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT,
} from "../../../shared/utils/pluginAllAgentsSnapshot.js";
import {
  NO_FOCUSED_PANEL,
  pluginFocusedPanelEquals,
} from "../../../shared/utils/pluginFocusedPanel.js";
import { PLUGIN_FOCUSED_PANEL_DEFAULT_DEBOUNCE_MS } from "../../../shared/config/pluginBudgets.js";
import { getFocusedPanelTracker, type FocusedPanelState } from "../FocusedPanelTracker.js";
import { getProjectPresenceTracker } from "../ProjectPresenceTracker.js";
import {
  createPluginEventScope,
  type PluginWorktreeEventPayload,
  type PluginWorktreeSnapshotFetchResult,
} from "./pluginEventScope.js";
import type { WorktreeSnapshot } from "../../../shared/types/workspace-host.js";
import {
  promptOpensDialog,
  type PluginRunRecipeRequest,
  type PluginSendToAgentRequest,
  type PluginUiPromptResultValue,
} from "../../../shared/types/pluginUiPrompt.js";
import { SEND_TO_AGENT_MAX_ID_LENGTH, SEND_TO_AGENT_REFUSAL_REASONS } from "./sendToAgentLimits.js";
import { RUN_RECIPE_MAX_ID_LENGTH, toRunRecipeResult } from "./runRecipeLimits.js";
import { getPluginRecipe, getPluginRecipeOwner } from "./PluginRecipeRegistry.js";
import { validatePluginRecipeVariables } from "../../../shared/utils/pluginRecipeVariables.js";
import { isAgentRecipeType } from "../../../shared/types/project.js";
import {
  AGENT_CONTEXT_MAX_TEXT_LENGTH,
  AGENT_CONTEXT_MAX_TITLE_LENGTH,
  sanitizeAgentContextSourceLabel,
  validateAgentContextPayload,
} from "../../../shared/utils/agentContextDrag.js";
import type {
  PluginIpcHandler,
  PluginHostApi,
  PluginIdentity,
  PluginWorktreesResult,
  PluginChannelSchema,
  PluginHandlerOptions,
  PluginIpcContext,
  PluginTypedIpcHandler,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginPromptCallOptions,
  PluginInputBoxOptions,
  PluginConfirmOptions,
  PluginSettingsScope,
  PluginStorageScope,
  PluginAgentInputResult,
  PluginAgentSnapshot,
  PluginAllAgentsSnapshot,
  PluginFocusedPanel,
  PluginProjectPresence,
  PluginProjectPresenceState,
  PluginSendToAgentRefusalReason,
  PluginSendToAgentResult,
  PluginPanelLifecycleEvent,
  PluginPanelBadge,
  PluginToolbarButtonRuntimeState,
  PluginContextValue,
  PluginHostBinding,
  PluginMcpCaller,
  PluginMcpToolDefinition,
} from "../../../shared/types/plugin.js";
import type { LoadedPlugin } from "./PluginServiceTypes.js";
import {
  type PluginHostFactoryDeps,
  trackPluginDisposer,
  ensureCapabilityConsent,
} from "./pluginHostDeps.js";
import { buildProcessApi } from "./pluginHostProcessApi.js";
import { buildFsApi } from "./pluginHostFsApi.js";
import { buildGitApi } from "./pluginHostGitApi.js";
import { buildClipboardApi } from "./pluginHostClipboardApi.js";
import { buildSystemApi } from "./pluginHostSystemApi.js";
import { buildDocumentsApi } from "./pluginHostDocumentsApi.js";
import { buildArtifactsApi } from "./pluginHostArtifactsApi.js";

export { buildFsApi } from "./pluginHostFsApi.js";
export type { PluginHostFactoryDeps } from "./pluginHostDeps.js";

/**
 * Max file paths a single `host.invalidateFileDecorations` call broadcasts.
 * A misbehaving plugin could otherwise pass an unbounded array, forcing an
 * arbitrarily large IPC payload to every renderer view. Beyond the cap the
 * scope-wide invalidation (no `paths`) is the correct fallback anyway.
 */
const MAX_FILE_DECORATION_PATHS = 1000;

/**
 * Most panels one plugin may hold a runtime menu on at once. Main keeps the
 * lists for replay and cannot tell a closed panel from one moving between
 * windows, so a plugin that never clears is bounded rather than trusted.
 */
const PLUGIN_PANEL_MENUS_MAX_PANELS = 256;
/** Most panels one plugin may badge at once, for the same reason as its menus. */
const PLUGIN_PANEL_BADGES_MAX_PANELS = 256;

/** An omitted colour is `default`, so it is the same badge as one that says so. */
function sameToolbarButtonState(
  a: PluginToolbarButtonRuntimeState,
  b: PluginToolbarButtonRuntimeState
): boolean {
  return (
    a.pressed === b.pressed &&
    a.disabled === b.disabled &&
    a.disabledReason === b.disabledReason &&
    a.busy === b.busy &&
    a.tooltip === b.tooltip &&
    a.iconId === b.iconId &&
    (a.menu === undefined
      ? b.menu === undefined
      : b.menu !== undefined && samePanelMenuItems(a.menu, b.menu))
  );
}

function samePanelBadge(a: PluginPanelBadge, b: PluginPanelBadge): boolean {
  return (
    a.kind === b.kind &&
    (a.color ?? "default") === (b.color ?? "default") &&
    a.tooltip === b.tooltip &&
    (a.kind !== "label" || (b.kind === "label" && a.text === b.text))
  );
}

/**
 * Is this the frozen `PROJECT_VIEW_UNAVAILABLE` rejection a bound renderer
 * round-trip raises? The read-only catalog surface is documented as resolving
 * empty rather than throwing when no renderer is available, so it swallows
 * exactly this failure — and nothing else, which would mask real bugs.
 */
function isProjectViewUnavailable(error: unknown): boolean {
  return isAppError(error) && error.code === "PROJECT_VIEW_UNAVAILABLE";
}

/**
 * A targeted `terminal.close` for a project with no live view (#13507): main
 * closes it as it does for an MCP call with no frontend (#13498), trashing the
 * process and dropping the panel from the saved layout, so finished work no
 * longer waits for someone to open the project. Nothing opens a view.
 *
 * Exactly one action: the main-side path never passes through ActionService's
 * plugin gates (`denyPluginDispatch`, restricted, confirm), so widening this to
 * every action main can run would hand a targeting grant a side door.
 * Anything else, or a project main does not know, keeps the original rejection.
 */
async function closeWithNoView(
  error: unknown,
  actionId: string,
  args: unknown,
  projectId: string
): Promise<ActionDispatchResult> {
  if (actionId !== "terminal.close" || !isProjectViewUnavailable(error)) throw error;
  const { runViewlessAction } = await import("../viewless/index.js");
  // Only the id goes on: main admits the call on its raw args, where a stray
  // field (a `recipeId`) could ask for a confirmation a view would never need.
  const terminalId = (args as { terminalId?: unknown } | null | undefined)?.terminalId;
  const result = await runViewlessAction({
    workspaceId: projectId,
    actionId,
    args: typeof terminalId === "string" ? { terminalId } : args,
    confirmed: false,
  });
  if (result === null) throw error;
  // The same uniform miss a view's answer gets for a terminal in another project (#13120).
  return maskTerminalInOtherProject(result);
}

/**
 * Validate the `items` passed to `host.showQuickPick` and return a structurally
 * narrowed copy — only the serializable fields cross the IPC boundary, so a
 * plugin that attaches extra non-cloneable properties (functions, class
 * instances) can't strand the send. Throws on a non-array or any malformed row
 * so authoring mistakes surface loudly (mirrors the showToast options check).
 */
function validateQuickPickItems(
  pluginId: string,
  items: PluginQuickPickItem[]
): PluginQuickPickItem[] {
  if (!Array.isArray(items)) {
    throw new Error(`Plugin "${pluginId}" showQuickPick: items must be an array`);
  }
  const seen = new Set<string>();
  return items.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Plugin "${pluginId}" showQuickPick: items[${index}] must be an object`);
    }
    if (typeof item.id !== "string" || item.id.length === 0) {
      throw new Error(
        `Plugin "${pluginId}" showQuickPick: items[${index}].id must be a non-empty string`
      );
    }
    if (typeof item.label !== "string") {
      throw new Error(`Plugin "${pluginId}" showQuickPick: items[${index}].label must be a string`);
    }
    // Ids must be unique — selection tracking and multi-select keys off the id,
    // so a duplicate would toggle/return multiple rows in lockstep.
    if (seen.has(item.id)) {
      throw new Error(
        `Plugin "${pluginId}" showQuickPick: duplicate item id "${item.id}" (ids must be unique)`
      );
    }
    seen.add(item.id);
    return {
      id: item.id,
      label: item.label,
      ...(item.description !== undefined ? { description: String(item.description) } : {}),
      ...(item.detail !== undefined ? { detail: String(item.detail) } : {}),
    };
  });
}

const SEND_TO_AGENT_REFUSAL_REASON_SET = new Set<string>(SEND_TO_AGENT_REFUSAL_REASONS);

function validateOptionalId(pluginId: string, name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > SEND_TO_AGENT_MAX_ID_LENGTH
  ) {
    throw new Error(
      `Plugin "${pluginId}" sendToAgent: options.${name} must be a non-empty string of at most ${SEND_TO_AGENT_MAX_ID_LENGTH} characters`
    );
  }
  return value;
}

/** Check a `host.terminals.readScreen` call and resolve its line count. */
function validateReadScreenCall(pluginId: string, terminalId: unknown, options: unknown): number {
  if (
    typeof terminalId !== "string" ||
    terminalId.length === 0 ||
    terminalId.length > SEND_TO_AGENT_MAX_ID_LENGTH
  ) {
    throw new Error(
      `Plugin "${pluginId}" terminals.readScreen: terminalId must be a non-empty string of at most ${SEND_TO_AGENT_MAX_ID_LENGTH} characters`
    );
  }
  if (options === undefined) return PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES;
  if (options === null || typeof options !== "object") {
    throw new Error(`Plugin "${pluginId}" terminals.readScreen: options must be an object`);
  }
  const lines = (options as { lines?: unknown }).lines;
  if (lines === undefined) return PLUGIN_TERMINAL_SCREEN_DEFAULT_LINES;
  if (
    typeof lines !== "number" ||
    !Number.isInteger(lines) ||
    lines < 1 ||
    lines > PLUGIN_TERMINAL_SCREEN_MAX_LINES
  ) {
    throw new Error(
      `Plugin "${pluginId}" terminals.readScreen: options.lines must be an integer from 1 to ${PLUGIN_TERMINAL_SCREEN_MAX_LINES}`
    );
  }
  return lines;
}

/**
 * Check a `host.sendToAgent` call against the drag payload's own limits and
 * return the normalised text and title. Throws so an authoring mistake fails
 * loudly, like the other host APIs, rather than reaching the user as a picker
 * that drafts nothing.
 */
function validateSendToAgentCall(
  pluginId: string,
  text: unknown,
  options: unknown
): Omit<PluginSendToAgentRequest, "sourceLabel"> {
  if (options !== undefined && (typeof options !== "object" || options === null)) {
    throw new Error(`Plugin "${pluginId}" sendToAgent: options must be an object`);
  }
  const opts = (options ?? {}) as Record<string, unknown>;
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error(
      `Plugin "${pluginId}" sendToAgent: text must be a non-empty, non-whitespace string`
    );
  }
  if (opts.title !== undefined && typeof opts.title !== "string") {
    throw new Error(`Plugin "${pluginId}" sendToAgent: options.title must be a string`);
  }
  const payload = validateAgentContextPayload({ v: 1, text, title: opts.title });
  if (payload === null) {
    throw new Error(
      `Plugin "${pluginId}" sendToAgent: text must hold printable content and be at most ${AGENT_CONTEXT_MAX_TEXT_LENGTH} characters, and options.title at most ${AGENT_CONTEXT_MAX_TITLE_LENGTH}`
    );
  }
  const terminalId = validateOptionalId(pluginId, "terminalId", opts.terminalId);
  const worktreeId = validateOptionalId(pluginId, "worktreeId", opts.worktreeId);
  return {
    text: payload.text,
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(terminalId !== undefined ? { terminalId } : {}),
    ...(worktreeId !== undefined ? { worktreeId } : {}),
  };
}

/**
 * Check a `host.runRecipe` call (#13797). The recipe is looked up under the
 * caller's OWN instance id and its registered owner re-checked, so a plugin can
 * only ever reach its own recipes — never by naming another plugin's qualified
 * id, and never by an id that merely starts with its own. Variables are held to
 * the names the recipe declares.
 */
function validateRunRecipeCall(
  pluginId: string,
  recipeId: unknown,
  options: unknown
): Omit<PluginRunRecipeRequest, "sourceLabel"> {
  if (typeof recipeId !== "string" || recipeId.length === 0 || recipeId.length > 64) {
    throw new Error(
      `Plugin "${pluginId}" runRecipe: recipeId must be the id of one of this plugin's contributes.recipes`
    );
  }
  const qualifiedId = `${pluginId}.${recipeId}`;
  const owner = getPluginRecipeOwner(qualifiedId);
  const recipe = getPluginRecipe(qualifiedId);
  if (
    owner === undefined ||
    owner.pluginId !== pluginId ||
    owner.contributionId !== recipeId ||
    recipe === undefined
  ) {
    throw new Error(
      `Plugin "${pluginId}" runRecipe: this plugin contributes no recipe "${recipeId}"`
    );
  }
  // A plugin never chooses an agent's launch flags or environment: its own
  // `agent.launch` is refused for either (#13762), and a recipe it runs is held
  // to the same rule. The system prompt is the one exception, and the user
  // reads it in full before anything starts.
  const configuredStep = recipe.terminals.findIndex(
    (terminal) =>
      isAgentRecipeType(terminal.type) &&
      ((terminal.args?.trim() ?? "") !== "" || Object.keys(terminal.env ?? {}).length > 0)
  );
  if (configuredStep !== -1) {
    throw new Error(
      `Plugin "${pluginId}" runRecipe: recipe "${recipeId}" step ${configuredStep + 1} sets launch arguments or environment for its agent, which a plugin can't choose, as with agent.launch. The user can still run it from the recipe list.`
    );
  }
  if (options !== undefined && (options === null || typeof options !== "object")) {
    throw new Error(`Plugin "${pluginId}" runRecipe: options must be an object`);
  }
  const opts = (options ?? {}) as Record<string, unknown>;
  const worktreeId = opts.worktreeId;
  if (
    worktreeId !== undefined &&
    (typeof worktreeId !== "string" ||
      worktreeId.length === 0 ||
      worktreeId.length > RUN_RECIPE_MAX_ID_LENGTH)
  ) {
    throw new Error(
      `Plugin "${pluginId}" runRecipe: options.worktreeId must be a non-empty string of at most ${RUN_RECIPE_MAX_ID_LENGTH} characters`
    );
  }
  const variables = validatePluginRecipeVariables(opts.variables, recipe.pluginVariables ?? []);
  if (!variables.ok) {
    throw new Error(`Plugin "${pluginId}" runRecipe: ${variables.reason}`);
  }
  return {
    recipeId: qualifiedId,
    // A plain object for the structured clone to the renderer, built from the
    // null-prototype copy's own declared keys only.
    variables: { ...variables.values },
    ...(worktreeId !== undefined ? { worktreeId } : {}),
  };
}

/**
 * The renderer's answer, narrowed to the public result. Anything malformed
 * reads as a dismissal: the renderer is ours, so this only guards against a
 * response from a build that disagrees about the shape.
 */
function toSendToAgentResult(value: unknown): PluginSendToAgentResult {
  if (typeof value === "object" && value !== null) {
    const result = value as Record<string, unknown>;
    if (result.status === "drafted" && typeof result.terminalId === "string") {
      return { status: "drafted", terminalId: result.terminalId };
    }
    if (
      result.status === "refused" &&
      typeof result.reason === "string" &&
      SEND_TO_AGENT_REFUSAL_REASON_SET.has(result.reason as PluginSendToAgentRefusalReason)
    ) {
      return {
        status: "refused",
        reason: result.reason as PluginSendToAgentRefusalReason,
        ...(typeof result.worktreeId === "string" && result.worktreeId.length > 0
          ? { worktreeId: result.worktreeId.slice(0, SEND_TO_AGENT_MAX_ID_LENGTH) }
          : {}),
      };
    }
  }
  return { status: "cancelled" };
}

/**
 * Coerce the string fields of the prompt option objects before they cross to
 * the renderer. A buggy plugin passing a non-string (e.g. `{ message: {} }`)
 * would otherwise crash the dialog inside its ErrorBoundary and strand the
 * pending promise until unload — coercion keeps the round-trip serializable and
 * the dialog renderable. Booleans are normalized with `Boolean(...)`.
 */
function sanitizeQuickPickOptions(options?: PluginQuickPickOptions): PluginQuickPickOptions {
  if (!options || typeof options !== "object") return {};
  return {
    ...(options.title !== undefined ? { title: String(options.title) } : {}),
    ...(options.placeholder !== undefined ? { placeholder: String(options.placeholder) } : {}),
    ...(options.canSelectMany !== undefined
      ? { canSelectMany: Boolean(options.canSelectMany) }
      : {}),
    ...(options.matchOnDescription !== undefined
      ? { matchOnDescription: Boolean(options.matchOnDescription) }
      : {}),
  };
}

function sanitizeInputBoxOptions(options?: PluginInputBoxOptions): PluginInputBoxOptions {
  if (!options || typeof options !== "object") return {};
  return {
    ...(options.title !== undefined ? { title: String(options.title) } : {}),
    ...(options.prompt !== undefined ? { prompt: String(options.prompt) } : {}),
    ...(options.placeholder !== undefined ? { placeholder: String(options.placeholder) } : {}),
    ...(options.value !== undefined ? { value: String(options.value) } : {}),
    ...(options.password !== undefined ? { password: Boolean(options.password) } : {}),
    ...(options.validationPattern !== undefined
      ? { validationPattern: String(options.validationPattern) }
      : {}),
    ...(options.validationMessage !== undefined
      ? { validationMessage: String(options.validationMessage) }
      : {}),
  };
}

function sanitizeConfirmOptions(options: PluginConfirmOptions): PluginConfirmOptions {
  return {
    title: String(options.title),
    ...(options.message !== undefined ? { message: String(options.message) } : {}),
    ...(options.confirmLabel !== undefined ? { confirmLabel: String(options.confirmLabel) } : {}),
    ...(options.cancelLabel !== undefined ? { cancelLabel: String(options.cancelLabel) } : {}),
    ...(options.destructive !== undefined ? { destructive: Boolean(options.destructive) } : {}),
  };
}

export type { PluginWorktreeEventPayload, PluginWorktreeSnapshotFetchResult };

/**
 * The functions `host.registerService` binds, by method. `handlers` must be a
 * plain object with exactly the declared methods as its own keys — the same
 * rule a worker's proxy applies, so a plugin behaves alike in either.
 */
function serviceMethodTable(
  pluginId: string,
  provided: PluginServiceProvideContribution,
  handlers: unknown
): Map<string, (args: unknown, ctx: PluginServiceCallContext) => unknown> {
  const prefix = `Plugin "${pluginId}" registerService("${provided.name}")`;
  if (!handlers || typeof handlers !== "object") {
    throw new Error(`${prefix}: handlers must be an object with one function per declared method`);
  }
  const declared = new Set(provided.methods);
  const extra = Object.keys(handlers).find((key) => !declared.has(key));
  if (extra !== undefined) {
    throw new Error(`${prefix}: "${extra}" is not one of the declared methods`);
  }
  const table = new Map<string, (args: unknown, ctx: PluginServiceCallContext) => unknown>();
  for (const method of provided.methods) {
    const fn = Object.hasOwn(handlers, method)
      ? (handlers as Record<string, unknown>)[method]
      : undefined;
    if (typeof fn !== "function") {
      throw new Error(`${prefix}: declared method "${method}" has no function`);
    }
    table.set(method, fn as (args: unknown, ctx: PluginServiceCallContext) => unknown);
  }
  return table;
}

/**
 * Run one agent MCP tool the way {@link AgentMcpToolInvoker} promises: a sync
 * throw and a sync return both become a promise, and the promise rejects the
 * moment `signal` aborts even if `execute` never looks at it — a plugin that
 * ignores its signal must not be able to hold a call open past its budget.
 * Called as a method on the plugin's own definition so an `execute` written
 * with `this` behaves as it would in the worker, where it is called that way.
 */
function runAgentMcpTool(
  definition: PluginMcpToolDefinition,
  execute: PluginMcpToolDefinition["execute"],
  args: Record<string, unknown>,
  caller: PluginMcpCaller,
  signal: AbortSignal
): Promise<unknown> {
  if (signal.aborted) return Promise.reject(abortErrorFor(signal));
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = (): void => reject(abortErrorFor(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    const detach = (): void => signal.removeEventListener("abort", onAbort);
    let result: unknown;
    try {
      result = Reflect.apply(execute, definition, [args, caller, signal]);
    } catch (err) {
      detach();
      reject(err);
      return;
    }
    Promise.resolve(result).then(
      (value) => {
        detach();
        resolve(value);
      },
      (err: unknown) => {
        detach();
        reject(err);
      }
    );
  });
}

/**
 * A `host.account` call's `ref`, checked at the boundary: an object whose two
 * optional fields are strings. Which project and connection it means is
 * decided by the account service alone.
 */
function accountRef(
  pluginId: string,
  method: string,
  ref: unknown
): { connection?: string; projectId?: string } {
  if (ref === undefined) return {};
  if (ref === null || typeof ref !== "object" || Array.isArray(ref)) {
    throw new Error(`Plugin "${pluginId}" account.${method}: ref must be an object`);
  }
  const { connection, projectId } = ref as Record<string, unknown>;
  if (connection !== undefined && typeof connection !== "string") {
    throw new Error(`Plugin "${pluginId}" account.${method}: ref.connection must be a string`);
  }
  if (projectId !== undefined && typeof projectId !== "string") {
    throw new Error(`Plugin "${pluginId}" account.${method}: ref.projectId must be a string`);
  }
  return {
    ...(connection !== undefined ? { connection } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
  };
}

/**
 * Build one plugin's host object.
 *
 * `binding` names the project this host acts for and is captured here, once —
 * every closure below reads the captured values, never the focused project
 * view, so "which project?" is answered at construction rather than at call
 * time. An unbound binding (`projectId: null`) is the app-global default for
 * installed and builtin plugins and leaves every surface exactly as it was.
 */
/**
 * Per plugin registry, the newest instance registered or hosted under each id —
 * kept past that instance's unload, so a host from an older generation stays
 * retired from settings writes (#14092).
 */
const newestInstances = new WeakMap<PluginHostFactoryDeps["plugins"], Map<string, LoadedPlugin>>();

/**
 * Record `plugin` as the newest instance under `pluginId`. Called as it enters
 * the registry, so a successor that never makes a host (a lazy plugin whose
 * secret was saved from the settings form) still retires its predecessor's hosts.
 */
export function noteNewestPluginInstance(
  plugins: PluginHostFactoryDeps["plugins"],
  pluginId: string,
  plugin: LoadedPlugin
): void {
  let byId = newestInstances.get(plugins);
  if (!byId) {
    byId = new Map();
    newestInstances.set(plugins, byId);
  }
  byId.set(pluginId, plugin);
}

export function createHost(
  deps: PluginHostFactoryDeps,
  pluginId: string,
  binding: PluginHostBinding
): { host: PluginHostApi; revoke: () => void } {
  let revoked = false;
  const { projectId: boundProjectId, projectRoot: boundProjectRoot } = binding;
  // Which project's events and worktrees this host sees, and what each payload
  // holds — shared with the manifest event routes held for the same instance,
  // so the two can never disagree (#13816).
  const {
    boundPlugin,
    isBound,
    fetchWorktreeSnapshotsResult,
    pluginProjectionFor,
    isEventForBoundProject,
    isAgentEventForBoundProject,
    projectAgentTransition,
    canObserveAgents,
    seesProjectPresence,
  } = createPluginEventScope(deps, pluginId, binding);

  /**
   * The array-shaped read the pre-#12174 surfaces still use. Every unavailable
   * reason flattens back to `[]` here, which is the fail-closed sentinel those
   * surfaces are built on: `${worktree}` and `${project}` allowlist roots drop
   * so containment denies (#9492), `getWorktreeStatus` answers `null`, and the
   * default spawn cwd falls back rather than pointing into another project.
   *
   * Not every worktree-derived surface routes through here — worktree-scoped
   * *storage* resolves its target through `resolveBoundWorktreeTarget`, which
   * reads the projected `getWorktreesResult` so it can name one worktree rather
   * than flatten the set (#12229). Unbound storage skips both and stays on the
   * manager's own app-global lookup.
   */
  const fetchWorktreeSnapshots = async (): Promise<WorktreeSnapshot[]> => {
    const result = await fetchWorktreeSnapshotsResult();
    return result.status === "ok" ? result.snapshots : [];
  };

  /**
   * How a prompt travels beyond this machine: the name a remote frontend shows
   * for it, and whether it may wait for someone to attach.
   */
  const promptRequestOptions = (callOptions?: PluginPromptCallOptions): PromptRequestOptions => ({
    pluginDisplayName: deps.pluginDisplayName(pluginId),
    ...(callOptions?.whenNoFrontend === "queue" ? { whenNoFrontend: "queue" as const } : {}),
  });

  /**
   * Renderer push for this host: the bound project's views only.
   *
   * Unbound reaches every renderer on purpose — an app-global plugin's panels,
   * badges and toasts belong to no single project. The bound path widens to a
   * full broadcast only while no project view is registered anywhere (boot, or
   * a window that never routes through ProjectViewManager); in that state there
   * is no other project's view for it to reach.
   */
  const sendToScope: (channel: string, ...args: unknown[]) => void =
    boundProjectId === null
      ? broadcastToRenderer
      : (channel, ...args) => broadcastToProjectRenderers(boundProjectId, channel, ...args);
  // Every direct renderer delivery from this host — badges, decoration
  // invalidations and toasts here, and dispatches, prompts and panel reloads
  // through the wrapped collaborators below — first delivers what this plugin
  // already pushed: a renderer must never see a toast, a prompt or a reload
  // before the panel update that preceded it.
  const pushToRenderers = (channel: string, ...args: unknown[]): void => {
    flushPluginPushes();
    sendToScope(channel, ...args);
  };
  const dispatcher = withPushFlushBarrier(deps.dispatcher);
  const promptDispatcher = withPromptWaitTracking(
    withPushFlushBarrier(deps.promptDispatcher),
    deps.trackPromptWait
  );
  const panelReloadDispatcher = withPushFlushBarrier(deps.panelReloadDispatcher);

  /**
   * What a plugin's toast or notification carries into the inbox (#13818):
   * which plugin raised it, the project it is about, and where it leads. All
   * of it comes from this closure's binding and the host's own checks.
   */
  const pluginNotificationContext = (
    displayName: string,
    projectId: string | null,
    address?: { panelId: string } | { worktreeId: string }
  ) => ({
    ...(projectId !== null ? { projectId } : {}),
    ...address,
    plugin: { id: pluginId, name: displayName },
  });

  /**
   * This plugin's toasts and notifications, delivered one at a time in the
   * order it raised them (#13818). Each waits on a different lookup first (a
   * worktree list, a cold read of a project's mute), so without a queue a later
   * call could reach the renderer first and an earlier one then replace it.
   */
  let notificationTail: Promise<unknown> = Promise.resolve();
  const inNotificationOrder = <T>(deliver: () => Promise<T>): Promise<T> => {
    const delivery = notificationTail.then(deliver);
    notificationTail = delivery.catch(() => undefined);
    return delivery;
  };

  /**
   * Hold a `host.notify` target to the caller (#13818). A panel must be one of
   * this plugin's own, by the same kind registry `reloadPanel` trusts, and a
   * worktree one this host can see. One proven to be someone else's rejects;
   * one that can't be checked yet (no window has reported the panel, the
   * worktree list is unavailable) is dropped and the notification goes out
   * without it.
   */
  const resolveNotifyTarget = async (
    target: { panelId: string } | { worktreeId: string } | undefined
  ): Promise<{
    address: { panelId: string } | { worktreeId: string };
    projectId?: string;
  } | null> => {
    if (target === undefined) return null;
    if ("panelId" in target) {
      const located = deps.panelLifecycleBroker.locate(target.panelId, pluginId);
      if (located.kind === "foreign" || located.kind === "non-plugin") {
        throw new Error(
          `Plugin "${pluginId}" notify: target.panelId "${target.panelId.slice(0, 200)}" is not one of this plugin's panels`
        );
      }
      return located.kind === "located" || located.kind === "not-mounted"
        ? { address: { panelId: target.panelId } }
        : null;
    }
    const result = await fetchWorktreeSnapshotsResult();
    if (result.status !== "ok") return null;
    if (!result.snapshots.some((snapshot) => snapshot.id === target.worktreeId)) {
      throw new Error(
        `Plugin "${pluginId}" notify: target.worktreeId "${target.worktreeId.slice(0, 200)}" is not a worktree this plugin can see`
      );
    }
    return { address: { worktreeId: target.worktreeId }, projectId: result.projectId };
  };

  /**
   * The `plugin:{pluginId}:{channel}` transport shared by broadcastToRenderer
   * and postToPanel. Throws on an oversize payload (each caller surfaces that
   * the way it surfaces its other validation errors); the worker proxy applies
   * the same cap before the payload crosses its port, and this re-check covers
   * builtins and a worker that skipped it. Delivery is batched per renderer and, for a
   * targeted push, narrowed to the renderer holding the panel.
   */
  const pushPluginMessage = (channel: string, panelId: string | null, payload: unknown): void => {
    const what = `push payload on "${channel}"`;
    let bytes: number;
    let snapshot: unknown;
    try {
      bytes = assertPayloadWithinLimit(pluginId, what, payload, PLUGIN_PUSH_MAX_PAYLOAD_BYTES);
      // Delivery is deferred to the next flush, so a builtin that mutates and
      // re-posts one object must not have both pushes carry its final state.
      // Cloning here also refuses an uncloneable payload on the call that made
      // it, instead of failing a whole renderer batch later.
      snapshot = snapshotPayload(pluginId, what, payload);
    } catch (err) {
      // Metered here because a refused push never reaches the batcher's flush
      // observer, which is where accepted pushes are counted.
      if (isBound()) deps.recordPushRejected?.(pluginId);
      throw err;
    }
    routePluginPush({
      pluginId,
      projectId: boundProjectId,
      channel: `plugin:${pluginId}:${channel}`,
      panelId,
      payload: snapshot,
      bytes,
      locatePanel: (target, owner) => deps.panelLifecycleBroker.pushTargetsFor(target, owner),
    });
  };

  /** Validate a push channel name and return its `plugin:{pluginId}:{channel}` transport. */
  const pushListenerChannel = (method: string, channel: unknown): string => {
    if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
      throw new Error(
        `Plugin "${pluginId}" ${method}: channel must be a non-empty string without colons: ${String(channel)}`
      );
    }
    return `plugin:${pluginId}:${channel}`;
  };

  /**
   * Wrap a channel handler in its invoke deadline. The wrapper keeps the
   * handler's declared arity, which the dispatch-time signature hint reads.
   */
  const withInvokeDeadline = <
    THandler extends (ctx: PluginIpcContext, ...args: never[]) => unknown,
  >(
    channel: string,
    timeoutMs: number,
    handler: THandler
  ): THandler => {
    if (timeoutMs === 0) return handler;
    const call = handler as unknown as (ctx: PluginIpcContext, ...args: unknown[]) => unknown;
    const wrapped = (ctx: PluginIpcContext, ...args: unknown[]): unknown =>
      runWithInvokeDeadline(pluginId, channel, timeoutMs, ctx, (scoped) => call(scoped, ...args));
    Object.defineProperty(wrapped, "length", { value: handler.length });
    return wrapped as unknown as THandler;
  };

  /**
   * The project root a `"project"`-scoped settings or storage call targets.
   *
   * Unbound stays `null`, which both managers read as "use the app-global
   * active project" — the only thing an installed or builtin plugin can mean.
   * A bound-but-rootless binding is malformed and resolves to `""`, which they
   * reject outright: falling through to the ambient read there would hand the
   * plugin whichever project happens to be focused.
   */
  const boundScopeRoot: string | null = boundProjectId === null ? null : (boundProjectRoot ?? "");

  const assertAccountHostLoaded = (method: string): void => {
    if (!isBound()) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" account.${method}: plugin is no longer loaded`
      );
    }
  };

  // A host made before its instance was registered has no frozen manifest and
  // falls back to the live one (`undefined` takes the lookup's default).
  const declaring = boundPlugin?.manifest;
  if (boundPlugin !== undefined) noteNewestPluginInstance(deps.plugins, pluginId, boundPlugin);
  const assertSettingsInstanceCurrent = (method: string): void => {
    if (boundPlugin === undefined) return;
    const current = deps.plugins.get(pluginId);
    // A successor that has since unloaded still retires this instance: its
    // own settings, perhaps a secret this instance declared ordinary, stay on disk.
    const superseded =
      (current !== undefined && current !== boundPlugin) ||
      newestInstances.get(deps.plugins)?.get(pluginId) !== boundPlugin;
    if (superseded) {
      throw new Error(
        `PLUGIN_UNLOADED: plugin "${pluginId}" settings.${method}: this instance was replaced by a reload; only the running instance can change its settings`
      );
    }
  };
  // Last agent-state snapshot observed for this host since it subscribed via
  // onDidChangeAgentState. The host keeps no pre-subscription history, so
  // getAgentState() returns null until the first transition is observed.
  let lastAgentSnapshot: PluginAgentSnapshot | null = null;
  // The app-wide agent list crosses every project, so a project-bound host —
  // scoped to its own project everywhere else — is refused it outright rather
  // than handed a filtered copy that would read as "the whole app".
  const assertCanReadAllAgents = (method: string): void => {
    if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" ${method} requires "agent:read", which is not declared in manifest.capabilities`
      );
    }
    if (boundProjectId !== null) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" ${method} lists agents in every project, which is not available to a project plugin`
      );
    }
  };
  const assertDeclaresAgentInput = (op: string): void => {
    if (!deps.declaredCapabilities(pluginId).has("agent:input")) {
      throw new Error(
        `PERMISSION_REQUIRED: plugin "${pluginId}" agents.${op} requires "agent:input", which is not declared in manifest.capabilities`
      );
    }
  };
  /**
   * Run one `host.agents` input call against an agent this plugin launched
   * (#14018), in `sendToActiveAgent`'s order: the caller has checked liveness,
   * the declared capability and its arguments. A call that would answer
   * `not-found` raises no consent prompt, and the record is read again after
   * the prompt and before every write, since the plugin can unload or the
   * terminal move while the user decides or a key sequence is paced out.
   */
  const withLaunchedAgent = async <T extends { readonly status: string }>(
    op: string,
    terminalId: string,
    run: (pty: LaunchedAgentPty, admitWrite: () => Promise<boolean>) => Promise<T>
  ): Promise<T | Exclude<PluginAgentInputResult, { readonly status: "sent" }>> => {
    const owns = (): boolean => {
      const pty = getPtyClient();
      return (
        pty !== null && launchedAgentProject(pty, pluginId, terminalId, boundProjectId) !== null
      );
    };
    if (getPtyClient() === null) return { status: "unavailable" };
    if (!owns()) return { status: "not-found" };
    await ensureCapabilityConsent(deps, pluginId, "agent:input");
    if (!isBound()) return { status: "unavailable" };
    const pty = getPtyClient();
    if (pty === null) return { status: "unavailable" };
    if (!owns()) return { status: "not-found" };
    return run(pty, async () => {
      if (!isBound() || !owns()) return false;
      // Typing into an agent is held to the lease its terminal's input is, and
      // asked again before every write, so a takeover while the call waited on
      // a read or between paced keys stops it.
      await assertPluginCallerDrives(pluginId, `agents.${op}`, { terminalId });
      return isBound() && owns();
    });
  };
  /**
   * A dispatch of this plugin's, recording the agent an `agent.launch` of its
   * own started (#14018) before the plugin sees the result. `projectId` is
   * where the dispatch was sent: the bound project, an explicit target, or null
   * for an installed plugin's ambient dispatch.
   */
  const dispatchAsPlugin = async (
    actionId: string,
    args: unknown,
    projectId: string | null
  ): Promise<ActionDispatchResult> => {
    const result = await dispatcher.sendDispatchToRenderer(actionId, args, projectId, pluginId);
    if (isBound()) recordPluginLaunch(pluginId, actionId, args, result, projectId);
    return result;
  };
  /**
   * The availability- and scope-aware worktree read behind
   * {@link PluginHostApi.getWorktreesResult}, and the single source the
   * `[]`/`null`-shaped `getWorktrees` and `getActiveWorktree` project from, so
   * the three can never disagree about what this host can see (#12174).
   */
  const getWorktreesResult = async (): Promise<PluginWorktreesResult> => {
    if (!isBound()) return { status: "unavailable", reason: "plugin-unloaded" };
    try {
      const result = await fetchWorktreeSnapshotsResult();
      // Re-checked after the await: an unload (or a same-id reload) that landed
      // while the read was in flight makes these snapshots the previous
      // instance's, so they are discarded rather than handed to whatever still
      // holds this stale host.
      if (!isBound()) return { status: "unavailable", reason: "plugin-unloaded" };
      if (result.status !== "ok") return { status: "unavailable", reason: result.reason };
      // Projection is inside the boundary too: toPluginWorktreeSnapshot throws
      // on a malformed snapshot, and this method's contract is to answer with
      // data rather than reject into whatever timer called it.
      return {
        status: "ok",
        projectId: result.projectId,
        worktrees: result.snapshots.map(pluginProjectionFor(result)),
      };
    } catch {
      return isBound()
        ? { status: "unavailable", reason: "fetch-failed" }
        : { status: "unavailable", reason: "plugin-unloaded" };
    }
  };

  let worktreeCardStatusChain: Promise<void> = Promise.resolve();
  let worktreeReviewChecksChain: Promise<void> = Promise.resolve();
  let terminalStatusChain: Promise<void> = Promise.resolve();

  // Identity is derived once, here, from the id and binding this host was built
  // with. Deriving it host-side — through the canonical parser that owns the key
  // format — is the whole point: it is what lets a plugin stop splitting its own
  // id apart to find its manifest id or its project (#12211).
  const manifestId = pluginManifestIdFromInstanceKey(pluginId);
  // Origin comes from the KEY, not the binding. The key states what the plugin
  // *is*; the binding states which project this host acts for, and the two
  // disagreeing is a malformed binding, not a global plugin. Reading origin off
  // the binding would silently downgrade such a host to "global" and hand back
  // a dotted id that aliases a project kind onto a global one — the exact
  // collision `toRuntimePanelKindId` refuses to mint.
  const pluginInfo: PluginIdentity = Object.freeze({
    instanceId: pluginId,
    manifestId,
    origin:
      projectIdFromPluginInstanceKey(pluginId) === null
        ? ("global" as const)
        : ("project" as const),
    projectId: boundProjectId,
    projectRoot: boundProjectRoot,
  });

  /**
   * The worktree a `"worktree"`-scoped storage call targets (#12229).
   *
   * The project-root counterpart, `boundScopeRoot`, is fixed for the host's
   * lifetime; the active worktree is not — the user switches it while the host
   * stays alive — so this resolves per call rather than once at construction.
   *
   * Deliberately reads `getWorktreesResult`, the same project-filtered source
   * `getActiveWorktree` projects from, so the two agree about which worktree is
   * active at the moment either resolves. (Only at that moment: calls straddling
   * a switch see different worktrees, which is the point of resolving per call.)
   * Every unavailable reason (including a projection that threw, and an unload
   * caught by that method's own liveness re-checks) collapses to `""`, which the
   * manager rejects: for a filesystem target, failing closed beats salvaging a
   * path out of a snapshot set the binding boundary already called malformed.
   *
   * Unbound returns `undefined` so the manager keeps its app-global lookup —
   * an installed or builtin plugin has no project of its own, so the active
   * worktree is the only thing its worktree scope can mean.
   */
  const resolveBoundWorktreeTarget = async (): Promise<string | undefined> => {
    if (boundProjectId === null) return undefined;
    const result = await getWorktreesResult();
    if (result.status !== "ok") return "";
    const active = result.worktrees.find((w) => w.isCurrent)?.path;
    // The projection copies `path` straight off the workspace host's snapshot
    // without validating it, and this is the one consumer that turns it into a
    // filesystem root. A non-string would throw out of `path.join`, turning
    // `storage.get`'s documented quiet "no target" into a rejection; a relative
    // one would resolve against Electron's cwd, outside every project.
    return typeof active === "string" && path.isAbsolute(active) ? active : "";
  };

  /**
   * The target a storage call resolves against. Only `"worktree"` scope pays for
   * the project-filtered snapshot read — `"user"` and `"project"` need nothing
   * beyond the static root, and they are the hot path.
   */
  const storageTargetFor = async (scope: PluginStorageScope): Promise<ExplicitStorageTarget> =>
    scope === "worktree"
      ? { projectRoot: boundScopeRoot, worktreePath: await resolveBoundWorktreeTarget() }
      : { projectRoot: boundScopeRoot };

  const fsApi = buildFsApi(deps, pluginId);
  // By identity, not id: a host kept by a plugin that has since reloaded
  // must not reach the new instance's declarations or register handles on it.
  const requireBoundForDb = (op: string): void => {
    if (!isBound()) {
      throw new Error(`PLUGIN_UNLOADED: plugin "${pluginId}" ${op}: plugin is no longer loaded`);
    }
  };
  const prepareDatabaseBackup = async (id: string, destPath: string): Promise<string> => {
    await resolveDatabase(id, { readonly: true });
    const approve = fsWriteApprovers.get(fsApi);
    if (!approve) throw new Error(`Plugin "${pluginId}" db.backup: unavailable`);
    const approved = await approve(`db.backup:${id}`, destPath);
    requireBoundForDb("db.backup");
    return approved;
  };

  const declaredDatabase = (id: string) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`Plugin "${pluginId}" db: id must be a non-empty string`);
    }
    requireBoundForDb("db");
    const declaration = (boundPlugin?.manifest.contributes.databases ?? []).find(
      (d) => d.id === id
    );
    if (!declaration) {
      throw new Error(
        `DB_NOT_DECLARED: plugin "${pluginId}" db: "${id}" is not declared in contributes.databases`
      );
    }
    return declaration;
  };

  // Writing a project database changes the repository, so a call from a view
  // that watches the project is refused as its `host.fs` writes are. Asked on
  // every write, not once at open: a handle outlives the lease it was opened
  // under. A local database is in no project and passes. The file's own path,
  // not the bound root, since it may sit in a nested project; worked out as
  // the resolver will, so it can be asked before anything is created.
  // A held handle also names the file it resolved, since a link on the way
  // may have moved since.
  const requireCallerDrivesDatabase = async (
    declaration: PluginDatabaseContribution,
    op: string,
    openedPath?: string
  ): Promise<void> => {
    if (declaration.location !== "project" || boundProjectRoot === null) return;
    const target = path.resolve(
      boundProjectRoot,
      declaration.path ?? `.daintree/data/${manifestId}/${declaration.id}.db`
    );
    const paths =
      openedPath !== undefined && openedPath !== target ? [target, openedPath] : [target];
    await assertPluginCallerDrives(pluginId, `db.${op}`, { paths });
    requireBoundForDb(`db.${op}`);
  };

  const resolveDatabase = async (id: string, options?: { readonly?: boolean }) => {
    const readonly = options?.readonly === true;
    const declaration = declaredDatabase(id);
    // Before consent and the directory: a refused open creates nothing.
    if (!readonly) await requireCallerDrivesDatabase(declaration, "open");
    // A project database is a file in the repository: creating its directory,
    // the file, and every migration are project writes, so they wait for the
    // same first-use consent `host.fs.writeFile` does. A local database is
    // plugin-private state, like `host.storage`, and needs none.
    // A read-only open creates and writes nothing, so it needs no consent.
    if (declaration.location === "project" && !readonly) {
      await ensureCapabilityConsent(deps, pluginId, "fs:project-write");
      requireBoundForDb("db");
      // Control may have moved while the prompt waited.
      await requireCallerDrivesDatabase(declaration, "open");
    }
    const location = await resolvePluginDatabaseLocation({
      declaration,
      manifestId,
      projectRoot: boundProjectRoot,
      dataDir: deps.pluginDataDir(pluginId),
      existingOnly: readonly,
    });
    requireBoundForDb("db");
    return location;
  };

  const authorizeDatabaseWrite = (id: string, openedPath?: string): Promise<void> => {
    if (
      openedPath !== undefined &&
      (typeof openedPath !== "string" || !path.isAbsolute(openedPath))
    ) {
      return Promise.reject(new Error(`Plugin "${pluginId}" db: path must be an absolute path`));
    }
    return requireCallerDrivesDatabase(declaredDatabase(id), "write", openedPath);
  };

  const dbApi: PluginDatabaseApi = {
    resolve: (id: string, options?: { readonly?: boolean }) => resolveDatabase(id, options),
    open: async (id, options) => {
      const mode = { readonly: options?.readonly === true };
      // Schema options are checked before resolveDatabase prompts for
      // project-write consent, so a malformed open never banks a grant (#10524).
      const schema = checkedSchemaOptions(id, options);
      const location = await resolveDatabase(id, mode);
      let untrack: (() => void) | null = null;
      const database = await openPluginDatabase(location, {
        ...options,
        ...schema,
        revalidate: () => resolveDatabase(id, mode),
        authorizeWrite: () => authorizeDatabaseWrite(id, location.path),
        prepareBackup: (destPath) => prepareDatabaseBackup(id, destPath),
        onClosed: () => untrack?.(),
      });
      if (!isBound()) {
        await database.close();
        throw new Error(
          `PLUGIN_UNLOADED: plugin "${pluginId}" db.open: plugin is no longer loaded`
        );
      }
      untrack = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        void database.close();
      });
      return database;
    },
  };
  databaseBackupApprovers.set(dbApi, prepareDatabaseBackup);
  databaseWriteAuthorizers.set(dbApi, authorizeDatabaseWrite);

  // The live disposer per `agentMcp` endpoint, so a replaced roster is released
  // rather than kept reachable from the unload cascade for the host's lifetime.
  const mcpRosterDisposers = new Map<string, () => void>();

  /**
   * Hold one of the caller's actions, written in its manifest namespace, to
   * that namespace and rewrite it to its instance's — the same rule as
   * setPanelMenuItems, so a notification button or a task's Retry can only run
   * what the plugin could already put in its own panel menu.
   */
  const resolveOwnActionId = (method: string, field: string, authored: string): string => {
    const ownPrefix = `${manifestId}.`;
    if (!authored.startsWith(ownPrefix) || authored.length === ownPrefix.length) {
      throw new Error(
        `Plugin "${pluginId}" ${method}: ${field} "${authored.slice(0, 200)}" must be one of this plugin's own actions, written "${manifestId}.<id>"`
      );
    }
    const actionId = `${pluginId}.${authored.slice(ownPrefix.length)}`;
    // A manifest name can spell a built-in's prefix ("worktree.resource"), and
    // a click runs with the user's authority, so the rewritten id must still
    // be the plugin's and never a built-in's.
    if (isBuiltInActionId(actionId)) {
      throw new Error(
        `Plugin "${pluginId}" ${method}: ${field} "${actionId}" is a built-in action, not one of this plugin's own`
      );
    }
    return actionId;
  };

  // NOT revoke-guarded: tasks start from commands and timers long after
  // activate() (#13819). The record a handle holds is its identity in the
  // registry, so a handle outliving an unload or a worker swap is inert.
  const tasksApi: PluginTaskApi = {
    start: async (options) => {
      if (!isBound()) return inertPluginTaskHandle();
      const vetted = validatePluginTaskStart(options);
      if (!vetted.ok) throw new Error(`Plugin "${pluginId}" tasks.start: ${vetted.error}`);
      // Checked here so a bad retry fails where it was written, not when a
      // failure finally needs it. The authored id is what's kept: the failure
      // goes out through notify, which rewrites it again.
      resolveOwnActionId("tasks.start", "retry.actionId", vetted.value.retry.actionId);
      let record: PluginTaskRecord;
      try {
        record = deps.pluginTasks.start(pluginId, {
          ...vetted.value,
          pluginName: deps.pluginDisplayName(pluginId),
        });
      } catch (err) {
        throw new Error(
          `Plugin "${pluginId}" tasks.start: ${formatErrorMessage(err, "could not start")}`,
          { cause: err }
        );
      }
      const taskId = record.snapshot.id;
      return {
        id: taskId,
        signal: record.controller.signal,
        report: (progress) => {
          const vettedProgress = validatePluginTaskProgress(progress);
          if (!vettedProgress.ok) {
            throw new Error(`Plugin "${pluginId}" task.report: ${vettedProgress.error}`);
          }
          deps.pluginTasks.report(record, vettedProgress.value);
        },
        finish: async (result) => {
          const vettedResult = validatePluginTaskResult(result);
          if (!vettedResult.ok) {
            throw new Error(`Plugin "${pluginId}" task.finish: ${vettedResult.error}`);
          }
          const claim = deps.pluginTasks.finish(record);
          // A task the user cancelled shows nothing, however it ended.
          if (!claim || claim.cancelRequested) return;
          const outcome = vettedResult.value;
          // Through notify, so the failure is attributed, ordered, budgeted and
          // held back by a silence or a project mute like any other.
          if (outcome.outcome === "failed") {
            await host.notify({
              title: `${claim.title} failed`,
              body: outcome.message,
              severity: "error",
              actions: [
                {
                  id: "retry",
                  label: "Retry",
                  actionId: claim.retry.actionId,
                  ...(claim.retry.args !== undefined ? { args: claim.retry.args } : {}),
                },
              ],
              dedupeKey: `task:${taskId}`,
            });
          } else if (outcome.outcome === "succeeded" && outcome.message !== undefined) {
            await host.notify({
              title: claim.title,
              body: outcome.message,
              delivery: "passive",
              dedupeKey: `task:${taskId}`,
            });
          }
        },
      };
    },
  };

  const host: PluginHostApi = {
    get pluginId() {
      return pluginId;
    },
    pluginInfo,
    panelKindId: (bareId: string) => {
      if (typeof bareId !== "string" || bareId.length === 0) {
        throw new Error(`Plugin "${pluginId}" panelKindId: bareId must be a non-empty string`);
      }
      const qualified = toRuntimePanelKindId(
        { origin: pluginInfo.origin, pluginId: manifestId, kindId: bareId },
        boundProjectId
      );
      // Only reachable for a project-owned host with no project in its binding,
      // or an id carrying the `/` the qualified form delimits on. Both would
      // otherwise mint an id that resolves to no registered kind, so say so
      // rather than hand back something that silently opens nothing.
      if (qualified === null) {
        throw new Error(
          `Plugin "${pluginId}" panelKindId: cannot qualify panel kind "${bareId}" for this plugin`
        );
      }
      return qualified;
    },
    registerAction: (descriptor, handler) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerAction called after activate() returned or timed out`
        );
      }
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error(`Plugin "${pluginId}" registerAction: descriptor must be an object`);
      }
      if (typeof handler !== "function") {
        throw new Error(`Plugin "${pluginId}" registerAction: handler must be a function`);
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" registerAction: descriptor.id must be a non-empty string`
        );
      }
      // The host adds the prefix, so a pre-prefixed id would silently produce
      // a doubled "{pluginId}.{pluginId}.{id}" that still passes validation.
      // Reject it up front to enforce the "id must NOT include the plugin
      // prefix" contract (see host-api.md) instead of registering a malformed
      // action id.
      if (descriptor.id.startsWith(`${pluginId}.`)) {
        throw new Error(
          `Plugin "${pluginId}" registerAction: descriptor.id "${descriptor.id}" must not include the plugin prefix — Daintree adds it`
        );
      }
      // The host receives an un-prefixed id ("plan-from-issue") and
      // namespaces it to "{pluginId}.{id}" — the inverse of the renderer IPC
      // path, which already sends the namespaced id. validateAndBuild* then
      // checks the prefixed id against the shared format/ownership rules.
      const namespacedId = `${pluginId}.${descriptor.id}`;
      const built = deps.validateAndBuildActionDescriptor(pluginId, {
        ...descriptor,
        id: namespacedId,
      });

      // Replace semantics (per host-api.md): re-registering the same id
      // overwrites the prior descriptor + handler. Evict any stale compiled
      // input schema so the next dispatch recompiles against the new
      // descriptor. Handlers are cleaned up on unload via
      // unregisterPluginActions, matching the IPC-registered action path.
      deps.pluginActions.set(namespacedId, built);
      deps.pluginActionHandlers.set(namespacedId, handler);
      deps.actionValidators.delete(namespacedId);

      let owners = deps.pluginActionOwners.get(pluginId);
      if (!owners) {
        owners = new Set();
        deps.pluginActionOwners.set(pluginId, owners);
      }
      owners.add(namespacedId);

      deps.broadcaster.schedulePluginActionsBroadcast();
      // All registry mutation above is synchronous (sync throws still surface
      // at the call site during activate()); only the return value is async.
      return Promise.resolve();
    },
    registerHandler: ((
      channel: string,
      schemaOrHandler:
        | PluginChannelSchema<unknown, unknown>
        | PluginIpcHandler
        | PluginTypedIpcHandler<unknown, unknown>,
      typedHandlerOrOptions?: PluginTypedIpcHandler<unknown, unknown> | PluginHandlerOptions,
      typedOptions?: PluginHandlerOptions
    ) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerHandler called after activate() returned or timed out`
        );
      }
      // A function in third position is the typed overload by definition. Short
      // of that, a function in second position is the legacy overload, whose
      // optional third argument is the options bag.
      const isLegacy =
        typeof typedHandlerOrOptions !== "function" && typeof schemaOrHandler === "function";
      const options = isLegacy
        ? (typedHandlerOrOptions as PluginHandlerOptions | undefined)
        : typedOptions;
      const timeoutMs = resolveInvokeTimeoutMs(pluginId, channel, options?.timeoutMs);
      if (!isLegacy) {
        const typedHandler = typedHandlerOrOptions;
        // The typed overload by definition; if the second arg isn't a schema,
        // reject loudly instead of silently dropping the typed handler and
        // registering the second arg as a legacy handler — that mismatch would
        // look like a phantom no-op at first dispatch.
        if (!isChannelSchema(schemaOrHandler)) {
          throw new Error(
            `Plugin "${pluginId}" registerHandler: second argument must be a channel schema { args, result } when a typed handler is provided`
          );
        }
        deps.registerHandler(
          pluginId,
          channel,
          schemaOrHandler,
          typeof typedHandler === "function"
            ? withInvokeDeadline(
                channel,
                timeoutMs,
                typedHandler as PluginTypedIpcHandler<unknown, unknown>
              )
            : (typedHandler as PluginTypedIpcHandler<unknown, unknown> | undefined)
        );
      } else {
        deps.registerHandler(
          pluginId,
          channel,
          withInvokeDeadline(channel, timeoutMs, schemaOrHandler as PluginIpcHandler)
        );
      }
      return Promise.resolve();
    }) as PluginHostApi["registerHandler"],
    broadcastToRenderer: (channel, payload) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: broadcastToRenderer called after activate() returned or timed out`
        );
      }
      if (typeof channel !== "string" || channel.includes(":")) {
        throw new Error(
          `Plugin broadcast channel must be a string without colons: ${String(channel)}`
        );
      }
      // Wrap in the per-instance envelope (panelId: null = broadcast) so the
      // preload dispatcher sees the same shape for every push over this
      // transport — broadcastToRenderer, postToPanel, and the process stream
      // share the `plugin:{pluginId}:{channel}` channel and one `plugin.on`
      // subscriber receives all three.
      pushPluginMessage(channel, null, payload);
      return Promise.resolve();
    },
    // The post-activation-safe sibling of broadcastToRenderer: same
    // `plugin:{pluginId}:{channel}` transport, but NOT revoke-guarded — it is
    // called from the plugin's own timers, polls, and subscription callbacks
    // long after activate() resolves, so a plugin can stream live data into
    // its panels without the renderer degrading to invoke() polling. Liveness
    // is plugin membership (mirrors invalidateFileDecorations/showToast): once
    // the plugin unloads this silently no-ops.
    postToPanel: (channel, payload, panelId) => {
      if (!isBound()) return Promise.resolve();
      if (typeof channel !== "string" || channel.length === 0 || channel.includes(":")) {
        // Reject (not sync throw): this is a post-activation runtime-surface
        // method returning a Promise, so a validation error must stay inside
        // the Promise contract a plugin can `.catch()` (#10617). The liveness
        // no-op above stays a silent resolve.
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
          )
        );
      }
      // `undefined` (arg omitted) and `null` both mean broadcast; only a
      // non-empty string targets a single panel instance. An empty string is
      // an authoring mistake (it would silently match no subscriber), so
      // reject it loudly rather than coercing to broadcast.
      if (panelId !== undefined && panelId !== null) {
        if (typeof panelId !== "string" || panelId.length === 0) {
          // Rejects like the channel check (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" postToPanel: panelId must be a non-empty string, null, or undefined: ${String(panelId)}`
            )
          );
        }
      }
      try {
        pushPluginMessage(channel, panelId ?? null, payload);
      } catch (err) {
        // An oversize payload rejects like the channel check above (#10617).
        return Promise.reject(err);
      }
      return Promise.resolve();
    },
    // Neither is revoke-guarded: a plugin reads them from its own timers and
    // subscription callbacks, like postToPanel. Liveness is membership.
    hasListeners: (channel) => {
      const transport = pushListenerChannel("hasListeners", channel);
      if (!isBound()) return false;
      return getPluginPushListenerRegistry().hasListeners(boundProjectId, transport);
    },
    onDidChangeListeners: (channel, callback) => {
      const transport = pushListenerChannel("onDidChangeListeners", channel);
      if (typeof callback !== "function") {
        throw new Error(`Plugin "${pluginId}" onDidChangeListeners: callback must be a function`);
      }
      if (!isBound()) return () => {};
      const failures = createListenerFailureState();
      const unwatch = getPluginPushListenerRegistry().watch(
        boundProjectId,
        transport,
        (hasListeners) => {
          if (!isBound()) return;
          invokeTrackedListener(
            failures,
            pluginId,
            "onDidChangeListeners",
            () => callback(hasListeners),
            () => dispose()
          );
        }
      );
      // Tracked like every other host event subscription, so it holds the
      // worker against idle disposal: a disposed worker could not run the
      // callback, and nothing re-forks it on a listener change.
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, unwatch);
      return dispose;
    },
    getActiveWorktree: async () => {
      const result = await getWorktreesResult();
      if (result.status !== "ok") return null;
      return result.worktrees.find((w) => w.isCurrent) ?? null;
    },
    getWorktrees: async () => {
      const result = await getWorktreesResult();
      return result.status === "ok" ? result.worktrees : [];
    },
    getWorktreesResult,
    getWorktreeStatus: async (path, options) => {
      options?.signal?.throwIfAborted();
      if (!isBound()) return null;
      if (typeof path !== "string" || path.length === 0) return null;
      const snapshots = await fetchWorktreeSnapshots();
      options?.signal?.throwIfAborted();
      if (!isBound()) return null;
      const match = snapshots.find((s) => s.path === path);
      return match ? toPluginWorktreeStatus(match.worktreeChanges) : null;
    },
    getAgentState: async () => {
      // Liveness first (mirrors getActiveWorktree/getWorktrees): once unloaded
      // the method degrades to null rather than throwing, so a plugin calling
      // it from a stray timer after unload doesn't get an unhandled rejection.
      // declaredCapabilities() also returns [] post-unload, so a capability
      // check first would mis-report PERMISSION_REQUIRED for a torn-down plugin.
      if (!isBound()) return null;
      if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" getAgentState requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      return lastAgentSnapshot;
    },
    sendToActiveAgent: async (text, options) => {
      // Liveness first (mirrors getAgentState): once unloaded the method
      // degrades to a no-op rather than throwing into a stray post-unload
      // timer. declaredCapabilities() also returns [] post-unload, so a
      // capability check first would mis-report PERMISSION_REQUIRED.
      if (!isBound()) return;
      if (!deps.declaredCapabilities(pluginId).has("agent:input")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" sendToActiveAgent requires "agent:input", which is not declared in manifest.capabilities`
        );
      }
      // Validate BEFORE prompting for consent so an invalid call can't bank a
      // silent grant and then inject real text unprompted (mirrors the
      // process.spawn ordering for #10524). Reject whitespace-only text too:
      // it stages to nothing but with submit:true would fire a bare Enter,
      // submitting whatever is already in the agent's input buffer — an effect
      // the consent prompt never showed the user.
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error(
          `Plugin "${pluginId}" sendToActiveAgent: text must be a non-empty, non-whitespace string`
        );
      }
      // JIT consent fires before any side effect — first use prompts the user;
      // the grant covers later calls. Throws PERMISSION_REQUIRED on denial.
      // Re-check binding after the prompt await so a racing unload doesn't
      // inject into a torn-down session.
      await ensureCapabilityConsent(deps, pluginId, "agent:input");
      if (!isBound()) return;
      const terminalId = await resolveActiveAgentTerminalId(boundProjectId);
      if (!isBound()) return;
      if (terminalId === null) {
        // Bound host with no agent of its own: stay silent rather than reach
        // for whatever agent is focused. The user consented to this plugin
        // talking to its project's agent, never to another project's.
        if (boundPlugin) {
          deps.recordPluginLog(
            boundPlugin,
            pluginId,
            "warn",
            "sendToActiveAgent: no agent terminal is available in this plugin's project"
          );
        }
        return;
      }
      const ptyClient = getPtyClient();
      if (!ptyClient) {
        throw new Error("NO_ACTIVE_AGENT: terminal host is not available");
      }
      // Typing into an agent is held to the lease its terminal's input is.
      await assertPluginCallerDrives(pluginId, "sendToActiveAgent", { terminalId });
      if (!isBound()) return;
      // submit defaults to false — stage-only (no Enter) is the default-safe
      // mode per #10558. submit:true appends Enter and runs the text.
      if (options?.submit === true) {
        ptyClient.submit(terminalId, text);
      } else {
        ptyClient.stage(terminalId, text);
      }
    },
    // NOT revoke-guarded, like getAgentState: plugins list agents from command
    // handlers long after activation. The panes are read from the renderer that
    // owns the project's panel and worktree stores — a bound host asks its own
    // project's view and nothing else.
    agents: {
      list: async () => {
        if (!isBound()) return [];
        if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
          throw new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" agents.list requires "agent:read", which is not declared in manifest.capabilities`
          );
        }
        try {
          const agents = await dispatcher.sendAgentsListToRenderer(boundProjectId, pluginId);
          return isBound() ? agents : [];
        } catch (err) {
          if (isProjectViewUnavailable(err)) return [];
          throw err;
        }
      },
      // Answered by main from the fleet snapshot, never a renderer: per-project
      // views are LRU-evicted, and an evicted project's agents keep running.
      listAll: async () => {
        if (!isBound()) return UNAVAILABLE_PLUGIN_ALL_AGENTS_SNAPSHOT;
        assertCanReadAllAgents("agents.listAll");
        return toPluginAllAgentsSnapshot(deps.getFleetSnapshotService()?.getLastBroadcast());
      },
      // Input to the agents this plugin launched (#14018), and nothing else.
      // NOT revoke-guarded: a plugin answers its agent's dialogs from event
      // callbacks long after activation.
      interrupt: async (terminalId) => {
        if (!isBound()) return { status: "unavailable" };
        assertDeclaresAgentInput("interrupt");
        const id = validateLaunchedAgentId(pluginId, "interrupt", terminalId);
        return withLaunchedAgent("interrupt", id, (pty, admitWrite) =>
          interruptLaunchedAgent(pty, id, admitWrite)
        );
      },
      sendKeys: async (terminalId, input) => {
        if (!isBound()) return { status: "unavailable" };
        assertDeclaresAgentInput("sendKeys");
        const id = validateLaunchedAgentId(pluginId, "sendKeys", terminalId);
        const keys = validateSendKeysCall(pluginId, id, input);
        return withLaunchedAgent("sendKeys", id, (pty, admitWrite) =>
          sendKeysToLaunchedAgent(pty, id, keys, admitWrite)
        );
      },
      submit: async (terminalId, text) => {
        if (!isBound()) return { status: "unavailable" };
        assertDeclaresAgentInput("submit");
        const id = validateLaunchedAgentId(pluginId, "submit", terminalId);
        // Whitespace alone would submit to nothing but still press Enter on
        // whatever the agent's input already holds.
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new Error(
            `Plugin "${pluginId}" agents.submit: text must be a non-empty, non-whitespace string`
          );
        }
        return withLaunchedAgent("submit", id, (pty, admitWrite) =>
          submitToLaunchedAgent(pty, id, text, admitWrite)
        );
      },
    },
    // NOT revoke-guarded: grid plugins poll screens from timers long after
    // activation. Answered in main from the pty-host's own mirror, so a
    // terminal in a project with no open view still reads.
    terminals: {
      readScreen: async (terminalId, options) => {
        if (!isBound()) return { status: "unavailable" };
        if (!deps.declaredCapabilities(pluginId).has("terminal:read")) {
          throw new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" terminals.readScreen requires "terminal:read", which is not declared in manifest.capabilities`
          );
        }
        // Validated before the consent prompt, so a malformed call can't bank a
        // grant for a later one.
        const lines = validateReadScreenCall(pluginId, terminalId, options);
        await ensureCapabilityConsent(deps, pluginId, "terminal:read");
        if (!isBound()) return { status: "unavailable" };
        // Charged per consented call, whatever the id resolves to, so probing
        // ids costs the same budget as reading them.
        if (!admitPluginTerminalScreenRead(boundPlugin!, Date.now())) {
          const err = new Error(
            `RATE_LIMITED: plugin "${pluginId}" terminals.readScreen exceeded its calls-per-second limit`
          );
          (err as Error & { code?: string }).code = "RATE_LIMITED";
          throw err;
        }
        const result = await readPluginTerminalScreen(
          getPtyClient(),
          terminalId,
          boundProjectId,
          lines
        );
        return isBound() ? result : { status: "unavailable" };
      },
    },
    sendToAgent: async (text, options, callOptions) => {
      // Liveness first, for the same reason as sendToActiveAgent: an unloaded
      // plugin's declared capabilities read as empty, which would mis-report
      // PERMISSION_REQUIRED into a stray timer.
      if (!isBound()) return { status: "cancelled" };
      if (!deps.declaredCapabilities(pluginId).has("agent:input")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" sendToAgent requires "agent:input", which is not declared in manifest.capabilities`
        );
      }
      // Validated before the consent prompt, so a malformed call can't bank a
      // grant and have a later one draft unprompted.
      const request = validateSendToAgentCall(pluginId, text, options);
      await ensureCapabilityConsent(deps, pluginId, "agent:input");
      if (!isBound()) return { status: "cancelled" };
      try {
        // The prompt bridge, not a bespoke channel: without a target this is a
        // picker the user answers, and it inherits the bridge's project
        // targeting, unload drain and caller-signal dismissal. With a target it
        // answers as soon as the renderer has drafted.
        const value = await promptDispatcher.requestPrompt(
          pluginId,
          {
            kind: "sendToAgent",
            // The display name comes from the manifest unbounded; it is held to
            // the same one-line, length-capped shape as a drag's label.
            request: {
              ...request,
              sourceLabel: sanitizeAgentContextSourceLabel(deps.pluginDisplayName(pluginId)),
            },
          },
          boundProjectId,
          callOptions?.signal
        );
        return toSendToAgentResult(value);
      } catch (err) {
        if (isProjectViewUnavailable(err)) {
          return { status: "refused", reason: "project-unavailable" };
        }
        throw err;
      }
    },
    runRecipe: async (recipeId, options, callOptions) => {
      if (!isBound()) return { status: "cancelled" };
      // No capability: the recipe is this plugin's own declared content, and
      // the dialog this opens is the user's decision on every run (#13797).
      const request = validateRunRecipeCall(pluginId, recipeId, options);
      try {
        const value = await promptDispatcher.requestPrompt(
          pluginId,
          {
            kind: "runRecipe",
            request: {
              ...request,
              sourceLabel: sanitizeAgentContextSourceLabel(deps.pluginDisplayName(pluginId)),
            },
          },
          boundProjectId,
          callOptions?.signal
        );
        return toRunRecipeResult(value);
      } catch (err) {
        if (isProjectViewUnavailable(err)) {
          return { status: "refused", reason: "project-unavailable" };
        }
        throw err;
      }
    },
    onDidChangeActiveWorktree: (callback, options) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeActiveWorktree called after activate() returned or timed out`
        );
      }
      // One fetch per burst rather than per activation: the snapshot is read
      // when the window closes, so it is always the worktree active at the end.
      // Serialised like onDidChangeWorktrees, so a slow read can never land
      // after a newer activation's and leave the plugin on the older one.
      let disposed = false;
      let chain: Promise<void> = Promise.resolve();
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        () => {
          chain = chain.then(async () => {
            if (!isBound() || disposed) return;
            try {
              const result = await fetchWorktreeSnapshotsResult();
              // Re-check after the async fetch so a racing unload, or a
              // same-id reload, doesn't fire into the retired closure.
              if (!isBound() || disposed) return;
              const active =
                result.status === "ok"
                  ? result.snapshots.find((s) => s.isCurrent === true)
                  : undefined;
              callback(
                active && result.status === "ok" ? pluginProjectionFor(result)(active) : null
              );
            } catch (err) {
              console.error(
                `[PluginService] onDidChangeActiveWorktree callback for "${pluginId}" failed:`,
                err
              );
            }
          });
        }
      );
      // Subscription wired synchronously (revoke guard already held above);
      // only the disposer return value is wrapped in a resolved promise.
      const unsubscribe = deps.subscribeWorktreeEvent(pluginId, "worktree-activated", (event) => {
        // A bound host must not wake on another project activating a worktree:
        // "active" means active within its own project, so a foreign event is
        // not a change it can observe at all — nor may it extend a burst.
        if (!isEventForBoundProject(event)) return;
        if (!isBound()) return;
        coalescer.push();
      });
      // The whole disposer is tracked, not just the event unsubscribe: an
      // unload or activation rollback must also cancel a queued flush.
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        disposed = true;
        coalescer.dispose();
        unsubscribe();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeWorktrees: (callback, options) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeWorktrees called after activate() returned or timed out`
        );
      }
      // Coalesced by default: the host re-emits the worktree set on every
      // git-status poll. `debounceMs: 0` restores one callback per event.
      const tracker = new WorktreeChangeTracker();
      // Deliveries are serialised: each fetch starts after the previous one
      // delivered, so raw mode still gets one callback per event, in order,
      // and the change tracker's base is always the list handed over last.
      let chain: Promise<void> = Promise.resolve();
      const runEmit = async (): Promise<void> => {
        if (!isBound() || disposed) return;
        try {
          const result = await fetchWorktreeSnapshotsResult();
          if (!isBound() || disposed) return;
          const list =
            result.status === "ok" ? result.snapshots.map(pluginProjectionFor(result)) : [];
          callback(list, tracker.next(list));
        } catch (err) {
          console.error(
            `[PluginService] onDidChangeWorktrees callback for "${pluginId}" failed:`,
            err
          );
        }
      };
      let disposed = false;
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        () => {
          chain = chain.then(runEmit);
        }
      );
      // A foreign project's churn is dropped before the window is even armed,
      // so a bound host's trailing callback can't be pushed out by worktree
      // traffic in a project it cannot see. Churn in its own project can't
      // either: each burst fires by its deadline.
      const emit = (event?: PluginWorktreeEventPayload): void => {
        if (!isEventForBoundProject(event)) return;
        coalescer.push();
      };
      // Fires on both add/update and remove so plugins' cached lists stay
      // correct after deletions. One coalescer spans both event kinds.
      const disposeUpdate = deps.subscribeWorktreeEvent(pluginId, "worktree-update", emit);
      const disposeRemove = deps.subscribeWorktreeEvent(pluginId, "worktree-removed", emit);
      // A rename never reaches the workspace host, so main says so itself
      // (#14022). Same filter as `emit`, by id since that is what titles key on.
      const disposeTitles = deps.subscribeWorktreeCustomTitles((projectId) => {
        if (
          boundProjectId !== null &&
          (boundProjectRoot === null || projectId !== boundProjectId)
        ) {
          return;
        }
        coalescer.push();
      });
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        disposed = true;
        coalescer.dispose();
        disposeUpdate();
        disposeRemove();
        disposeTitles();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeAgentState: (callback, options) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeAgentState called after activate() returned or timed out`
        );
      }
      if (!canObserveAgents()) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" onDidChangeAgentState requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      // The agent:state-changed bus is a synchronous module-level singleton
      // (unlike WorkspaceClient), so we subscribe directly — no deferred
      // replay queue is needed. The cache behind getAgentState() is updated on
      // every transition; only delivery to the callback is coalesced.
      const failures = createListenerFailureState();
      // Latest transition per terminal within the window. Delete-then-set
      // keeps the map in the order of each terminal's latest transition.
      const pending = new Map<string, PluginAgentSnapshot>();
      let active = true;
      const deliver = (snapshot: PluginAgentSnapshot): void => {
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangeAgentState",
          () => callback(snapshot),
          () => dispose()
        );
      };
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        () => {
          const batch = [...pending.values()];
          pending.clear();
          for (const snapshot of batch) {
            // A listener quarantined mid-batch disposes the subscription; the
            // rest of the batch must not reach it.
            if (!active || !isBound()) return;
            deliver(snapshot);
          }
        }
      );
      const handler = (payload: AgentStateChangePayload): void => {
        const transition = projectAgentTransition(payload);
        if (transition === null) return;
        if (!isBound()) return;
        const { snapshot, key } = transition;
        lastAgentSnapshot = snapshot;
        pending.delete(key);
        pending.set(key, snapshot);
        coalescer.push();
      };
      const unsub = events.on("agent:state-changed", handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        coalescer.dispose();
        pending.clear();
        unsub();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeTerminalLifecycle: (callback) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeTerminalLifecycle called after activate() returned or timed out`
        );
      }
      if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" onDidChangeTerminalLifecycle requires "agent:read", which is not declared in manifest.capabilities`
        );
      }
      // Delivered one event at a time, never coalesced: these are discrete
      // facts, and a window keyed by terminal would let a short-lived
      // terminal's exit erase its spawn.
      const failures = createListenerFailureState();
      let active = true;
      const handler = (observation: TerminalLifecycleObservation): void => {
        if (!active || !isBound()) return;
        // The observer recorded the owning project at launch: the client's own
        // record is already gone by the time an exit arrives.
        const workspaceId = observation.projectId ?? null;
        if (!isAgentEventForBoundProject(workspaceId)) return;
        const event = toPluginTerminalLifecycleEvent(observation, { workspaceId });
        if (event === null) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangeTerminalLifecycle",
          () => callback(event),
          () => dispose()
        );
      };
      const unsub = events.on("terminal:lifecycle", handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        unsub();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeAllAgents: (callback, options) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeAllAgents called after activate() returned or timed out`
        );
      }
      assertCanReadAllAgents("onDidChangeAllAgents");
      const fleet = deps.getFleetSnapshotService();
      if (!fleet) {
        throw new Error(
          `FLEET_UNAVAILABLE: plugin "${pluginId}" onDidChangeAllAgents — the agent fleet is not being tracked`
        );
      }
      const failures = createListenerFailureState();
      // One slot: each publication is the whole fleet, so only the latest matters.
      let pending: PluginAllAgentsSnapshot | null = null;
      let active = true;
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        () => {
          const snapshot = pending;
          pending = null;
          if (snapshot === null || !active || !isBound()) return;
          invokeTrackedListener(
            failures,
            pluginId,
            "onDidChangeAllAgents",
            () => callback(snapshot),
            () => dispose()
          );
        }
      );
      const unsub = fleet.subscribe((snapshot) => {
        if (!active || !isBound()) return;
        pending = toPluginAllAgentsSnapshot(snapshot);
        coalescer.push();
      });
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        coalescer.dispose();
        pending = null;
        unsub();
      });
      return Promise.resolve(dispose);
    },
    onDidChangeFocusedPanel: (callback, options) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeFocusedPanel called after activate() returned or timed out`
        );
      }
      if (!deps.declaredCapabilities(pluginId).has("panel:focus-read")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" onDidChangeFocusedPanel requires "panel:focus-read", which is not declared in manifest.capabilities`
        );
      }
      const tracker = getFocusedPanelTracker();
      // A project plugin sees focus inside its own project only; focus anywhere
      // else, the Portal included, reads as no focused panel rather than as a
      // fact about another project.
      const project = (state: FocusedPanelState): PluginFocusedPanel =>
        boundProjectId === null || state.workspaceId === boundProjectId
          ? state.panel
          : NO_FOCUSED_PANEL;
      const failures = createListenerFailureState();
      let latest: PluginFocusedPanel = project(tracker.getCurrent());
      let delivered: PluginFocusedPanel | null = null;
      let active = true;
      // The issue asks for a 250–500ms trailing window: focus flips in bursts
      // (click-through, tab cycling) and only where it settles is attention.
      const debounceMs = resolveSubscriptionDebounceMsOr(
        options?.debounceMs,
        PLUGIN_FOCUSED_PANEL_DEFAULT_DEBOUNCE_MS
      );
      const deliver = (): void => {
        if (!active || !isBound()) return;
        const value = latest;
        if (delivered !== null && pluginFocusedPanelEquals(delivered, value)) return;
        delivered = value;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangeFocusedPanel",
          () => callback(value),
          () => dispose()
        );
      };
      const coalescer = createSubscriptionCoalescer(debounceMs, deliver);
      const unsub = tracker.subscribe((state) => {
        if (!active || !isBound()) return;
        latest = project(state);
        coalescer.push();
      });
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        coalescer.dispose();
        unsub();
      });
      // The current focus, replayed straight away rather than after a window a
      // later change would restart. A microtask, so the plugin holds the
      // disposer first and a throwing replay can quarantine the listener.
      queueMicrotask(deliver);
      return Promise.resolve(dispose);
    },
    onDidChangeProjectPresence: (callback, options) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangeProjectPresence called after activate() returned or timed out`
        );
      }
      // No capability gate: whether a project is shown says less than which
      // panel has focus, and an installed plugin already lists every open
      // project's worktrees. A project plugin hears about its own project only;
      // an installed one about every project, but never a scratch.
      const tracker = getProjectPresenceTracker();
      const sees = seesProjectPresence;
      const failures = createListenerFailureState();
      // Latest state per project: a burst across several projects must not
      // lose one project's change behind another's.
      const pending = new Map<string, PluginProjectPresenceState>();
      const delivered = new Map<string, PluginProjectPresenceState>();
      let active = true;
      const deliver = (): void => {
        const batch = [...pending];
        pending.clear();
        for (const [projectId, state] of batch) {
          if (!active || !isBound()) return;
          const previous = delivered.get(projectId);
          if (previous === state) continue;
          // An installed plugin was never told this project opened, so its
          // close is noise. A project plugin's own replay always answers.
          if (state === "closed" && previous === undefined && boundProjectId === null) continue;
          // Forget closed projects, so an installed plugin's bookkeeping does not
          // grow with every project ever opened; the bound plugin has one key.
          if (state === "closed" && boundProjectId === null) delivered.delete(projectId);
          else delivered.set(projectId, state);
          const presence: PluginProjectPresence = Object.freeze({ projectId, state });
          invokeTrackedListener(
            failures,
            pluginId,
            "onDidChangeProjectPresence",
            () => callback(presence),
            () => dispose()
          );
        }
      };
      const coalescer = createSubscriptionCoalescer(
        resolveSubscriptionDebounceMs(options?.debounceMs),
        deliver
      );
      // Subscribed before the replay is read, so nothing between the two is lost.
      const unsub = tracker.subscribe((changes) => {
        if (!active || !isBound()) return;
        let relevant = false;
        for (const change of changes) {
          if (!sees(change.projectId)) continue;
          pending.set(change.projectId, change.state);
          relevant = true;
        }
        if (relevant) coalescer.push();
      });
      if (boundProjectId !== null) {
        pending.set(boundProjectId, tracker.getState(boundProjectId));
      } else {
        for (const open of tracker.getOpen()) {
          if (sees(open.projectId)) pending.set(open.projectId, open.state);
        }
      }
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
        active = false;
        coalescer.dispose();
        pending.clear();
        unsub();
      });
      // Replayed straight away rather than after a window a later change would
      // restart. A microtask, so the plugin holds the disposer first and a
      // throwing replay can quarantine the listener.
      queueMicrotask(deliver);
      return Promise.resolve(dispose);
    },
    onDidChangePanelLifecycle: (callback) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidChangePanelLifecycle called after activate() returned or timed out`
        );
      }
      // No capability gate: the broker resolves panel ownership from main's own
      // kind registry, so a plugin can only ever be handed events for panel
      // instances of kinds it contributed itself (#11301).
      const failures = createListenerFailureState();
      // Teardown lives in a holder rather than a closed-over binding because,
      // unlike every other subscription here, `subscribe` REPLAYS synchronously
      // — `handler` can run before the disposer below exists. A replayed event
      // that exhausts the failure budget would otherwise touch that binding in
      // its temporal dead zone and throw ReferenceError instead of quarantining
      // the listener.
      const teardown: { dispose?: () => void; unsub?: () => void } = {};
      const handler = (event: PluginPanelLifecycleEvent): void => {
        // Runtime delivery is membership-gated, never revoke-gated (#5596):
        // these events fire for the plugin's whole life, long after activate()
        // returned, and must fall silent once it unloads.
        if (!deps.plugins.has(pluginId)) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidChangePanelLifecycle",
          () => callback(event),
          () => {
            // Mid-replay the tracked disposer does not exist yet, so fall back
            // to unsubscribing directly.
            if (teardown.dispose) teardown.dispose();
            else teardown.unsub?.();
          }
        );
      };
      // `subscribe` replays live panels synchronously, so a plugin activated BY
      // a view opening still sees that panel's `mounted` phase.
      teardown.unsub = deps.panelLifecycleBroker.subscribe(pluginId, handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        teardown.unsub?.()
      );
      teardown.dispose = dispose;
      return Promise.resolve(dispose);
    },
    onDidWake: (callback) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: onDidWake called after activate() returned or timed out`
        );
      }
      // No capability gate: the payload is the machine's own suspend/resume
      // timing and nothing else — no workspace, user, or cross-plugin data. It
      // is also strictly less than every renderer window already receives
      // unconditionally on the same wake (#12175).
      const failures = createListenerFailureState();
      const handler = (payload: { sleepDuration: number; timestamp: number }): void => {
        // Deliberately NOT filtered by the host's project binding, unlike
        // `onDidChangeAgentState`: a wake is machine-scoped, so every loaded
        // instance of the plugin must hear it, including one bound to a project
        // whose window is not focused — which is exactly the stale-state case
        // this event exists for.
        if (!deps.plugins.has(pluginId)) return;
        invokeTrackedListener(
          failures,
          pluginId,
          "onDidWake",
          () =>
            callback(
              Object.freeze({
                sleepDuration: payload.sleepDuration,
                timestamp: payload.timestamp,
              })
            ),
          () => dispose()
        );
      };
      // No replay on subscribe: a wake is a one-shot pulse with no resting
      // state to hand a late subscriber.
      const unsub = events.on("sys:wake", handler);
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => unsub());
      return Promise.resolve(dispose);
    },
    registerForgeProvider: (descriptor, impl) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerForgeProvider called after activate() returned or timed out`
        );
      }
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error(`Plugin "${pluginId}" registerForgeProvider: descriptor must be an object`);
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" registerForgeProvider: descriptor.id must be a non-empty string`
        );
      }
      if (!impl || typeof impl !== "object") {
        throw new Error(`Plugin "${pluginId}" registerForgeProvider: impl must be an object`);
      }
      // The impl is keyed by the same `{pluginId}.{descriptor.id}` namespace
      // used by the eager descriptor table. Binding an impl whose id wasn't
      // declared in `contributes.forgeProviders` produces an orphaned entry —
      // unreachable through the routing table, since `listMatchingProviders`
      // walks descriptors first. Reject up front so the failure is loud.
      const contributionId = descriptor.id;
      const plugin = deps.plugins.get(pluginId);
      const declared = plugin?.manifest.contributes.forgeProviders.find(
        (c) => c.id === contributionId
      );
      if (!declared) {
        throw new Error(
          `Plugin "${pluginId}" registerForgeProvider: descriptor.id "${contributionId}" is not declared in contributes.forgeProviders`
        );
      }
      // The manifest's roles route calls before any plugin code runs, so a
      // descriptor may restate them but never claim one the manifest didn't.
      const declaredRoles = forgeProviderRoles(declared);
      const undeclaredRole = descriptor.roles?.find((role) => !declaredRoles.includes(role));
      if (undeclaredRole) {
        throw new Error(
          `Plugin "${pluginId}" registerForgeProvider: descriptor for "${contributionId}" claims the "${undeclaredRole}" role, which contributes.forgeProviders does not declare`
        );
      }
      const roleError = validateForgeImplRoles(declared, impl);
      if (roleError) {
        throw new Error(
          `Plugin "${pluginId}" registerForgeProvider: impl for "${contributionId}" can't serve its declared roles (${declaredRoles.join(", ")}): ${roleError}`
        );
      }

      registerForgeProviderImpl(pluginId, contributionId, impl);

      // Replay the persisted credential into the freshly bound impl so a
      // cold start, plugin reload, or dev-mode rescan reaches the provider
      // authenticated (#9983) — the store is the durable source of truth but
      // nothing pushed it back into the impl on bind. Synchronous (the
      // revoked guard above already holds), and wrapped in try/catch because
      // a plugin's `setCredentials` throwing must not abort activation.
      const replayId = makeForgeProviderId(pluginId, contributionId);
      const storedCredentials = buildStoredCredentials(replayId);
      if (storedCredentials) {
        try {
          impl.setCredentials?.(storedCredentials);
        } catch (err) {
          console.warn(
            `[PluginService] registerForgeProvider: setCredentials replay failed for "${replayId}":`,
            err
          );
        }
      }

      // Pass `impl` so a stale disposer (from a prior re-bind that was
      // overwritten via a second registerForgeProvider call on the same
      // id) cannot remove the currently-active impl by mistake — the
      // registry compares identities before deleting.
      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        unregisterForgeProviderImpl(pluginId, contributionId, impl)
      );
      // Disposer captured and registered into the unload cascade
      // synchronously above; only the return value is async.
      return Promise.resolve(dispose);
    },
    registerFileDecorationProvider: (descriptor, impl) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerFileDecorationProvider called after activate() returned or timed out`
        );
      }
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error(
          `Plugin "${pluginId}" registerFileDecorationProvider: descriptor must be an object`
        );
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" registerFileDecorationProvider: descriptor.id must be a non-empty string`
        );
      }
      if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
        throw new Error(
          `Plugin "${pluginId}" registerFileDecorationProvider: impl must expose provideDecorations()`
        );
      }
      // Reject ids not declared in `contributes.fileDecorationProviders` for
      // the same reason as forge providers: an undeclared id is unreachable
      // through the eager scope-routing table, so the binding would be a
      // silent orphan. Fail loud at registration instead.
      const contributionId = descriptor.id;
      const plugin = deps.plugins.get(pluginId);
      const declared = plugin?.manifest.contributes.fileDecorationProviders.some(
        (c) => c.id === contributionId
      );
      if (!declared) {
        throw new Error(
          `Plugin "${pluginId}" registerFileDecorationProvider: descriptor.id "${contributionId}" is not declared in contributes.fileDecorationProviders`
        );
      }

      registerFileDecorationProviderImpl(pluginId, contributionId, impl);

      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        unregisterFileDecorationProviderImpl(pluginId, contributionId, impl)
      );
      return Promise.resolve(dispose);
    },
    registerWorktreeDeleteNotesProvider: (descriptor, impl) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerWorktreeDeleteNotesProvider called after activate() returned or timed out`
        );
      }
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error(
          `Plugin "${pluginId}" registerWorktreeDeleteNotesProvider: descriptor must be an object`
        );
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" registerWorktreeDeleteNotesProvider: descriptor.id must be a non-empty string`
        );
      }
      if (!impl || typeof impl !== "object" || typeof impl.provideNotes !== "function") {
        throw new Error(
          `Plugin "${pluginId}" registerWorktreeDeleteNotesProvider: impl must expose provideNotes()`
        );
      }
      // The manifest is how the host knows to ask (and activate) this plugin
      // when a delete is confirmed, so a check it doesn't declare could never
      // be reached. Refuse it rather than hold an orphan.
      const contributionId = descriptor.id;
      const declared = deps.plugins
        .get(pluginId)
        ?.manifest.contributes.worktreeDeleteNotes?.some((c) => c.id === contributionId);
      if (!declared) {
        throw new Error(
          `Plugin "${pluginId}" registerWorktreeDeleteNotesProvider: descriptor.id "${contributionId}" is not declared in contributes.worktreeDeleteNotes`
        );
      }
      // The second argument is the host's deadline. Only a worker plugin's
      // bridge proxy reads it, to release its pending invoke; the public impl
      // takes the worktree alone.
      const provideNotes = impl.provideNotes as WorktreeDeleteNotesBinding["provideNotes"];
      const binding: WorktreeDeleteNotesBinding = {
        contributionId,
        provideNotes: (worktree, signal) => provideNotes.call(impl, worktree, signal),
      };
      registerWorktreeDeleteNotesBinding(pluginId, binding);
      // Not tracked with the plugin's event subscriptions: those hold a worker
      // against idle disposal, and the check exists so the plugin need not stay
      // loaded. Unload and worker teardown clear the binding instead.
      return Promise.resolve(() => unregisterWorktreeDeleteNotesBinding(pluginId, binding));
    },
    registerWorktreeSetupStep: (stepId, handler) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerWorktreeSetupStep called after activate() returned or timed out`
        );
      }
      if (typeof stepId !== "string" || stepId.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" registerWorktreeSetupStep: stepId must be a non-empty string`
        );
      }
      if (typeof handler !== "function") {
        throw new Error(
          `Plugin "${pluginId}" registerWorktreeSetupStep: handler must be a function`
        );
      }
      // The label and timeout the user allowed come from the manifest, so a
      // handler for an undeclared step would run something nobody was shown.
      if (!isWorktreeSetupStepDeclared(pluginId, stepId)) {
        throw new Error(
          `Plugin "${pluginId}" registerWorktreeSetupStep: "${stepId}" is not declared in contributes.worktreeSetupSteps`
        );
      }

      // Bound through a wrapper of its own, so this registration's disposer
      // can't unbind a later one that reused the same callback.
      const bound: PluginWorktreeSetupStepHandler = (context) => handler(context);
      registerWorktreeSetupStepHandler(pluginId, stepId, bound);

      const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        unregisterWorktreeSetupStepHandler(pluginId, stepId, bound)
      );
      return Promise.resolve(dispose);
    },
    registerSearchProvider: (id, provider) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerSearchProvider called after activate() returned or timed out`
        );
      }
      if (typeof id !== "string" || id.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" registerSearchProvider: id must be a non-empty string`
        );
      }
      if (typeof provider !== "function") {
        throw new Error(`Plugin "${pluginId}" registerSearchProvider: provider must be a function`);
      }
      // Only a declared runtime provider: the keyword, title and scope come from
      // the manifest, so an undeclared binding could never be asked.
      const declared = deps.plugins
        .get(pluginId)
        ?.manifest.contributes.searchProviders?.some(
          (entry) => entry.id === id && entry.kind === "runtime"
        );
      if (!declared) {
        throw new Error(
          `Plugin "${pluginId}" registerSearchProvider: "${id}" is not a kind: "runtime" entry of contributes.searchProviders`
        );
      }
      const unbind = bindSearchProviderImpl(`${pluginId}.${id}`, provider);
      return Promise.resolve(trackPluginDisposer(deps.pluginEventCleanups, pluginId, unbind));
    },
    // Async so every refusal arrives as a rejection, the way a worker plugin's
    // proxied call reports it; the binding itself still happens synchronously.
    registerContextProvider: async (descriptor, impl) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerContextProvider called after activate() returned or timed out`
        );
      }
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error(
          `Plugin "${pluginId}" registerContextProvider: descriptor must be an object`
        );
      }
      const providerId = descriptor.id;
      if (typeof providerId !== "string" || providerId.length === 0) {
        throw new Error(
          `Plugin "${pluginId}" registerContextProvider: descriptor.id must be a non-empty string`
        );
      }
      if (
        !impl ||
        typeof impl !== "object" ||
        typeof impl.search !== "function" ||
        typeof impl.resolve !== "function"
      ) {
        throw new Error(
          `Plugin "${pluginId}" registerContextProvider: impl must expose search() and resolve()`
        );
      }
      // The prefix a provider answers for comes from the manifest, so an
      // undeclared id could never be asked anything.
      const declared = (
        deps.plugins.get(pluginId)?.manifest.contributes.contextProviders ?? []
      ).some((c) => c.id === providerId);
      if (!declared) {
        throw new Error(
          `Plugin "${pluginId}" registerContextProvider: descriptor.id "${providerId}" is not declared in contributes.contextProviders`
        );
      }

      registerContextProviderImpl(pluginId, providerId, impl);
      return trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
        unregisterContextProviderImpl(pluginId, providerId, impl)
      );
    },
    // Async so every refusal arrives as a rejection, as it does from a worker;
    // the binding itself happens synchronously. A worker's handlers arrive
    // here as proxies, so both paths are held to the same declaration.
    registerService: (async (name: unknown, handlers: unknown) => {
      if (revoked) {
        throw new Error(
          `Plugin "${pluginId}" host revoked: registerService called after activate() returned or timed out`
        );
      }
      // This host's own load: an activation that outlived an unload or reload
      // must not bind its handlers for the instance loaded since.
      const plugin = boundPlugin;
      if (!plugin || !isBound()) {
        throw new Error(`Plugin "${pluginId}" registerService: the plugin is no longer loaded`);
      }
      const provided =
        typeof name === "string"
          ? plugin.manifest.contributes.services?.provides.find((p) => p.name === name)
          : undefined;
      if (!provided) {
        throw new Error(
          `Plugin "${pluginId}" registerService: "${String(name)}" is not declared in contributes.services.provides`
        );
      }
      const methods = serviceMethodTable(pluginId, provided, handlers);
      const unbind = deps.services.bind(pluginId, plugin, provided.name, (method, args, ctx) => {
        const fn = methods.get(method);
        if (!fn) throw new Error(`"${provided.name}" has no method "${method}"`);
        return fn.call(handlers, args, ctx);
      });
      return trackPluginDisposer(deps.pluginEventCleanups, pluginId, unbind);
    }) as PluginHostApi["registerService"],
    mcp: {
      registerTools: (endpointId, tools) => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: mcp.registerTools called after activate() returned or timed out`
          );
        }
        if (!deps.declaredCapabilities(pluginId).has("mcp:expose")) {
          throw new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" mcp.registerTools requires "mcp:expose", which is not declared in manifest.capabilities`
          );
        }
        if (typeof endpointId !== "string" || endpointId.length === 0) {
          throw new Error(
            `Plugin "${pluginId}" mcp.registerTools: endpointId must be a non-empty string`
          );
        }
        // Same reason as forge and decoration providers: per-project enablement,
        // grants and the route are all driven by the manifest's declarations, so
        // a roster for an undeclared endpoint could never be reached — reject it
        // rather than hold an orphan.
        const contributes = deps.plugins.get(pluginId)?.manifest.contributes;
        const declared = contributes?.agentMcp?.find((endpoint) => endpoint.id === endpointId);
        if (!declared) {
          throw new Error(
            `Plugin "${pluginId}" mcp.registerTools: endpoint "${endpointId}" is not declared in contributes.agentMcp`
          );
        }
        // The host serves a bridged endpoint's roster from the contributed
        // server the manifest names; plugin code must not replace it.
        if (declared.source) {
          throw new Error(
            `Plugin "${pluginId}" mcp.registerTools: endpoint "${endpointId}" serves tools from contributes.mcpServers "${declared.source.mcpServer}", so the host registers its roster`
          );
        }
        // The host serves the manifest's declared queries on the same MCP
        // server, so they take names and budget from the roster. Checked here,
        // where the manifest is, for worker and in-process plugins alike.
        const declaredQueryNames = new Set(
          (contributes?.databases ?? []).flatMap((database) =>
            (database.queries ?? []).map((query) => query.name)
          )
        );
        let descriptors: ReturnType<typeof validateAgentMcpTools>;
        try {
          descriptors = validateAgentMcpTools(tools, {
            declaredQueryNames,
            groups: (declared.groups ?? []).map((group) => ({
              id: group.id,
              access: group.access,
            })),
          });
        } catch (err) {
          throw new Error(
            `Plugin "${pluginId}" mcp.registerTools("${endpointId}"): ${formatErrorMessage(err, "invalid tool roster")}`,
            { cause: err }
          );
        }
        // Capture each definition and its `execute` now. The registry advertises
        // the validated snapshot, so dispatch must run exactly those tools too —
        // not whatever the plugin's roster object holds by the time a call lands.
        const roster = tools as Record<string, PluginMcpToolDefinition>;
        const executors = new Map<
          string,
          { definition: PluginMcpToolDefinition; execute: PluginMcpToolDefinition["execute"] }
        >();
        for (const { name } of descriptors) {
          const definition = roster[name];
          executors.set(name, { definition, execute: definition.execute });
        }
        const invoke: AgentMcpToolInvoker = (toolName, args, caller, signal) => {
          // A route that looked the roster up before an unload landed may still
          // call through it; the instance it belonged to is gone, so refuse.
          if (!isBound()) {
            return Promise.reject(new Error(`Plugin "${pluginId}" is not loaded`));
          }
          const entry = executors.get(toolName);
          if (!entry) {
            return Promise.reject(
              new Error(`Plugin "${pluginId}" endpoint "${endpointId}" has no tool "${toolName}"`)
            );
          }
          return runAgentMcpTool(entry.definition, entry.execute, args, caller, signal);
        };
        const unregister = agentMcpEndpointRegistry.register({
          pluginInstanceId: pluginId,
          endpointId,
          tools: descriptors,
          invoke,
        });
        const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () => {
          unregister();
          if (mcpRosterDisposers.get(endpointId) === dispose) mcpRosterDisposers.delete(endpointId);
        });
        // Released after the replacement is bound. The registry's disposer is
        // identity-guarded, so this drops the old roster's tracking and closures
        // without the endpoint ever going empty in between.
        const prior = mcpRosterDisposers.get(endpointId);
        mcpRosterDisposers.set(endpointId, dispose);
        prior?.();
        return Promise.resolve(dispose);
      },
    },
    // NOT revoke-guarded: called from the plugin's own post-activation
    // subscription callbacks (worktree changes, polling timers). The
    // liveness guard is plugin membership, not the activation window — once
    // the plugin unloads this becomes a silent no-op.
    invalidateFileDecorations: (scope, paths) => {
      if (!deps.plugins.has(pluginId)) return Promise.resolve();
      if (typeof scope !== "string" || scope.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope must be a non-empty string`
          )
        );
      }
      // A plugin may only invalidate scopes it actually declared in
      // `contributes.fileDecorationProviders`. Without this a plugin could
      // force unrelated renderer views to re-pull. Mirrors the
      // registration-time declared-id guard so the manifest stays the
      // single source of truth for what a plugin owns.
      const declaredScopes = deps.plugins
        .get(pluginId)
        ?.manifest.contributes.fileDecorationProviders.flatMap((c) => c.scopes);
      if (
        !declaredScopes ||
        !declaredScopes.some((pattern) => scopeMatchesPattern(scope, pattern))
      ) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" invalidateFileDecorations: scope "${scope}" is not covered by any declared contributes.fileDecorationProviders[].scopes`
          )
        );
      }
      let narrowed =
        Array.isArray(paths) && paths.length > 0
          ? paths.filter((p): p is string => typeof p === "string" && p.length > 0)
          : undefined;
      if (narrowed && narrowed.length > MAX_FILE_DECORATION_PATHS) {
        // Over the cap, fall back to a scope-wide invalidation (drop `paths`)
        // rather than truncating: a truncated list would silently omit the
        // tail, and the renderer skips a re-pull for any visible file not in
        // the list — leaving stale decorations with no error surfaced. A
        // path-less broadcast forces an unconditional re-pull, which is
        // correct (just broader) for this pathological case.
        console.warn(
          `Plugin "${pluginId}" invalidateFileDecorations: ${narrowed.length} paths exceeds cap of ${MAX_FILE_DECORATION_PATHS} for scope "${scope}"; falling back to scope-wide invalidation`
        );
        narrowed = undefined;
      }
      pushToRenderers(CHANNELS.EVENTS_PUSH, {
        name: "plugin:decorations-changed",
        payload: { scope, ...(narrowed && narrowed.length > 0 ? { paths: narrowed } : {}) },
      });
      return Promise.resolve();
    },
    // NOT revoke-guarded for the same reason as invalidateFileDecorations:
    // plugins set badges from post-activation worktree/agent subscription
    // callbacks. Liveness is plugin membership, so it no-ops once unloaded
    // (unloadPlugin clears the plugin's whole badge set).
    setPanelBadge: (panelId, badge) => {
      if (!deps.plugins.has(pluginId)) return Promise.resolve();
      if (typeof panelId !== "string" || panelId.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelBadge: panelId must be a non-empty string`)
        );
      }
      let validated: PluginPanelBadge | null = null;
      if (badge !== null && badge !== undefined) {
        const parsed = PluginPanelBadgeSchema.safeParse(badge);
        if (!parsed.success) {
          // Reject (not sync throw): runtime-surface Promise method (#10617).
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelBadge: invalid badge — ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`
            )
          );
        }
        validated = parsed.data;
      }
      let panelMap = deps.pluginBadges.get(pluginId);
      const previous = panelMap?.get(panelId);
      if (validated === null) {
        // Clear: drop just this panel's badge; prune the plugin's map when empty.
        if (!panelMap || previous === undefined) return Promise.resolve();
        panelMap.delete(panelId);
        if (panelMap.size === 0) deps.pluginBadges.delete(pluginId);
      } else {
        // A badge set again from a timer or a subscription would otherwise send
        // the plugin's whole map to every renderer for no change.
        if (previous !== undefined && samePanelBadge(previous, validated)) {
          return Promise.resolve();
        }
        if (previous === undefined && (panelMap?.size ?? 0) >= PLUGIN_PANEL_BADGES_MAX_PANELS) {
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelBadge: badges are already set on ${PLUGIN_PANEL_BADGES_MAX_PANELS} panels — clear a closed panel's with null`
            )
          );
        }
        if (!panelMap) {
          panelMap = new Map<string, PluginPanelBadge>();
          deps.pluginBadges.set(pluginId, panelMap);
        }
        panelMap.set(panelId, validated);
      }
      // Coalesced: a fleet badged one panel at a time sends the final map once,
      // not one complete map per panel (#14128).
      getPluginStatePublisher().publish(PLUGIN_STATE_PANEL_BADGES, pluginId, () => {
        if (!deps.plugins.has(pluginId)) return;
        sendToScope(CHANNELS.EVENTS_PUSH, {
          name: "plugin:panel-badges-changed",
          payload: { pluginId, badges: deps.serializePluginBadges(pluginId) },
        });
      });
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setPanelBadge: work is reported from callbacks
    // long after activate(). Unlike a badge, a report only ever lands on this
    // plugin's own panels of a kind declaring `reportsActivity`, settled
    // against main's kind registry rather than anything the caller says
    // (#13820). An id no renderer has reported yet is held, since
    // `panel.openPluginPanel` hands one back before the view reports it, and
    // the renderer draws it only once the panel is this plugin's.
    setPanelActivity: (panelId, activity) => {
      // Identity, not id membership: a callback left over from before a same-id
      // reload must not report on its successor's panels.
      if (!isBound() || !boundPlugin) return Promise.resolve();
      let entry: ReturnType<typeof validatePluginPanelActivity>;
      try {
        entry = validatePluginPanelActivity(panelId, activity);
      } catch (err) {
        // A hostile activity object can make the validator throw; this method
        // must still reject (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelActivity: activity could not be read`, {
            cause: err,
          })
        );
      }
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(new Error(`Plugin "${pluginId}" setPanelActivity: ${entry.error}`));
      }
      const target = entry.panelId;
      let panelMap = deps.pluginPanelActivity.get(pluginId);
      const previous = panelMap?.get(target);
      // Coalesced like a badge; the flush still delivers this plugin's earlier
      // panel pushes first.
      const publish = (): void => {
        getPluginStatePublisher().publish(PLUGIN_STATE_PANEL_ACTIVITY, pluginId, () =>
          deps.emitPanelActivity(pluginId)
        );
      };
      const drop = (): void => {
        if (!panelMap || previous === undefined) return;
        panelMap.delete(target);
        if (panelMap.size === 0) deps.pluginPanelActivity.delete(pluginId);
        publish();
      };
      // A clear only ever touches this plugin's own report, so it needs no
      // ownership answer and survives the kind dropping its declaration.
      if (entry.activity === null) {
        drop();
        return Promise.resolve();
      }
      if (
        !boundPlugin.manifest.contributes.panels.some((panel) => panel.reportsActivity === true)
      ) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setPanelActivity: none of this plugin's contributes.panels declares reportsActivity: true`
          )
        );
      }
      const ownership = deps.panelLifecycleBroker.ownership(target, pluginId);
      switch (ownership.kind) {
        case "foreign":
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelActivity: panel "${target}" belongs to another plugin`
            )
          );
        case "non-plugin":
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelActivity: panel "${target}" is not a plugin panel`
            )
          );
        case "unavailable":
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelActivity: whose panel "${target}" is cannot be settled right now`
            )
          );
        case "owned":
          if (getPanelKindConfig(ownership.panelKindId)?.reportsActivity !== true) {
            return Promise.reject(
              new Error(
                `Plugin "${pluginId}" setPanelActivity: panel kind "${ownership.panelKindId}" does not declare reportsActivity: true`
              )
            );
          }
          break;
        case "missing":
          // Closed for good: nothing will draw it, so holding it would only
          // spend a slot under the cap.
          if (deps.panelLifecycleBroker.pushTargetsFor(target, pluginId) === "closed") {
            drop();
            return Promise.resolve();
          }
          break;
      }
      // Reported again from a timer or a subscription, the same state would
      // otherwise send the plugin's whole map to every view for no change.
      if (samePanelActivity(previous, entry.activity)) return Promise.resolve();
      if (previous === undefined && (panelMap?.size ?? 0) >= PLUGIN_PANEL_ACTIVITY_MAX_PANELS) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setPanelActivity: activity is already reported on ${PLUGIN_PANEL_ACTIVITY_MAX_PANELS} panels — clear a closed panel's with null`
          )
        );
      }
      if (!panelMap) {
        panelMap = new Map();
        deps.pluginPanelActivity.set(pluginId, panelMap);
      }
      panelMap.set(target, { ...entry.activity, revision: deps.nextPanelActivityRevision() });
      publish();
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setPanelBadge: a count is set from the same
    // post-activation subscriptions. The id must be one this plugin's manifest
    // contributed, so a plugin can never light another plugin's button.
    setToolbarButtonBadge: (buttonId, badge) => {
      // Identity, not id membership: a callback left over from before a same-id
      // reload must not set or clear its successor's badges.
      if (!isBound() || !boundPlugin) return Promise.resolve();
      if (typeof buttonId !== "string" || buttonId.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setToolbarButtonBadge: buttonId must be a non-empty string`
          )
        );
      }
      if (!boundPlugin.manifest.contributes.toolbarButtons.some((btn) => btn.id === buttonId)) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setToolbarButtonBadge: "${buttonId}" is not one of this plugin's contributes.toolbarButtons`
          )
        );
      }
      let validated: PluginPanelBadge | null = null;
      if (badge !== null && badge !== undefined) {
        const parsed = PluginPanelBadgeSchema.safeParse(badge);
        if (!parsed.success) {
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setToolbarButtonBadge: invalid badge — ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`
            )
          );
        }
        validated = parsed.data;
      }
      let buttonMap = deps.pluginToolbarBadges.get(pluginId);
      if (validated === null) {
        if (!buttonMap || !buttonMap.has(buttonId)) return Promise.resolve();
        buttonMap.delete(buttonId);
        if (buttonMap.size === 0) deps.pluginToolbarBadges.delete(pluginId);
      } else {
        if (!buttonMap) {
          buttonMap = new Map<string, PluginPanelBadge>();
          deps.pluginToolbarBadges.set(pluginId, buttonMap);
        }
        buttonMap.set(buttonId, validated);
      }
      // Deliver this plugin's queued pushes first, as every direct send does.
      flushPluginPushes();
      deps.emitToolbarBadges(pluginId);
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setToolbarButtonBadge, and owned the same way:
    // the id must be one this plugin's manifest contributed (#13785).
    setToolbarButtonState: (buttonId, state) => {
      if (!isBound() || !boundPlugin) return Promise.resolve();
      if (typeof buttonId !== "string" || buttonId.length === 0) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setToolbarButtonState: buttonId must be a non-empty string`
          )
        );
      }
      if (!boundPlugin.manifest.contributes.toolbarButtons.some((btn) => btn.id === buttonId)) {
        return Promise.reject(
          new Error(
            `Plugin "${pluginId}" setToolbarButtonState: "${buttonId}" is not one of this plugin's contributes.toolbarButtons`
          )
        );
      }
      let validated: PluginToolbarButtonRuntimeState | null = null;
      if (state !== null && state !== undefined) {
        let parsed: ReturnType<typeof PluginToolbarButtonRuntimeStateSchema.safeParse>;
        try {
          parsed = PluginToolbarButtonRuntimeStateSchema.safeParse(state);
        } catch (err) {
          // A throwing getter escapes safeParse; it still has to reject.
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setToolbarButtonState: invalid state — ${formatErrorMessage(err, "unreadable")}`
            )
          );
        }
        if (!parsed.success) {
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setToolbarButtonState: invalid state — ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`
            )
          );
        }
        validated = parsed.data;
        // A `./icon.svg` reference names one of this plugin's own files; the
        // renderer knows it by the runtime key the manifest's icons load under.
        if (isPluginCustomIconRef(validated.iconId)) {
          validated = { ...validated, iconId: makePluginCustomIconKey(pluginId, validated.iconId) };
        }
        if (validated.menu !== undefined) {
          const button = boundPlugin.manifest.contributes.toolbarButtons.find(
            (btn) => btn.id === buttonId
          );
          if (button?.popover !== undefined) {
            return Promise.reject(
              new Error(
                `Plugin "${pluginId}" setToolbarButtonState: invalid state — menu: "${buttonId}" opens a popover and can't carry a menu`
              )
            );
          }
          // Own namespace and no repeats, as a panel's runtime menu; the items
          // come back in the instance's namespace, where they dispatch.
          const menu = normalizePanelMenuItems(validated.menu, manifestId, pluginId);
          if (!menu.ok) {
            return Promise.reject(
              new Error(
                `Plugin "${pluginId}" setToolbarButtonState: invalid state — menu: ${menu.error}`
              )
            );
          }
          validated = { ...validated, menu: [...menu.items] };
        }
        // An empty state is the manifest default, the same as a clear.
        if (Object.keys(validated).length === 0) validated = null;
      }
      let buttonMap = deps.pluginToolbarStates.get(pluginId);
      if (validated === null) {
        if (!buttonMap || !buttonMap.has(buttonId)) return Promise.resolve();
        buttonMap.delete(buttonId);
        if (buttonMap.size === 0) deps.pluginToolbarStates.delete(pluginId);
      } else {
        const previous = buttonMap?.get(buttonId);
        if (previous !== undefined && sameToolbarButtonState(previous, validated)) {
          return Promise.resolve();
        }
        if (!buttonMap) {
          buttonMap = new Map<string, PluginToolbarButtonRuntimeState>();
          deps.pluginToolbarStates.set(pluginId, buttonMap);
        }
        buttonMap.set(buttonId, validated);
      }
      flushPluginPushes();
      deps.emitToolbarStates(pluginId);
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setPanelBadge: a key tracks state the plugin
    // learns from post-activation subscriptions (#13506).
    setContext: (key, value) => {
      // Identity, not id membership: a callback left over from before a same-id
      // reload must not set its successor's keys.
      if (!isBound()) return Promise.resolve();
      const entry = validatePluginContextEntry(key, value);
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(new Error(`Plugin "${pluginId}" setContext: ${entry.error}`));
      }
      let keys = deps.pluginContextKeys.get(pluginId);
      if (!keys) {
        if (entry.value === null) return Promise.resolve();
        keys = new Map<string, PluginContextValue>();
        deps.pluginContextKeys.set(pluginId, keys);
      }
      // An emptied map stays until unload: a project instance with no keys
      // still owns its namespace over an installed copy's.
      const applied = applyPluginContextEntry(keys, entry.key, entry.value);
      if (!applied.ok) {
        return Promise.reject(new Error(`Plugin "${pluginId}" setContext: ${applied.error}`));
      }
      if (!applied.changed) return Promise.resolve();
      // Deliver this plugin's queued pushes first, as every direct send does.
      flushPluginPushes();
      deps.emitContextKeys(pluginId);
      return Promise.resolve();
    },
    // NOT revoke-guarded, like setPanelBadge: a status follows state the
    // plugin learns from its own subscriptions (#13704). The worktree must be
    // one this host's own worktree read names, which is what keeps a project
    // plugin on its own project's cards; an unavailable read refuses rather
    // than guessing, and never prunes what is already shown.
    setWorktreeCardStatus: (worktreeId, status) => {
      if (!isBound()) return Promise.resolve();
      const entry = validatePluginWorktreeCardStatus(worktreeId, status, manifestId, pluginId);
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setWorktreeCardStatus: ${entry.error}`)
        );
      }
      // Taken at the call, not when the queued run starts: a call the previous
      // worker generation made must not land after that generation's clear.
      const generation = deps.worktreeCardStatusGeneration(pluginId);
      // Same for the worktree's lifecycle: a call queued behind another must
      // not outlive a removal that happened while it waited.
      const since = { revision: deps.worktreeCardTargetRevision(), at: Date.now() };
      const run = async (): Promise<void> => {
        const result = await getWorktreesResult();
        if (!isBound() || deps.worktreeCardStatusGeneration(pluginId) !== generation) return;
        if (result.status !== "ok") {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeCardStatus: worktrees are unavailable (${result.reason})`
          );
        }
        const target = result.worktrees.find(
          (w) => w.id === entry.worktreeId || w.worktreeId === entry.worktreeId
        );
        if (!target) {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeCardStatus: "${entry.worktreeId}" is not a worktree this plugin can see`
          );
        }
        const projectId = result.projectId;
        // The card is keyed by the snapshot's own id, whichever spelling the
        // plugin passed.
        const cardId = target.id;
        if (deps.isWorktreeCardTargetRetired(projectId, cardId, since)) {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeCardStatus: "${entry.worktreeId}" was removed`
          );
        }
        let byProject = deps.pluginWorktreeCardStatuses.get(pluginId);
        let statuses = byProject?.get(projectId);
        if (entry.status === null) {
          if (!statuses?.delete(cardId)) return;
          if (statuses.size === 0) byProject!.delete(projectId);
          if (byProject!.size === 0) deps.pluginWorktreeCardStatuses.delete(pluginId);
        } else {
          if (sameWorktreeCardStatus(statuses?.get(cardId), entry.status)) return;
          if (!byProject) {
            byProject = new Map();
            deps.pluginWorktreeCardStatuses.set(pluginId, byProject);
          }
          if (!statuses) {
            statuses = new Map();
            byProject.set(projectId, statuses);
          }
          statuses.set(cardId, entry.status);
        }
        // Deliver this plugin's queued pushes first, as every direct send does.
        flushPluginPushes();
        deps.emitWorktreeCardStatuses(pluginId, projectId);
      };
      // Serialized, so a set followed by a clear can never land in the other
      // order because the reads behind them resolved out of order. A rejected
      // call does not poison the ones queued behind it.
      const next = worktreeCardStatusChain.then(run);
      worktreeCardStatusChain = next.catch(() => {});
      return next;
    },
    // Same gates as setWorktreeCardStatus (#13806): the worktree must be one
    // this host's own worktree read names, an unavailable read refuses and
    // never prunes, and a call queued behind another cannot outlive a removal
    // or a clear. Each accepted call replaces the plugin's whole list there.
    setWorktreeReviewChecks: (worktreeId, checks) => {
      if (!isBound()) return Promise.resolve();
      const entry = validatePluginWorktreeReviewChecks(worktreeId, checks, manifestId, pluginId);
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setWorktreeReviewChecks: ${entry.error}`)
        );
      }
      const generation = deps.worktreeReviewChecksGeneration(pluginId);
      const since = { revision: deps.worktreeCardTargetRevision(), at: Date.now() };
      const run = async (): Promise<void> => {
        const result = await getWorktreesResult();
        if (!isBound() || deps.worktreeReviewChecksGeneration(pluginId) !== generation) return;
        if (result.status !== "ok") {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeReviewChecks: worktrees are unavailable (${result.reason})`
          );
        }
        const target = result.worktrees.find(
          (w) => w.id === entry.worktreeId || w.worktreeId === entry.worktreeId
        );
        if (!target) {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeReviewChecks: "${entry.worktreeId}" is not a worktree this plugin can see`
          );
        }
        const projectId = result.projectId;
        const checkId = target.id;
        if (deps.isWorktreeCardTargetRetired(projectId, checkId, since)) {
          throw new Error(
            `Plugin "${pluginId}" setWorktreeReviewChecks: "${entry.worktreeId}" was removed`
          );
        }
        let byProject = deps.pluginWorktreeReviewChecks.get(pluginId);
        let stored = byProject?.get(projectId);
        if (entry.checks === null) {
          if (!stored?.delete(checkId)) return;
          if (stored.size === 0) byProject!.delete(projectId);
          if (byProject!.size === 0) deps.pluginWorktreeReviewChecks.delete(pluginId);
        } else {
          if (sameWorktreeReviewChecks(stored?.get(checkId), entry.checks)) return;
          if (!byProject) {
            byProject = new Map();
            deps.pluginWorktreeReviewChecks.set(pluginId, byProject);
          }
          if (!stored) {
            stored = new Map();
            byProject.set(projectId, stored);
          }
          stored.set(checkId, entry.checks);
        }
        flushPluginPushes();
        deps.emitWorktreeReviewChecks(pluginId, projectId);
      };
      const next = worktreeReviewChecksChain.then(run);
      worktreeReviewChecksChain = next.catch(() => {});
      return next;
    },
    // NOT revoke-guarded, like setWorktreeCardStatus. The terminal must be one
    // this host's own agents.list names (so it needs `agent:read`, and a project
    // plugin stays on its own project's panes); an unreadable list refuses and
    // never prunes what is already shown (#13802).
    setTerminalStatus: (terminalId, status) => {
      if (!isBound()) return Promise.resolve();
      if (!deps.declaredCapabilities(pluginId).has("agent:read")) {
        return Promise.reject(
          new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" setTerminalStatus requires "agent:read", which is not declared in manifest.capabilities`
          )
        );
      }
      let entry: ReturnType<typeof validatePluginTerminalStatus>;
      try {
        entry = validatePluginTerminalStatus(terminalId, status, manifestId, pluginId);
      } catch (err) {
        // A hostile status object can make the validator throw; this method
        // must still reject (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setTerminalStatus: status could not be read`, {
            cause: err,
          })
        );
      }
      if (!entry.ok) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(new Error(`Plugin "${pluginId}" setTerminalStatus: ${entry.error}`));
      }
      const generation = deps.terminalStatusGeneration(pluginId);
      const closeRevision = deps.terminalStatusCloseRevision();
      const run = async (): Promise<void> => {
        let read: Awaited<ReturnType<typeof dispatcher.sendAgentsListWithProject>>;
        try {
          read = await dispatcher.sendAgentsListWithProject(boundProjectId, pluginId);
        } catch (err) {
          if (isProjectViewUnavailable(err)) {
            throw new Error(
              `Plugin "${pluginId}" setTerminalStatus: terminals are unavailable (project view not open)`,
              { cause: err }
            );
          }
          throw err;
        }
        if (!isBound() || deps.terminalStatusGeneration(pluginId) !== generation) return;
        const projectId = read.projectId;
        if (projectId === null) {
          throw new Error(`Plugin "${pluginId}" setTerminalStatus: terminals are unavailable`);
        }
        const pane = read.agents.find((a) => a.terminalId === entry.terminalId);
        if (!pane) {
          throw new Error(
            `Plugin "${pluginId}" setTerminalStatus: "${entry.terminalId}" is not a terminal this plugin can see`
          );
        }
        if (deps.isTerminalStatusProjectClosed(projectId, closeRevision)) {
          throw new Error(`Plugin "${pluginId}" setTerminalStatus: the project was closed`);
        }
        let byProject = deps.pluginTerminalStatuses.get(pluginId);
        let statuses = byProject?.get(projectId);
        let changed = false;
        const publish = (): void => {
          flushPluginPushes();
          deps.emitTerminalStatuses(pluginId, projectId);
        };
        if (entry.status === null) {
          if (!statuses?.delete(entry.terminalId)) return;
          if (statuses.size === 0) byProject!.delete(projectId);
          if (byProject!.size === 0) deps.pluginTerminalStatuses.delete(pluginId);
        } else {
          if (sameTerminalStatus(statuses?.get(entry.terminalId), entry.status)) return;
          if (
            statuses &&
            !statuses.has(entry.terminalId) &&
            statuses.size >= PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT
          ) {
            // At the cap, free the slots of terminals that have left the list
            // (closed, exited). Only here: a list is a projection that can omit
            // a live pane, so pruning on every call could drop a shown chip.
            const live = new Set(read.agents.map((a) => a.terminalId));
            for (const held of [...statuses.keys()]) {
              if (live.has(held)) continue;
              statuses.delete(held);
              changed = true;
            }
          }
          if (
            statuses &&
            !statuses.has(entry.terminalId) &&
            statuses.size >= PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT
          ) {
            if (changed) publish();
            throw new Error(
              `Plugin "${pluginId}" setTerminalStatus: at most ${PLUGIN_TERMINAL_STATUS_MAX_PER_PROJECT} terminals can hold a status at once`
            );
          }
          if (!byProject) {
            byProject = new Map();
            deps.pluginTerminalStatuses.set(pluginId, byProject);
          }
          if (!statuses) {
            statuses = new Map();
            byProject.set(projectId, statuses);
          }
          statuses.set(entry.terminalId, entry.status);
        }
        publish();
      };
      // Serialized, so a set followed by a clear lands in call order.
      const next = terminalStatusChain.then(run);
      terminalStatusChain = next.catch(() => {});
      return next;
    },
    // NOT revoke-guarded, like setPanelBadge: a plugin republishes its menu
    // from lifecycle callbacks and its own state changes (#13213). Ownership is
    // not checked against the panel here — `panel.openPluginPanel` hands back an
    // id before the renderer has reported it — so the renderer shows a list
    // only on a panel whose kind this plugin contributed.
    setPanelMenuItems: (panelId, items) => {
      if (!deps.plugins.has(pluginId)) return Promise.resolve();
      if (typeof panelId !== "string" || panelId.length === 0) {
        // Reject (not sync throw): runtime-surface Promise method (#10617).
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelMenuItems: panelId must be a non-empty string`)
        );
      }
      const result = normalizePanelMenuItems(items, manifestId, pluginId);
      if (!result.ok) {
        return Promise.reject(
          new Error(`Plugin "${pluginId}" setPanelMenuItems: invalid items — ${result.error}`)
        );
      }
      let panelMap = deps.pluginPanelMenus.get(pluginId);
      const previous = panelMap?.get(panelId);
      if (result.items.length === 0) {
        if (!panelMap || previous === undefined) return Promise.resolve();
        panelMap.delete(panelId);
        if (panelMap.size === 0) deps.pluginPanelMenus.delete(pluginId);
      } else {
        if (previous !== undefined && samePanelMenuItems(previous, result.items)) {
          return Promise.resolve();
        }
        if (previous === undefined && (panelMap?.size ?? 0) >= PLUGIN_PANEL_MENUS_MAX_PANELS) {
          return Promise.reject(
            new Error(
              `Plugin "${pluginId}" setPanelMenuItems: menus are already published on ${PLUGIN_PANEL_MENUS_MAX_PANELS} panels — clear a closed panel's with null`
            )
          );
        }
        if (!panelMap) {
          panelMap = new Map();
          deps.pluginPanelMenus.set(pluginId, panelMap);
        }
        panelMap.set(panelId, result.items);
      }
      pushToRenderers(CHANNELS.EVENTS_PUSH, {
        name: "plugin:panel-menus-changed",
        payload: { pluginId, menus: deps.serializePluginPanelMenus(pluginId) },
      });
      return Promise.resolve();
    },
    // NOT revoke-guarded: a worker reloads a view when its own work finishes,
    // long after activate() returned. No capability gate — the target must be
    // a panel of a kind this exact instance contributed, which the broker
    // resolves from main's kind registry; the caller is identified by this
    // closure's `pluginId`, never by an argument (#12610).
    reloadPanel: async (panelId) => {
      if (typeof panelId !== "string" || panelId.trim().length === 0) {
        throw new Error(`Plugin "${pluginId}" reloadPanel: panelId must be a non-empty string`);
      }
      if (!isBound()) return "unavailable";
      return panelReloadDispatcher.reload(pluginId, panelId, boundProjectId);
    },
    // NOT revoke-guarded: a plugin reaches for this long after activate(),
    // when its host calls have started timing out. No capability gate — it
    // restarts only the caller's own worker, identified by this closure's
    // binding, the same restart the user's "Restart plugin" button runs.
    restartWorker: async () => {
      if (!isBound()) return "unavailable";
      return deps.requestWorkerSelfRestart(pluginId, boundPlugin!);
    },
    // NOT revoke-guarded for the same reason as invalidateFileDecorations:
    // plugins fire toasts from post-activation callbacks and timers. Liveness
    // is plugin membership, so it no-ops silently once the plugin unloads.
    showToast: async (options) => {
      if (!deps.plugins.has(pluginId)) return;
      const parsed = PluginToastOptionsSchema.safeParse(options);
      if (!parsed.success) {
        throw new Error(
          `Plugin "${pluginId}" showToast: invalid options — ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`
        );
      }
      // Provenance: prefix the message with the plugin's name so users can see
      // which plugin raised the toast. Resolved host-side from the pluginId
      // bound to this closure at activation, so it still cannot be spoofed —
      // but it prints the manifest's display name rather than the raw id,
      // which for a project-owned plugin is an instance key no user should be
      // shown (#12211).
      //
      // rateLimitKey keeps the raw id, since two plugins may legitimately
      // share a display name; the display name rides beside it as the label
      // an overflow summary prints. It gives the plugin one renderer bucket
      // shared with `notify`, whatever the tone — without it plugin toasts
      // fall into the global type-keyed bucket and a burst of unrelated system
      // toasts could silently suppress a plugin's toast. Past main's own
      // budget the toast is dropped quietly, here and for a remote window alike.
      // A plugin the user silenced, or a project the user muted, is held back
      // before that budget, so it costs the plugin nothing (#13818).
      return inNotificationOrder(async () => {
        if (!isBound()) return;
        if (await deps.pluginNotificationsBlocked(pluginId, boundProjectId)) return;
        if (!isBound()) return;
        if (!admitPluginToast(pluginId)) return;
        const displayName = deps.pluginDisplayName(pluginId);
        const message = `${displayName}: ${parsed.data.message}`;
        pushToRenderers(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: parsed.data.type,
          message,
          duration: parsed.data.durationMs,
          rateLimitKey: `plugin:${pluginId}`,
          rateLimitLabel: displayName,
          context: pluginNotificationContext(displayName, boundProjectId),
        });
        // A toast is the Shell's to show, so a push never reaches a window on
        // another machine; the one driving the project is asked to show it.
        const frontend = resolvePluginFrontend(boundProjectId, pluginId);
        if (frontend.kind === "remote") {
          frontend.endpoint
            .request(
              PluginFrontendMethod.TOAST,
              {
                pluginId,
                type: parsed.data.type,
                message,
                pluginDisplayName: displayName,
                ...(parsed.data.durationMs !== undefined
                  ? { durationMs: parsed.data.durationMs }
                  : {}),
              },
              { timeoutMs: 10_000 }
            )
            .catch(() => {
              // Best-effort, like the local push: a Shell that went has no screen.
            });
        }
      });
    },
    // NOT revoke-guarded, like showToast (#13505). Each action is held to the
    // caller's own namespace here, where the caller is known, and rewritten to
    // its instance's, the same rule as setPanelMenuItems: a button can only run
    // what the plugin could already put in its own panel menu.
    notify: async (options) => {
      const id = randomUUID();
      if (!deps.plugins.has(pluginId)) return { id };
      const parsed = PluginNotifyOptionsSchema.safeParse(options);
      if (!parsed.success) {
        throw new Error(
          `Plugin "${pluginId}" notify: invalid options — ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`
        );
      }
      const { title, body, os, dedupeKey } = parsed.data;
      const severity = parsed.data.severity ?? "info";
      const passive = parsed.data.delivery === "passive";
      const actions = (parsed.data.actions ?? []).map((action, index) => ({
        label: action.label,
        actionId: resolveOwnActionId("notify", `actions.${index}.actionId`, action.actionId),
        ...(action.args !== undefined ? { args: action.args } : {}),
      }));
      if (os && !deps.declaredCapabilities(pluginId).has("notification:os")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" notify with os: true requires "notification:os", which is not declared in manifest.capabilities`
        );
      }

      // Delivered in the order the plugin raised them: the lookups below take
      // different times per call, and a later notification with the same
      // `dedupeKey` must never land first and be replaced by an older one.
      return inNotificationOrder(async () => {
        if (!isBound()) return { id };
        const target = await resolveNotifyTarget(parsed.data.target);
        if (!isBound()) return { id };
        // A bound plugin's notifications are its project's. An app-wide plugin's
        // belong to a project only when it points at one of that project's
        // worktrees, and then that project's mute covers it too.
        const projectId = boundProjectId ?? target?.projectId ?? null;

        // Silenced or muted, then the same budget as showToast. A call held back
        // by either does nothing at all — no toast, no banner, no retired
        // banner — as if it was never made.
        if (await deps.pluginNotificationsBlocked(pluginId, projectId)) return { id };
        if (!isBound()) return { id };
        if (!admitPluginToast(pluginId)) return { id };
        const displayName = deps.pluginDisplayName(pluginId);
        const displayTitle = `${displayName}: ${title}`;
        const replaceKey = dedupeKey !== undefined ? `plugin:${pluginId}:${dedupeKey}` : undefined;
        pushToRenderers(CHANNELS.NOTIFICATION_SHOW_TOAST, {
          type: severity,
          title: displayTitle,
          message: body,
          rateLimitKey: `plugin:${pluginId}`,
          rateLimitLabel: displayName,
          // Passive is the app's inbox-only route: no toast, and no OS banner
          // either, which the schema already refused alongside `os`.
          ...(passive ? { priority: "low" as const } : {}),
          ...(actions.length > 0 ? { pluginActions: actions } : {}),
          ...(replaceKey !== undefined ? { replaceKey } : {}),
          context: pluginNotificationContext(displayName, projectId, target?.address),
        });
        // The switch is the whole grant: no first-use prompt, no builtin bypass.
        // A notification that doesn't page still retires the banner it replaces.
        // The pager is loaded only here, since it pulls in the notification and
        // window services that nothing else in the host needs.
        const frontend = resolvePluginFrontend(boundProjectId, pluginId);
        const pages =
          os === true && frontend.kind !== "remote" && hasOsNotificationsGrant(pluginId);
        if (
          pages ||
          (replaceKey !== undefined && deps.declaredCapabilities(pluginId).has("notification:os"))
        ) {
          const pager = await import("./pluginNotificationPager.js");
          if (!isBound()) return { id };
          if (pages) {
            // The project the notification is about, so the banner's focus check
            // and its click land where the inbox row files it.
            pager.pagePluginNotification({
              pluginId,
              projectId,
              title: displayTitle,
              body,
              ...(replaceKey !== undefined ? { replaceKey } : {}),
              ...(actions[0]
                ? { firstAction: { actionId: actions[0].actionId, args: actions[0].args } }
                : {}),
            });
          } else if (replaceKey !== undefined) {
            pager.retirePluginNotification(replaceKey);
          }
        }
        // A Shell driving the project gets the plain toast. The banner belongs
        // on that Shell's screen, which this machine can't page, so it is
        // dropped rather than shown here to nobody. The reverse toast carries no
        // replacement key, so a Shell's toasts for one key stack.
        if (frontend.kind === "remote") {
          frontend.endpoint
            .request(
              PluginFrontendMethod.TOAST,
              {
                pluginId,
                type: severity,
                message: `${displayTitle} — ${body}`,
                pluginDisplayName: displayName,
                ...(passive ? { passive: true } : {}),
              },
              { timeoutMs: 10_000 }
            )
            .catch(() => {
              // Best-effort, like the local push.
            });
        }
        return { id };
      });
    },
    // NOT revoke-guarded for the same reason as invalidateFileDecorations and
    // showToast: plugins dispatch actions from post-activation callbacks and
    // timers. Liveness is plugin membership — once the plugin unloads this
    // returns PLUGIN_UNLOADED without attempting a round-trip. Args are
    // validated by ActionService against the action's argsSchema, and
    // danger:"restricted"/"confirm" are rejected there with the "plugin"
    // source, so the host does not re-check them. The one exception runs in
    // main and validates there: see closeWithNoView.
    dispatch: async (actionId, args, options) => {
      if (!deps.plugins.has(pluginId)) {
        return {
          ok: false,
          error: {
            code: "PLUGIN_UNLOADED",
            message: `Plugin "${pluginId}" is no longer loaded`,
          },
        };
      }
      const requestedProjectId = parseDispatchTarget(pluginId, options);
      if (requestedProjectId === undefined) {
        // A bound dispatch reaches only its own project's renderer and rejects
        // with PROJECT_VIEW_UNAVAILABLE when that project has no live view;
        // unbound stays ambient, since an app-global plugin's action belongs
        // wherever the user is looking. In Host mode it goes to the view that
        // drives the project, which may be on another machine, and answers
        // NO_FRONTEND_ATTACHED when nobody does.
        return dispatchAsPlugin(actionId, args, boundProjectId);
      }
      if (boundProjectId !== null) {
        // The confused-deputy guard: a project-bound plugin may restate its own
        // project but never reach another one, whatever the user has granted.
        if (requestedProjectId !== boundProjectId) {
          throw new Error(
            `PERMISSION_REQUIRED: plugin "${pluginId}" is bound to its own project and cannot dispatch to project "${requestedProjectId}"`
          );
        }
        return dispatchAsPlugin(actionId, args, boundProjectId);
      }
      // Unbound with an explicit target (#13119): only after the user turned
      // the switch on. No JIT prompt and no built-in bypass — the switch is the
      // whole grant, so an unattended plugin fails fast instead of waiting on a
      // dialog nobody is there to answer.
      if (!deps.declaredCapabilities(pluginId).has("project:dispatch")) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" dispatch with options.projectId requires "project:dispatch", which is not declared in manifest.capabilities`
        );
      }
      if (!hasProjectTargetingGrant(pluginId)) {
        throw new Error(
          `PERMISSION_REQUIRED: plugin "${pluginId}" dispatch with options.projectId requires "Allow project targeting", which is off. Turn it on in the plugin's Permissions in the Plugin Manager.`
        );
      }
      const startedAt = Date.now();
      const audit = (result: "success" | "error", errorMessage: string): void => {
        deps.safeAppendAudit({
          pluginId,
          actionId: `dispatch:${requestedProjectId}:${actionId}`,
          recordType: "ipc-invoke",
          channel: "plugin:dispatch-targeted",
          result,
          errorMessage,
          argsHash: deps.safeArgsHash([args]),
          durationMs: Date.now() - startedAt,
        });
      };
      try {
        const result = await dispatchAsPlugin(actionId, args, requestedProjectId).catch(
          (err: unknown) => closeWithNoView(err, actionId, args, requestedProjectId)
        );
        if (result.ok) audit("success", "");
        else audit("error", result.error.code);
        return result;
      } catch (err) {
        audit("error", isProjectViewUnavailable(err) ? "PROJECT_VIEW_UNAVAILABLE" : "ERROR");
        throw err;
      }
    },
    // Built-in action catalog (#10561). NOT revoke-guarded for the same reason
    // as dispatch: plugins introspect from post-activation callbacks/timers.
    // Once the plugin unloads these degrade to empty/absent results ([] / null
    // / "restricted") without a renderer round-trip. The renderer projects
    // ActionService.list()/get() — minus danger:"restricted" and every
    // denyPluginDispatch action — to the slim PluginActionManifestEntry, so the
    // catalog never exposes an action dispatch would refuse as RESTRICTED.
    actions: {
      list: async () => {
        if (!deps.plugins.has(pluginId)) return [];
        try {
          return await dispatcher.sendActionsListToRenderer(boundProjectId, pluginId);
        } catch (err) {
          // A bound host whose project has no live view is the catalog's
          // documented "no renderer available" case, not an error — this
          // surface never throws, and the worker proxy already collapses a
          // failure here into the same empty answer.
          if (isProjectViewUnavailable(err)) return [];
          throw err;
        }
      },
      get: async (actionId) => {
        if (!deps.plugins.has(pluginId)) return null;
        try {
          return await dispatcher.sendActionsGetToRenderer(actionId, boundProjectId, pluginId);
        } catch (err) {
          if (isProjectViewUnavailable(err)) return null;
          throw err;
        }
      },
      // canDispatch derives locally from get() — no extra round-trip. A null
      // entry (unknown id, or a restricted or plugin-denied action the renderer
      // projects away)
      // maps to "restricted"; "confirm" actions surface as "confirm" so a
      // plugin can warn before dispatch() returns CONFIRMATION_REQUIRED.
      canDispatch: async (actionId) => {
        if (!deps.plugins.has(pluginId)) return "restricted";
        const entry = await dispatcher
          .sendActionsGetToRenderer(actionId, boundProjectId, pluginId)
          .catch((err: unknown) => {
            if (isProjectViewUnavailable(err)) return null;
            throw err;
          });
        if (!entry) return "restricted";
        if (entry.danger === "confirm") return "confirm";
        // Fail closed: only an explicit "safe" entry is dispatchable without a
        // prompt. Any other danger (including an unexpected value) → restricted.
        if (entry.danger === "safe") return "ok";
        return "restricted";
      },
    },
    // Imperative UI prompts (#10522). NOT revoke-guarded for the same reason
    // as showToast/dispatch: plugins prompt from command handlers that run
    // long after activate() resolves. Liveness is plugin membership — once the
    // plugin unloads these resolve the dismiss value (undefined / false)
    // without a renderer round-trip, and an in-flight prompt is drained by
    // promptDispatcher.cancelForPlugin in unloadPlugin. Invalid options throw
    // so authoring mistakes surface loudly (mirrors showToast).
    showQuickPick: (async (
      items: PluginQuickPickItem[],
      options?: PluginQuickPickOptions,
      callOptions?: PluginPromptCallOptions
    ): Promise<PluginQuickPickItem | PluginQuickPickItem[] | undefined> => {
      if (!deps.plugins.has(pluginId)) return undefined;
      const validItems = validateQuickPickItems(pluginId, items);
      // Bound: the prompt lands in the owning project's view even when it is
      // not the visible one, so the user finds it on switching back, and
      // rejects when that project has no view at all. Unbound is deliberately
      // ambient — an app-global plugin's prompt belongs in front of whoever is
      // looking.
      const value = await promptDispatcher.requestPrompt(
        pluginId,
        {
          kind: "quickPick",
          items: validItems,
          options: sanitizeQuickPickOptions(options),
        },
        boundProjectId,
        callOptions?.signal,
        promptRequestOptions(callOptions)
      );
      return value as PluginQuickPickItem | PluginQuickPickItem[] | undefined;
    }) as PluginHostApi["showQuickPick"],
    showInputBox: async (options, callOptions) => {
      if (!deps.plugins.has(pluginId)) return undefined;
      const value = await promptDispatcher.requestPrompt(
        pluginId,
        { kind: "inputBox", options: sanitizeInputBoxOptions(options) },
        boundProjectId,
        callOptions?.signal,
        promptRequestOptions(callOptions)
      );
      return value as string | undefined;
    },
    showConfirm: async (options, callOptions) => {
      if (!deps.plugins.has(pluginId)) return false;
      if (!options || typeof options !== "object" || typeof options.title !== "string") {
        throw new Error(`Plugin "${pluginId}" showConfirm: options.title must be a string`);
      }
      const value = await promptDispatcher.requestPrompt(
        pluginId,
        { kind: "confirm", options: sanitizeConfirmOptions(options) },
        boundProjectId,
        callOptions?.signal,
        promptRequestOptions(callOptions)
      );
      return value === true;
    },
    // NOT revoke-guarded for the same reason as showToast/dispatch: plugins
    // log from post-activation callbacks and timers. Liveness is plugin
    // membership (enforced inside recordPluginLog) — writes silently no-op
    // once the plugin unloads. Synchronous void return; never throws.
    logger: {
      info: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "info", message, fields);
      },
      warn: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "warn", message, fields);
      },
      error: (message, fields) => {
        if (boundPlugin) deps.recordPluginLog(boundPlugin, pluginId, "error", message, fields);
      },
    },
    // Managed child-process surface (#9234). NOT revoke-guarded — a process
    // orchestrator spawns/respawns from post-activation timers and callbacks.
    // `spawn` is the first runtime enforcement of a scope capability: it
    // rejects unless the plugin declared `shell:exec` (mirrors the channel
    // capability gate at the dispatch boundary). Liveness is plugin membership
    // — once the plugin unloads `spawn` rejects and outstanding processes are
    // torn down by `killAll` in unloadPlugin.
    process: buildProcessApi(deps, pluginId, fetchWorktreeSnapshots),
    tasks: tasksApi,
    // Host-mediated, scope-contained filesystem + git surfaces (fs-API
    // containment unit). NOT revoke-guarded — plugins read/write from
    // post-activation timers and callbacks. Every path argument is realpath-
    // contained to the declared scopes.fs.allowedPaths and capability-gated;
    // this is the runtime enforcement of allowedPaths (formerly advisory).
    fs: fsApi,
    git: buildGitApi(deps, pluginId),
    // Host-mediated OS clipboard surface backing the clipboard:read /
    // clipboard:write tokens. Runs in the main process (Electron's clipboard
    // module is unavailable in the dev-worker utility process), so it works
    // from a headless plugin with no mounted panel. NOT revoke-guarded —
    // liveness is plugin membership; once unloaded every method rejects.
    clipboard: buildClipboardApi(deps, pluginId, boundProjectId),
    // Host-mediated open/reveal, scoped to the plugin's own declared fs roots
    // (including its implicit plugin-data namespace) rather than the user's
    // project roots — the gap that pushed plugins into shelling out to
    // /usr/bin/open. NOT revoke-guarded, same as fs/clipboard.
    system: buildSystemApi(deps, pluginId, boundProjectId),
    // HTML-to-PDF export written under host.fs.writeFile's gates. NOT
    // revoke-guarded, same as fs/system.
    documents: buildDocumentsApi(deps, pluginId),
    // Large files the host holds and streams (#14100). NOT revoke-guarded,
    // same as fs/documents; unload cancels transfers and drops artifacts.
    artifacts: buildArtifactsApi(deps, pluginId, boundProjectId),
    // NOT revoke-guarded: a plugin asks for a token from timers and callbacks.
    // Signing in and out are not here at all — only the host's settings row
    // can start either.
    // `ref.projectId` is resolved once, in the account service: a project
    // plugin's host may only name its own project, an installed plugin's names
    // the project it is acting in.
    account: {
      getState: async (ref) => {
        assertAccountHostLoaded("getState");
        return deps.accounts.getStateFor(pluginId, accountRef(pluginId, "getState", ref));
      },
      getAccessToken: async (ref) => {
        assertAccountHostLoaded("getAccessToken");
        const token = await deps.accounts.getAccessTokenFor(
          pluginId,
          accountRef(pluginId, "getAccessToken", ref)
        );
        // A token read that outlives an unload or reload doesn't reach a host
        // that no longer speaks for the plugin.
        assertAccountHostLoaded("getAccessToken");
        return token;
      },
      onDidChange: (callback, ref) => {
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" account.onDidChange: callback must be a function`);
        }
        const target = accountRef(pluginId, "onDidChange", ref);
        // An undeclared account never changes. Same answer in a worker, which
        // can't see the manifest to refuse synchronously.
        if (!isBound() || !deps.accounts.declaredAccount(pluginId)) return () => {};
        const unsubscribe = deps.accounts.subscribe(
          pluginId,
          (state) => (isBound() ? callback(state) : undefined),
          target
        );
        return trackPluginDisposer(deps.pluginEventCleanups, pluginId, unsubscribe);
      },
    },
    // NOT revoke-guarded: calls come from handlers and timers long after
    // activate(). The caller is this instance as captured here — nothing the
    // plugin passes can name another — and the provider runs under its own
    // host, so its account and capabilities never become the caller's.
    services: {
      call: (async (name: unknown, method: unknown, args: unknown, options?: unknown) => {
        if (!isBound()) {
          return { ok: false, reason: "unavailable", message: `Plugin "${pluginId}" is unloaded` };
        }
        return deps.services.call(
          { instanceId: pluginId, projectId: boundProjectId },
          name,
          method,
          args,
          options
        );
      }) as PluginServicesApi["call"],
      status: async (name) => {
        if (!isBound()) {
          return {
            available: false,
            required: false,
            reason: "unavailable",
            message: `Plugin "${pluginId}" is unloaded`,
          };
        }
        return deps.services.status({ instanceId: pluginId, projectId: boundProjectId }, name);
      },
    },
    // NOT revoke-guarded: plugins read/write settings throughout their
    // lifetime (IPC handlers, timers), long after activate() resolves. The
    // store is the source of truth, so a late call is harmless.
    //
    // Every settings call classifies its key from `declaring` — the frozen
    // manifest of the instance this host was made for — never the live one, so
    // an unload mid-call can't turn a secret into plaintext or move a key into
    // another scope (#14092). An unloaded instance's writes still land (a
    // deactivate() saving state); a replaced one's never commit, since the
    // instance now running may declare the key differently.
    settings: {
      get: async <T = unknown>(
        key: string,
        scope?: PluginSettingsScope
      ): Promise<T | undefined> => {
        assertSettingsKey(pluginId, "get", key);
        // Resolve the manifest-declared scope so a read targets the same scope
        // the write path enforces — otherwise a `scope: "project"` key read
        // with no scope arg silently reads the wrong ("user") store (#10586).
        const declaredScope = deps.settings.getDeclaredScope(pluginId, key, declaring);
        if (scope !== undefined && declaredScope !== undefined && declaredScope !== scope) {
          throw new Error(
            `Plugin "${pluginId}" settings.get: key "${key}" is declared in "${declaredScope}" scope, not "${scope}"`
          );
        }
        const effectiveScope = declaredScope ?? scope ?? "user";
        const filePath = deps.settings.resolveSettingsFilePathForKey(
          pluginId,
          key,
          effectiveScope,
          boundScopeRoot,
          declaring
        );
        // Project scope with no active project reads as unset rather than
        // throwing; unset reads as the declared default, if there is one.
        const stored = filePath
          ? await deps.settings
              .getOrCreateSettingsStore(pluginId, filePath)
              .get<T>(key, { secret: deps.settings.isSecretKey(pluginId, key, declaring) })
          : undefined;
        return stored !== undefined
          ? stored
          : (deps.settings.getDeclaredDefault(pluginId, key, declaring) as T | undefined);
      },
      set: async <T = unknown>(
        key: string,
        value: T,
        requestedScope?: PluginSettingsScope
      ): Promise<void> => {
        assertSettingsKey(pluginId, "set", key);
        assertSettingsInstanceCurrent("set");
        // Omitted, the declared scope is the target, as it is for `get`; a
        // conflicting explicit scope still throws in assertSettingDeclared.
        const scope =
          requestedScope ?? deps.settings.getDeclaredScope(pluginId, key, declaring) ?? "user";
        if (value === undefined) {
          throw new Error(
            `Plugin "${pluginId}" settings.set: value for "${key}" is undefined — settings cannot store undefined`
          );
        }
        deps.settings.assertSettingSerializable(pluginId, key, value);
        deps.settings.assertSettingDeclared(pluginId, key, scope, declaring);
        const secret = deps.settings.isSecretKey(pluginId, key, declaring);
        const filePath = deps.settings.resolveSettingsFilePathForKey(
          pluginId,
          key,
          scope,
          boundScopeRoot,
          declaring
        );
        if (!filePath) {
          throw new Error(
            `Plugin "${pluginId}" settings.set: no active project — "project" scope has no target`
          );
        }
        // Project settings live in the repository's `.daintree`; user and local
        // files, outside every project, change none.
        await assertPluginCallerDrives(pluginId, "settings.set", { paths: [filePath] });
        assertSettingsInstanceCurrent("set");
        const store = deps.settings.getOrCreateSettingsStore(pluginId, filePath);
        const changed = await store.set(key, value, { secret });
        if (changed) deps.settings.notifySettingsSubscribers(pluginId, scope, key, value);
      },
      unset: async (key: string, requestedScope?: PluginSettingsScope): Promise<void> => {
        assertSettingsKey(pluginId, "unset", key);
        assertSettingsInstanceCurrent("unset");
        // Unlike `set`, only a declared key can be cleared: the scope it lives in
        // is the manifest's, so nothing here guesses a file to delete from.
        const declaredScope = deps.settings.getDeclaredScope(pluginId, key, declaring);
        if (declaredScope === undefined) {
          throw new Error(
            `Plugin "${pluginId}" settings.unset: key "${key}" is not declared in contributes.settings`
          );
        }
        if (requestedScope !== undefined && requestedScope !== declaredScope) {
          throw new Error(
            `Plugin "${pluginId}" settings.unset: key "${key}" is declared in "${declaredScope}" scope, not "${requestedScope}"`
          );
        }
        const filePath = deps.settings.resolveSettingsFilePathForKey(
          pluginId,
          key,
          declaredScope,
          boundScopeRoot,
          declaring
        );
        // No active project means nothing is stored there to clear.
        if (!filePath) return;
        // Same guard as `set`: project settings live in the repository's `.daintree`.
        await assertPluginCallerDrives(pluginId, "settings.unset", { paths: [filePath] });
        assertSettingsInstanceCurrent("unset");
        const store = deps.settings.getOrCreateSettingsStore(pluginId, filePath);
        // A secret is an encrypted envelope in the same file, so deleting the
        // key clears it without decrypting anything.
        const changed = await store.delete(key);
        if (changed)
          deps.settings.notifySettingsSubscribers(pluginId, declaredScope, key, undefined);
      },
      onDidChange: <T = unknown>(
        key: string,
        callback: (value: T | undefined) => void,
        requestedScope?: PluginSettingsScope
      ): Promise<() => void> => {
        const scope = requestedScope ?? deps.settings.getDeclaredScope(pluginId, key) ?? "user";
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: settings.onDidChange called after activate() returned or timed out`
          );
        }
        assertSettingsKey(pluginId, "onDidChange", key);
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" settings.onDidChange: callback must be a function`);
        }
        deps.settings.assertSettingScope(pluginId, key, scope);
        const sub = { key, scope, cb: callback as (value: unknown) => void };
        deps.settings.addSubscriber(pluginId, sub);

        const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
          deps.settings.removeSubscriber(pluginId, sub)
        );
        return Promise.resolve(dispose);
      },
      // Always this plugin's own settings: the id is the closure's, never the
      // caller's, and a bound host reaches only its own project's renderer —
      // the same routing `dispatch` uses, so a project plugin cannot open
      // another project's settings.
      open: async (key?: string): Promise<void> => {
        if (key !== undefined) assertSettingsKey(pluginId, "open", key);
        if (!deps.plugins.has(pluginId)) {
          throw new Error(`Plugin "${pluginId}" settings.open: plugin is no longer loaded`);
        }
        const result = await dispatcher.sendDispatchToRenderer(
          "plugin.openSettings",
          key === undefined ? { pluginId } : { pluginId, key },
          boundProjectId
        );
        if (!result.ok) {
          throw new Error(`Plugin "${pluginId}" settings.open: ${result.error.message}`);
        }
      },
      missingRequired: (): Promise<string[]> =>
        deps.settings.missingRequiredForHost(pluginId, boundScopeRoot),
    },
    // Private machine-owned key/value storage (#10556). NOT revoke-guarded
    // (except onDidChange): plugins read/write storage throughout their
    // lifetime. The "worktree"/"project" scopes resolve their target
    // asynchronously, so set/delete re-check liveness after the await — a
    // plugin unloaded mid-resolution silently no-ops rather than writing into
    // a torn-down plugin's file (lessons #9322/#9428/#9533).
    db: dbApi,
    storage: {
      get: async <T = unknown>(
        key: string,
        scope: PluginStorageScope = "user"
      ): Promise<T | undefined> => {
        assertStorageKey(pluginId, "get", key);
        const filePath = await deps.storage.resolveStorageFilePath(
          pluginId,
          scope,
          await storageTargetFor(scope)
        );
        // No active project/worktree (or unset key): read resolves to undefined
        // rather than throwing, matching the "unset key" return.
        if (!filePath || !isBound()) return undefined;
        return deps.storage.getOrCreateStorageStore(pluginId, scope, filePath).get<T>(key);
      },
      set: async <T = unknown>(
        key: string,
        value: T,
        scope: PluginStorageScope = "user"
      ): Promise<void> => {
        assertStorageKey(pluginId, "set", key);
        if (value === undefined) {
          throw new Error(
            `Plugin "${pluginId}" storage.set: value for "${key}" is undefined — storage cannot store undefined`
          );
        }
        deps.storage.assertStorageSerializable(pluginId, key, value);
        const filePath = await deps.storage.resolveStorageFilePath(
          pluginId,
          scope,
          await storageTargetFor(scope)
        );
        // Re-check liveness after the async resolve so a racing unloadPlugin()
        // doesn't write into a torn-down plugin's storage file.
        if (!isBound()) return;
        if (!filePath) {
          throw new Error(
            `Plugin "${pluginId}" storage.set: no active ${scope} — "${scope}" scope has no target`
          );
        }
        // Project and worktree storage lives in the repository's `.daintree`;
        // user storage is in no project unless one holds the storage dir.
        await assertPluginCallerDrives(pluginId, "storage.set", { paths: [filePath] });
        if (!isBound()) return;
        const store = deps.storage.getOrCreateStorageStore(pluginId, scope, filePath);
        const changed = await store.set(key, value);
        if (changed) deps.storage.notifyStorageSubscribers(pluginId, scope, key, value);
      },
      delete: async (key: string, scope: PluginStorageScope = "user"): Promise<void> => {
        assertStorageKey(pluginId, "delete", key);
        const filePath = await deps.storage.resolveStorageFilePath(
          pluginId,
          scope,
          await storageTargetFor(scope)
        );
        // Missing target or unloaded plugin: a delete is a no-op rather than a
        // throw (matching the "already absent" return of the store).
        if (!filePath || !isBound()) return;
        await assertPluginCallerDrives(pluginId, "storage.delete", { paths: [filePath] });
        if (!isBound()) return;
        const store = deps.storage.getOrCreateStorageStore(pluginId, scope, filePath);
        const changed = await store.delete(key);
        if (changed) deps.storage.notifyStorageSubscribers(pluginId, scope, key, undefined);
      },
      onDidChange: <T = unknown>(
        key: string,
        callback: (value: T | undefined) => void,
        scope: PluginStorageScope = "user"
      ): Promise<() => void> => {
        if (revoked) {
          throw new Error(
            `Plugin "${pluginId}" host revoked: storage.onDidChange called after activate() returned or timed out`
          );
        }
        assertStorageKey(pluginId, "onDidChange", key);
        if (typeof callback !== "function") {
          throw new Error(`Plugin "${pluginId}" storage.onDidChange: callback must be a function`);
        }
        const sub = { key, scope, cb: callback as (value: unknown) => void };
        deps.storage.addSubscriber(pluginId, sub);

        const dispose = trackPluginDisposer(deps.pluginEventCleanups, pluginId, () =>
          deps.storage.removeSubscriber(pluginId, sub)
        );
        return Promise.resolve(dispose);
      },
    },
  };
  // The worker bridge's backing for its synchronous `hasListeners` cache. Not a
  // plugin event subscription: untracked in `pluginEventCleanups` (so a read
  // never holds the worker against idle disposal) and passive in the registry
  // (so it never keeps the periodic reconcile running). The bridge disposes it
  // with its other subscriptions on worker teardown; one that outlives its
  // plugin's binding unwatches itself on the next change.
  pushListenerObservers.set(host, (channel, callback) => {
    const transport = pushListenerChannel("hasListeners", channel);
    // Unbound answers as `hasListeners` does, and never changes.
    if (!isBound()) return { current: false, dispose: () => {} };
    const registry = getPluginPushListenerRegistry();
    const unwatch = registry.watch(
      boundProjectId,
      transport,
      (hasListeners) => {
        if (!isBound()) {
          unwatch();
          return;
        }
        callback(hasListeners);
      },
      { passive: true }
    );
    return { current: registry.hasListeners(boundProjectId, transport), dispose: unwatch };
  });
  return {
    host,
    revoke: () => {
      revoked = true;
    },
  };
}

/**
 * The explicit target on `host.dispatch(actionId, args, options)` (#13119), or
 * `undefined` when the caller named none. Arrives from an untrusted worker, so
 * the shape is checked here; an empty or non-string id is refused rather than
 * read as "no target", since that would silently route to the focused project.
 */
function parseDispatchTarget(pluginId: string, options: unknown): string | undefined {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new Error(`Plugin "${pluginId}" dispatch: options must be an object`);
  }
  const { projectId } = options as { projectId?: unknown };
  if (projectId === undefined) return undefined;
  if (typeof projectId !== "string" || projectId.trim().length === 0) {
    throw new Error(`Plugin "${pluginId}" dispatch: options.projectId must be a non-empty string`);
  }
  return projectId;
}

/**
 * Whether the user turned on "Allow project targeting" for an app-wide plugin.
 * Read straight from the grant store: the switch is the only writer, and the
 * JIT consent flow never mints this capability.
 */
function hasProjectTargetingGrant(pluginId: string): boolean {
  return getPluginCapabilityConsentStore().hasGrant({
    pluginId,
    capability: "project:dispatch",
    scopeKey: "global",
  });
}

/** Whether the user turned on "Allow OS notifications" for this plugin (#13505). */
function hasOsNotificationsGrant(pluginId: string): boolean {
  return getPluginCapabilityConsentStore().hasGrant({
    pluginId,
    capability: "notification:os",
    scopeKey: "global",
  });
}

/**
 * Meter every prompt that puts a dialog in front of the user, so an invoke
 * whose handler awaited one is not reported as a slow handler. Only
 * `requestPrompt` is wrapped; it is the one method the host calls.
 */
function withPromptWaitTracking(
  dispatcher: PluginUIPromptDispatcher,
  track: ((pluginId: string) => () => void) | undefined
): Pick<PluginUIPromptDispatcher, "requestPrompt"> {
  // Partial test deps leave the dispatcher unset.
  if (!track || dispatcher === null || typeof dispatcher !== "object") return dispatcher;
  return {
    requestPrompt: (pluginId, params, projectId, signal) => {
      if (!promptOpensDialog(params)) {
        return dispatcher.requestPrompt(pluginId, params, projectId, signal);
      }
      let end: () => void = () => {};
      try {
        end = track(pluginId);
      } catch {
        // Metering must never change what the plugin sees.
      }
      let pending: Promise<PluginUiPromptResultValue>;
      try {
        pending = dispatcher.requestPrompt(pluginId, params, projectId, signal);
      } catch (err) {
        end();
        throw err;
      }
      return pending.finally(end);
    },
  };
}

/**
 * Resolve the terminal id of the "active agent" for `host.sendToActiveAgent`
 * (#10558). Centralised here so plugins stop reinventing `terminal.list`-based
 * selection heuristics that drift. Ranks focused/visible agent
 * (`activityTier: "active"`) first, then a `waiting` agent, then the most
 * recently active by output — with a deterministic id tiebreak. Terminals with
 * no agent or in an ended state (`exited` / `completed`, or no live PTY) are
 * excluded.
 *
 * So is the Daintree Assistant (#13494), whatever the plugin's consent: it runs
 * a real agent CLI, so it passes every other test, and a waiting assistant
 * outscores a busy grid agent. It holds the project's full MCP surface, which
 * consent to "send text to the active agent" never covered. Filtered before
 * ranking, so a project whose only agent is the assistant takes the same
 * no-agent path as one with none.
 *
 * `boundProjectId` is the host's binding. Bound: only that project's terminals
 * are eligible, and `null` comes back when it has none, so the caller can
 * no-op instead of injecting into a project the user never consented to.
 * Unbound (`null`): deliberately ambient — it scopes to whatever project the
 * PTY host last saw focused, since "the active agent" an app-global plugin
 * means is the one in front of the user, and considers all terminals only when
 * no project is active at all (e.g. before any project loads).
 *
 * @throws {Error} `NO_ACTIVE_AGENT:` when the terminal host is unavailable, or
 *   when an unbound host finds no eligible agent terminal.
 */
async function resolveActiveAgentTerminalId(boundProjectId: string | null): Promise<string | null> {
  const ptyClient = getPtyClient();
  if (!ptyClient) {
    throw new Error("NO_ACTIVE_AGENT: terminal host is not available");
  }
  const all = await ptyClient.getAllTerminalsAsync();
  type Term = (typeof all)[number];
  const eligible = (t: Term): boolean =>
    Boolean(t.detectedAgentId ?? t.launchAgentId) &&
    t.hasPty !== false &&
    t.agentState !== "exited" &&
    t.agentState !== "completed" &&
    !isAssistantTerminalRecord(t);
  // Scope to the bound project, or to the focused one; never cross into another
  // project's terminals.
  const scopeProjectId = boundProjectId ?? ptyClient.getActiveProjectId();
  const pool = scopeProjectId != null ? all.filter((t) => t.projectId === scopeProjectId) : all;
  const candidates = pool.filter(eligible);
  if (candidates.length === 0) {
    if (boundProjectId !== null) return null;
    throw new Error(
      "NO_ACTIVE_AGENT: no agent terminal is available to receive input in the current project"
    );
  }
  const score = (t: Term): number =>
    (t.activityTier === "active" ? 2 : 0) + (t.agentState === "waiting" ? 1 : 0);
  candidates.sort((a, b) => {
    const byScore = score(b) - score(a);
    if (byScore !== 0) return byScore;
    const byOutput = (b.lastOutputTime ?? 0) - (a.lastOutputTime ?? 0);
    if (byOutput !== 0) return byOutput;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return candidates[0].id;
}
