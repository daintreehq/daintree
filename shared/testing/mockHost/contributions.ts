/**
 * Contributions for `createMockHost`: actions, IPC handlers and renderer
 * messages, listener presence, the providers, services and MCP tools a plugin
 * registers, and the dispatches it makes against them.
 */

import { toRuntimePanelKindId } from "../../config/panelKindRegistry.js";
import type {
  ActionDispatchResult,
  ActionId,
  PluginActionManifestEntry,
  PluginCanDispatchResult,
} from "../../types/actions.js";
import type {
  PluginChannelSchema,
  PluginHostApi,
  PluginIpcHandler,
  PluginTypedIpcHandler,
  PluginHandlerOptions,
} from "../../types/plugin.js";
import type { MockHostIdentity } from "./identity.js";
import type {
  RegisteredActionRecord,
  RegisteredHandlerRecord,
  BroadcastRecord,
  PostToPanelRecord,
  DispatchedActionRecord,
  RegisteredForgeProviderRecord,
  RegisteredFileDecorationProviderRecord,
  RegisteredSearchProviderRecord,
  RegisteredServiceRecord,
  RegisteredContextProviderRecord,
  RegisteredWorktreeSetupStepRecord,
  RegisteredWorktreeDeleteNotesProviderRecord,
  RegisteredMcpToolsRecord,
  InvalidationRecord,
  CreateMockHostOptions,
  MockHost,
} from "./types.js";

export type ContributionsMembers = Pick<
  MockHost,
  | "panelKindId"
  | "registerAction"
  | "registerHandler"
  | "broadcastToRenderer"
  | "postToPanel"
  | "hasListeners"
  | "onDidChangeListeners"
  | "registerForgeProvider"
  | "registerFileDecorationProvider"
  | "registerWorktreeSetupStep"
  | "registerSearchProvider"
  | "registerContextProvider"
  | "registerService"
  | "registerWorktreeDeleteNotesProvider"
  | "mcp"
  | "invalidateFileDecorations"
  | "dispatch"
  | "actions"
  | "registeredActions"
  | "registeredHandlers"
  | "broadcastCalls"
  | "postToPanelCalls"
  | "dispatchedActions"
  | "registeredForgeProviders"
  | "registeredFileDecorationProviders"
  | "registeredWorktreeSetupSteps"
  | "registeredSearchProviders"
  | "registeredContextProviders"
  | "registeredServices"
  | "registeredWorktreeDeleteNotesProviders"
  | "registeredMcpTools"
  | "invalidationCalls"
  | "simulateListenersChange"
  | "setDispatchResult"
  | "seedActionCatalog"
>;

/**
 * Mirrors the action-id regex and kind/danger sets in
 * `electron/services/PluginService.ts` `PLUGIN_ACTION_ID_RE` /
 * `PLUGIN_ACTION_KINDS` / `PLUGIN_ACTION_DANGERS`. The mock can't import
 * those (cross-process boundary), so the values are duplicated here and the
 * production constants are the source of truth. If the production regex or
 * sets change, mirror the change here.
 */
// The `_` in the leading segment is load-bearing and was missing here until
// #12215: a project plugin's ids are instance-qualified
// (`project__{projectId}__{publisher}.{name}.{action}`), so without it this
// mock rejected every `registerAction` a project plugin makes — the one kind of
// plugin the agent brief tells authors to write — while production accepted it.
const PLUGIN_ACTION_ID_RE = /^[a-z0-9][a-z0-9_-]*\.[a-z0-9][a-zA-Z0-9._-]*$/;
const PLUGIN_ACTION_KINDS = new Set(["command", "query"]);
const PLUGIN_ACTION_DANGERS = new Set(["safe", "confirm"]);
/** Refuse a registerHandler/postToPanel/broadcastToRenderer channel the way production does. */
function isInvalidChannel(channel: unknown, allowEmpty: boolean): boolean {
  if (typeof channel !== "string") return true;
  if (!allowEmpty && channel.length === 0) return true;
  return channel.includes(":");
}

export interface ContributionsFacet {
  members: ContributionsMembers;
  /** Records a dispatch the host makes on the plugin's behalf. */
  recordDispatch(record: DispatchedActionRecord): void;
}

export function createContributionsFacet(
  identity: MockHostIdentity,
  options: CreateMockHostOptions,
  collaborators: {
    recordMockLaunch(
      actionId: ActionId,
      args: unknown,
      result: ActionDispatchResult
    ): ActionDispatchResult;
  }
): ContributionsFacet {
  const { pluginId, manifestId: mockManifestId, projectId: mockProjectId, pluginInfo } = identity;
  const { recordMockLaunch } = collaborators;
  const registeredActions: RegisteredActionRecord[] = [];
  const registeredHandlers: RegisteredHandlerRecord[] = [];
  const broadcastCalls: BroadcastRecord[] = [];
  const postToPanelCalls: PostToPanelRecord[] = [];
  const dispatchedActions: DispatchedActionRecord[] = [];
  const registeredForgeProviders: RegisteredForgeProviderRecord[] = [];
  const registeredFileDecorationProviders: RegisteredFileDecorationProviderRecord[] = [];
  const registeredWorktreeSetupSteps: RegisteredWorktreeSetupStepRecord[] = [];
  const registeredSearchProviders: RegisteredSearchProviderRecord[] = [];
  const registeredContextProviders: RegisteredContextProviderRecord[] = [];
  const registeredServices: RegisteredServiceRecord[] = [];
  const registeredWorktreeDeleteNotesProviders: RegisteredWorktreeDeleteNotesProviderRecord[] = [];
  const registeredMcpTools: RegisteredMcpToolsRecord[] = [];
  const invalidationCalls: InvalidationRecord[] = [];
  /** Channels a test marked as having no listener; every other channel has one. */
  const unlistenedChannels = new Set<string>();
  const listenerSubs = new Map<string, Set<(hasListeners: boolean) => void>>();
  const assertListenerChannel = (method: string, channel: unknown): string => {
    if (isInvalidChannel(channel, false)) {
      throw new Error(
        `${method}: channel must be a non-empty string without colons: ${String(channel)}`
      );
    }
    return channel as string;
  };
  const dispatchOverrides = new Map<ActionId, ActionDispatchResult>();
  const actionCatalog = new Map<string, PluginActionManifestEntry>();

  const members: ContributionsMembers = {
    panelKindId(bareId: string) {
      if (typeof bareId !== "string" || bareId.length === 0) {
        throw new Error(`Plugin "${pluginId}" panelKindId: bareId must be a non-empty string`);
      }
      const qualified = toRuntimePanelKindId(
        { origin: pluginInfo.origin, pluginId: mockManifestId, kindId: bareId },
        mockProjectId
      );
      if (qualified === null) {
        throw new Error(
          `Plugin "${pluginId}" panelKindId: cannot qualify panel kind "${bareId}" for this plugin`
        );
      }
      return qualified;
    },
    registerAction(descriptor, handler) {
      // Mirrors PluginService.createHost L1577-L1631. Validation order matches
      // production: non-object descriptor, non-function handler, non-empty
      // string id, plugin-prefix not already in id, then the
      // validateAndBuildActionDescriptor checks (L2686-L2723) applied to the
      // namespaced id (since production namespaces before that step).
      // Re-registering the same id replaces the prior descriptor + handler
      // (replace-by-id, see host-api.md). A plugin test that calls
      // registerAction with the same id twice should see the second call win,
      // not accumulate two entries.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerAction: descriptor must be an object");
      }
      if (typeof handler !== "function") {
        throw new Error("registerAction: handler must be a function");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerAction: descriptor.id must be a non-empty string");
      }
      if (descriptor.id.startsWith(`${pluginId}.`)) {
        throw new Error(
          `registerAction: descriptor.id "${descriptor.id}" must not include the plugin prefix`
        );
      }
      // Mirrors validateAndBuildActionDescriptor (L2697-L2723). The mock
      // namespaces the id the same way production does and runs the same
      // checks against the namespaced form, so a plugin test that registers
      // an action the production host would reject fails the mock in the
      // same way — no "passes the mock, throws at activation" gap.
      const namespacedId = `${pluginId}.${descriptor.id}`;
      if (!PLUGIN_ACTION_ID_RE.test(namespacedId)) {
        throw new Error(
          `registerAction: descriptor.id "${descriptor.id}" (namespaced to "${namespacedId}") is invalid. Expected "{pluginId}.{actionId}" (lowercase start, alphanumerics, dot/dash/underscore).`
        );
      }
      if (typeof descriptor.title !== "string" || !descriptor.title.trim()) {
        throw new Error("registerAction: descriptor.title must be a non-empty string");
      }
      if (typeof descriptor.description !== "string") {
        throw new Error("registerAction: descriptor.description must be a string");
      }
      if (typeof descriptor.category !== "string" || !descriptor.category.trim()) {
        throw new Error("registerAction: descriptor.category must be a non-empty string");
      }
      if (!PLUGIN_ACTION_KINDS.has(descriptor.kind)) {
        throw new Error(
          `registerAction: descriptor.kind "${descriptor.kind}" is invalid (must be one of: ${[
            ...PLUGIN_ACTION_KINDS,
          ].join(", ")})`
        );
      }
      if (!PLUGIN_ACTION_DANGERS.has(descriptor.danger)) {
        throw new Error(
          `registerAction: descriptor.danger "${descriptor.danger}" is invalid (must be one of: ${[
            ...PLUGIN_ACTION_DANGERS,
          ].join(", ")})`
        );
      }
      const existing = registeredActions.findIndex((r) => r.descriptor.id === descriptor.id);
      if (existing >= 0) {
        registeredActions[existing] = { descriptor, handler };
      } else {
        registeredActions.push({ descriptor, handler });
      }
      // Validation/registry mutation runs synchronously above (sync throws still
      // surface at the call site); only the return value is a resolved promise.
      return Promise.resolve();
    },
    registerHandler<TArgs = unknown, TResult = unknown>(
      channel: string,
      schemaOrHandler: PluginChannelSchema<TArgs, TResult> | PluginIpcHandler,
      handlerOrOptions?: PluginTypedIpcHandler<TArgs, TResult> | PluginHandlerOptions,
      _options?: PluginHandlerOptions
    ): Promise<void> {
      // The host's channel guard, thrown at the call as an in-process host
      // throws it: a colon collides with the `{pluginId}:{channel}` transport.
      // Production accepts an empty channel here, so only the colon and
      // non-string checks apply.
      if (isInvalidChannel(channel, true)) {
        throw new Error(`Plugin channel must not contain colons: ${String(channel)}`);
      }
      // Handle both overloads, each with an optional trailing options bag:
      // 1. registerHandler(channel, schema, handler, options?) — typed
      // 2. registerHandler(channel, handler, options?) — untyped
      if (typeof handlerOrOptions === "function" || typeof schemaOrHandler !== "function") {
        // Typed overload: schemaOrHandler is a schema, the third arg the typed handler.
        // The cast is necessary because PluginTypedIpcHandler is structurally compatible
        // with PluginIpcHandler and we're storing it in a untyped recording array.
        registeredHandlers.push({
          channel,
          handler: handlerOrOptions as unknown as PluginIpcHandler,
        });
      } else {
        registeredHandlers.push({
          channel,
          handler: schemaOrHandler as PluginIpcHandler,
        });
      }
      return Promise.resolve();
    },
    broadcastToRenderer(channel, payload) {
      // Mirror production's channel-format guard (#10617): a colon would collide
      // with the `plugin:{id}:{channel}` transport. Reject (not throw) so the
      // mock matches the host's Promise contract. Production allows an empty
      // broadcast channel, so only the colon/non-string checks apply here.
      if (isInvalidChannel(channel, true)) {
        return Promise.reject(
          new Error(
            `broadcastToRenderer: channel must be a string without colons: ${String(channel)}`
          )
        );
      }
      broadcastCalls.push({ channel, payload });
      return Promise.resolve();
    },
    postToPanel(channel, payload, panelId) {
      if (isInvalidChannel(channel, false)) {
        return Promise.reject(
          new Error(
            `postToPanel: channel must be a non-empty string without colons: ${String(channel)}`
          )
        );
      }
      if (panelId !== undefined && panelId !== null) {
        if (typeof panelId !== "string" || panelId.length === 0) {
          throw new Error(
            `postToPanel: panelId must be a non-empty string, null, or undefined: ${String(panelId)}`
          );
        }
      }
      postToPanelCalls.push({ channel, payload, panelId: panelId ?? null });
      return Promise.resolve();
    },
    hasListeners(channel) {
      return !unlistenedChannels.has(assertListenerChannel("hasListeners", channel));
    },
    onDidChangeListeners(channel, callback) {
      const name = assertListenerChannel("onDidChangeListeners", channel);
      if (typeof callback !== "function") {
        throw new Error("onDidChangeListeners: callback must be a function");
      }
      let subs = listenerSubs.get(name);
      if (!subs) {
        subs = new Set();
        listenerSubs.set(name, subs);
      }
      const registered = (hasListeners: boolean): void => callback(hasListeners);
      subs.add(registered);
      return () => {
        listenerSubs.get(name)?.delete(registered);
      };
    },
    registerForgeProvider(descriptor, impl) {
      // Mirrors PluginService.createHost L1738-L1817. Validation order matches
      // production: non-object descriptor, non-empty string id, non-object impl.
      // The manifest-declared-id check is intentionally skipped — the mock has
      // no manifest model (see issue #9878). Re-registering the same id
      // replaces the prior binding (replace-by-id). The disposer's identity
      // guard compares the captured `impl` reference against the currently
      // active entry's `impl`, matching `unregisterForgeProviderImpl`'s
      // `expected` argument: a stale disposer from a re-bound id is a no-op.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerForgeProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerForgeProvider: descriptor.id must be a non-empty string");
      }
      if (!impl || typeof impl !== "object") {
        throw new Error("registerForgeProvider: impl must be an object");
      }
      const contributionId = descriptor.id;
      const existing = registeredForgeProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredForgeProviders[existing] = { descriptor, impl };
      } else {
        registeredForgeProviders.push({ descriptor, impl });
      }
      let disposed = false;
      // Disposer captured synchronously (registry mutation already done above) —
      // only the return value is a resolved promise, never a deferred write.
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Identity guard: only remove if the currently active entry is still
        // the one this disposer was captured against. A re-registration with a
        // different impl invalidates the prior disposer (matches production).
        const i = registeredForgeProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredForgeProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    registerFileDecorationProvider(descriptor, impl) {
      // Mirrors PluginService.createHost L1818-L1875. Validation order matches
      // production: non-object descriptor, non-empty string id, impl must be
      // an object exposing `provideDecorations()`. The manifest-declared-id
      // check is intentionally skipped — the mock has no manifest model (see
      // issue #9878). Re-registering the same id replaces the prior binding
      // (replace-by-id). The disposer's identity guard mirrors
      // `unregisterFileDecorationProviderImpl`'s `expected` argument.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerFileDecorationProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerFileDecorationProvider: descriptor.id must be a non-empty string");
      }
      if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
        throw new Error("registerFileDecorationProvider: impl must expose provideDecorations()");
      }
      const contributionId = descriptor.id;
      const existing = registeredFileDecorationProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredFileDecorationProviders[existing] = { descriptor, impl };
      } else {
        registeredFileDecorationProviders.push({ descriptor, impl });
      }
      let disposed = false;
      // Disposer captured synchronously (registry mutation already done above).
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        // Identity guard: only remove if the currently active entry is still
        // the one this disposer was captured against. A re-registration with a
        // different impl invalidates the prior disposer (matches production).
        const i = registeredFileDecorationProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredFileDecorationProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    registerWorktreeSetupStep(stepId, handler) {
      // Validation order matches production. As for decoration providers, the
      // manifest-declared-id check is skipped: the mock has no manifest model.
      if (typeof stepId !== "string" || stepId.length === 0) {
        throw new Error("registerWorktreeSetupStep: stepId must be a non-empty string");
      }
      if (typeof handler !== "function") {
        throw new Error("registerWorktreeSetupStep: handler must be a function");
      }
      const existing = registeredWorktreeSetupSteps.findIndex((r) => r.stepId === stepId);
      if (existing >= 0) {
        registeredWorktreeSetupSteps[existing] = { stepId, handler };
      } else {
        registeredWorktreeSetupSteps.push({ stepId, handler });
      }
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const i = registeredWorktreeSetupSteps.findIndex(
          (r) => r.stepId === stepId && r.handler === handler
        );
        if (i >= 0) registeredWorktreeSetupSteps.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    registerSearchProvider(id, provider) {
      // Structural checks only; the mock has no manifest model (#9878), so an
      // id need not name a declared runtime provider here. Replace-by-id, with
      // an identity-guarded disposer, as in production.
      if (typeof id !== "string" || id.length === 0) {
        throw new Error("registerSearchProvider: id must be a non-empty string");
      }
      if (typeof provider !== "function") {
        throw new Error("registerSearchProvider: provider must be a function");
      }
      const existing = registeredSearchProviders.findIndex((r) => r.id === id);
      if (existing >= 0) registeredSearchProviders[existing] = { id, provider };
      else registeredSearchProviders.push({ id, provider });
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const i = registeredSearchProviders.findIndex(
          (r) => r.id === id && r.provider === provider
        );
        if (i >= 0) registeredSearchProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    async registerContextProvider(descriptor, impl) {
      // Structural checks in the host's order; the declared-id check is skipped
      // because the mock has no manifest model (#9878). Replace-by-id, with an
      // identity-guarded disposer, as in production.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerContextProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error("registerContextProvider: descriptor.id must be a non-empty string");
      }
      if (
        !impl ||
        typeof impl !== "object" ||
        typeof impl.search !== "function" ||
        typeof impl.resolve !== "function"
      ) {
        throw new Error("registerContextProvider: impl must expose search() and resolve()");
      }
      const providerId = descriptor.id;
      const existing = registeredContextProviders.findIndex((r) => r.descriptor.id === providerId);
      if (existing >= 0) registeredContextProviders[existing] = { descriptor, impl };
      else registeredContextProviders.push({ descriptor, impl });
      return () => {
        const i = registeredContextProviders.findIndex(
          (r) => r.descriptor.id === providerId && r.impl === impl
        );
        if (i >= 0) registeredContextProviders.splice(i, 1);
      };
    },
    registerService: (async (name: unknown, handlers: unknown) => {
      // Structural checks only; the declared-name and declared-method checks
      // are skipped because the mock has no manifest model (#9878).
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("registerService: name must be a non-empty string");
      }
      if (!handlers || typeof handlers !== "object") {
        throw new Error("registerService: handlers must be an object of functions");
      }
      const record: RegisteredServiceRecord = {
        name,
        handlers: handlers as Record<string, unknown>,
      };
      const bad = Object.keys(record.handlers).find(
        (method) => typeof record.handlers[method] !== "function"
      );
      if (bad !== undefined) throw new Error(`registerService: "${bad}" must be a function`);
      const existing = registeredServices.findIndex((r) => r.name === name);
      if (existing >= 0) registeredServices[existing] = record;
      else registeredServices.push(record);
      return () => {
        const i = registeredServices.indexOf(record);
        if (i >= 0) registeredServices.splice(i, 1);
      };
    }) as PluginHostApi["registerService"],
    registerWorktreeDeleteNotesProvider(descriptor, impl) {
      // Structural checks in production's order. The manifest-declared-id
      // check is skipped: the mock has no manifest model (#9878). Re-registering
      // an id replaces the binding, and the replaced one's disposer is inert.
      if (!descriptor || typeof descriptor !== "object") {
        throw new Error("registerWorktreeDeleteNotesProvider: descriptor must be an object");
      }
      if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
        throw new Error(
          "registerWorktreeDeleteNotesProvider: descriptor.id must be a non-empty string"
        );
      }
      if (!impl || typeof impl !== "object" || typeof impl.provideNotes !== "function") {
        throw new Error("registerWorktreeDeleteNotesProvider: impl must expose provideNotes()");
      }
      const contributionId = descriptor.id;
      const existing = registeredWorktreeDeleteNotesProviders.findIndex(
        (r) => r.descriptor.id === contributionId
      );
      if (existing >= 0) {
        registeredWorktreeDeleteNotesProviders[existing] = { descriptor, impl };
      } else {
        registeredWorktreeDeleteNotesProviders.push({ descriptor, impl });
      }
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        const i = registeredWorktreeDeleteNotesProviders.findIndex(
          (r) => r.descriptor.id === contributionId && r.impl === impl
        );
        if (i >= 0) registeredWorktreeDeleteNotesProviders.splice(i, 1);
      };
      return Promise.resolve(dispose);
    },
    mcp: {
      registerTools(endpointId, tools) {
        // Structural checks only. The mock has no manifest model (#9878), so the
        // `mcp:expose` and declared-endpoint gates are skipped, and the roster
        // budget (tool count, name grammar, description and schema sizes) is
        // enforced by the real host rather than duplicated here. Re-registering
        // an endpoint replaces its roster; a replaced roster's disposer is inert.
        if (typeof endpointId !== "string" || endpointId.length === 0) {
          throw new Error("mcp.registerTools: endpointId must be a non-empty string");
        }
        if (!tools || typeof tools !== "object") {
          throw new Error("mcp.registerTools: tools must be an object keyed by tool name");
        }
        for (const [name, tool] of Object.entries(tools)) {
          if (!tool || typeof tool !== "object" || typeof tool.execute !== "function") {
            throw new Error(`mcp.registerTools: tool "${name}" must provide an execute() function`);
          }
        }
        const record: RegisteredMcpToolsRecord = { endpointId, tools };
        const existing = registeredMcpTools.findIndex((r) => r.endpointId === endpointId);
        if (existing >= 0) {
          registeredMcpTools[existing] = record;
        } else {
          registeredMcpTools.push(record);
        }
        let disposed = false;
        const dispose = () => {
          if (disposed) return;
          disposed = true;
          const i = registeredMcpTools.indexOf(record);
          if (i >= 0) registeredMcpTools.splice(i, 1);
        };
        return Promise.resolve(dispose);
      },
    },
    invalidateFileDecorations(scope, paths) {
      // Mirror production's non-empty-scope guard (#10617): reject (not throw),
      // matching the host's Promise contract. The declared-scope gate production
      // also applies is intentionally skipped — the mock has no manifest model
      // (#9878), so it can't know which scopes a plugin declared.
      if (typeof scope !== "string" || scope.length === 0) {
        return Promise.reject(
          new Error("invalidateFileDecorations: scope must be a non-empty string")
        );
      }
      invalidationCalls.push({ scope, paths });
      return Promise.resolve();
    },
    async dispatch(actionId, args, dispatchOptions) {
      dispatchedActions.push(
        dispatchOptions === undefined
          ? { actionId, args }
          : { actionId, args, options: dispatchOptions }
      );
      const override = dispatchOverrides.get(actionId);
      if (override) return recordMockLaunch(actionId, args, override);
      if (options.dispatch) {
        return recordMockLaunch(
          actionId,
          args,
          await (dispatchOptions === undefined
            ? options.dispatch(actionId, args)
            : options.dispatch(actionId, args, dispatchOptions))
        );
      }
      // Match the real host's contract: dispatch ids are always fully
      // namespaced as `{pluginId}.{descriptor.id}`. Looking up by the full
      // form means a plugin calling `host.dispatch("greet")` against a
      // registered action also id'd `"greet"` returns NOT_FOUND in the mock
      // exactly as it would in production where ActionService never sees an
      // unprefixed id.
      const reg = registeredActions.find((r) => actionId === `${pluginId}.${r.descriptor.id}`);
      if (!reg) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: `Action not found: ${actionId}` },
        };
      }
      try {
        const result = await reg.handler(args);
        return { ok: true, result };
      } catch (err) {
        return {
          ok: false,
          error: {
            code: "EXECUTION_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
    actions: {
      // Backed by the catalog seeded via `seedActionCatalog`. With no seed the
      // catalog is empty — `list()` resolves `[]`, `get()` resolves `null`, and
      // `canDispatch()` resolves `"restricted"`, matching an unloaded plugin.
      async list() {
        return Array.from(actionCatalog.values());
      },
      async get(actionId) {
        return actionCatalog.get(actionId) ?? null;
      },
      async canDispatch(actionId): Promise<PluginCanDispatchResult> {
        const entry = actionCatalog.get(actionId);
        // Mirror production: unknown/absent → "restricted", danger "safe" → "ok",
        // danger "confirm" → "confirm" (dispatch would reject it), anything else
        // (e.g. a "restricted" entry that slipped in) → "restricted".
        if (!entry) return "restricted";
        if (entry.danger === "safe") return "ok";
        if (entry.danger === "confirm") return "confirm";
        return "restricted";
      },
    },
    registeredActions,
    registeredHandlers,
    broadcastCalls,
    postToPanelCalls,
    dispatchedActions,
    registeredForgeProviders,
    registeredFileDecorationProviders,
    registeredWorktreeSetupSteps,
    registeredSearchProviders,
    registeredContextProviders,
    registeredServices,
    registeredWorktreeDeleteNotesProviders,
    registeredMcpTools,
    invalidationCalls,
    simulateListenersChange(channel, hasListeners) {
      const was = !unlistenedChannels.has(channel);
      if (hasListeners) unlistenedChannels.delete(channel);
      else unlistenedChannels.add(channel);
      if (was === hasListeners) return;
      for (const cb of [...(listenerSubs.get(channel) ?? [])]) cb(hasListeners);
    },
    setDispatchResult(actionId, result) {
      dispatchOverrides.set(actionId, result);
    },
    seedActionCatalog(entries) {
      actionCatalog.clear();
      for (const entry of entries) actionCatalog.set(entry.id, entry);
    },
  };

  return {
    members,
    recordDispatch: (record) => {
      dispatchedActions.push(record);
    },
  };
}
