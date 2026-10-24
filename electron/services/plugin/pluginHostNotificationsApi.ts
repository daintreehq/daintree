import { randomUUID } from "node:crypto";

import { getPluginCapabilityConsentStore } from "../plugin-capability/instances.js";
import { admitPluginToast } from "./pluginToastBudget.js";
import type { PluginUIPromptDispatcher, PromptRequestOptions } from "./PluginUIPromptDispatcher.js";
import { resolvePluginFrontend } from "./pluginFrontendRouting.js";
import { recordPluginLaunch } from "./pluginLaunchedAgents.js";
import { PluginFrontendMethod } from "./pluginFrontendRequests.js";
import { type PluginTaskApi } from "../../../shared/types/plugin.js";
import {
  inertPluginTaskHandle,
  validatePluginTaskProgress,
  validatePluginTaskResult,
  validatePluginTaskStart,
} from "../../../shared/utils/pluginTasks.js";
import type { PluginTaskRecord } from "./PluginTaskRegistry.js";

import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { maskTerminalInOtherProject } from "../../../shared/utils/terminalInOtherProject.js";
import type { ActionDispatchResult } from "../../../shared/types/actions.js";
import { CHANNELS } from "../../ipc/channels.js";
import {
  isBuiltInActionId,
  PluginNotifyOptionsSchema,
  PluginToastOptionsSchema,
} from "../../schemas/plugin.js";
import { type PluginRunRecipeRequest } from "../../../shared/types/pluginUiPrompt.js";
import { RUN_RECIPE_MAX_ID_LENGTH, toRunRecipeResult } from "./runRecipeLimits.js";
import { getPluginRecipe, getPluginRecipeOwner } from "./PluginRecipeRegistry.js";
import { validatePluginRecipeVariables } from "../../../shared/utils/pluginRecipeVariables.js";
import { isAgentRecipeType } from "../../../shared/types/project.js";
import { sanitizeAgentContextSourceLabel } from "../../../shared/utils/agentContextDrag.js";
import type {
  PluginHostApi,
  PluginQuickPickItem,
  PluginQuickPickOptions,
  PluginPromptCallOptions,
  PluginInputBoxOptions,
  PluginConfirmOptions,
  PluginHostBinding,
} from "../../../shared/types/plugin.js";
import { type PluginHostFactoryDeps, isProjectViewUnavailable } from "./pluginHostDeps.js";
import type { PluginEventScope } from "./pluginEventScope.js";
import type { PluginRendererDispatcher } from "./PluginRendererDispatcher.js";

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

/** What the notification, prompt and dispatch surface reads from `createHost`. */
export interface PluginHostNotificationsContext {
  readonly boundProjectId: PluginHostBinding["projectId"];
  readonly deps: Pick<
    PluginHostFactoryDeps,
    | "declaredCapabilities"
    | "panelLifecycleBroker"
    | "pluginDisplayName"
    | "pluginNotificationsBlocked"
    | "pluginTasks"
    | "plugins"
    | "safeAppendAudit"
    | "safeArgsHash"
  >;
  /** Delivers this plugin's pending pushes before each renderer round-trip. */
  readonly dispatcher: PluginRendererDispatcher;
  readonly fetchWorktreeSnapshotsResult: PluginEventScope["fetchWorktreeSnapshotsResult"];
  readonly isBound: PluginEventScope["isBound"];
  readonly manifestId: string;
  /** `notify` on the composed host, for task notifications. */
  readonly notifyViaHost: PluginHostApi["notify"];
  readonly pluginId: string;
  readonly promptDispatcher: Pick<PluginUIPromptDispatcher, "requestPrompt">;
  /** `sendToScope` after delivering this plugin's pending pushes. */
  readonly pushToRenderers: (channel: string, ...args: unknown[]) => void;
}

/**
 * The host's toasts, notifications, prompts, action dispatch and tasks.
 * Toasts and notifications reach the renderer one at a time, in the order the
 * plugin raised them.
 */
export function buildNotificationsHostApi(
  ctx: PluginHostNotificationsContext
): Pick<
  PluginHostApi,
  | "runRecipe"
  | "showToast"
  | "notify"
  | "dispatch"
  | "actions"
  | "showQuickPick"
  | "showInputBox"
  | "showConfirm"
  | "tasks"
> {
  const {
    boundProjectId,
    deps,
    dispatcher,
    fetchWorktreeSnapshotsResult,
    isBound,
    manifestId,
    notifyViaHost,
    pluginId,
    promptDispatcher,
    pushToRenderers,
  } = ctx;
  /**
   * How a prompt travels beyond this machine: the name a remote frontend shows
   * for it, and whether it may wait for someone to attach.
   */
  const promptRequestOptions = (callOptions?: PluginPromptCallOptions): PromptRequestOptions => ({
    pluginDisplayName: deps.pluginDisplayName(pluginId),
    ...(callOptions?.whenNoFrontend === "queue" ? { whenNoFrontend: "queue" as const } : {}),
  });

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
            await notifyViaHost({
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
            await notifyViaHost({
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

  return {
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
    tasks: tasksApi,
  };
}
