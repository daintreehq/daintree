import type {
  PluginServiceCallContext,
  PluginServiceProvideContribution,
  PluginServicesApi,
} from "../../../shared/types/pluginServices.js";
import { isChannelSchema } from "./PluginChannelRegistry.js";
import { abortErrorFor } from "./pluginAbortError.js";
import { type PluginWorktreeSetupStepHandler } from "../../../shared/types/plugin.js";
import { agentMcpEndpointRegistry } from "../pluginAgentMcp/endpointRegistry.js";
import { validateAgentMcpTools } from "../pluginAgentMcp/validateTools.js";
import type { AgentMcpToolInvoker } from "../pluginAgentMcp/types.js";

import {
  registerForgeProviderImpl,
  unregisterForgeProviderImpl,
  validateForgeImplRoles,
} from "../forgeProviderRegistry.js";
import { buildStoredCredentials } from "../forge/forgeCredentialUtils.js";
import {
  registerFileDecorationProviderImpl,
  unregisterFileDecorationProviderImpl,
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
import { resolveInvokeTimeoutMs, runWithInvokeDeadline } from "./pluginInvokeDeadline.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { makeForgeProviderId } from "../../../shared/utils/forgeProviderIds.js";
import { forgeProviderRoles } from "../../../shared/utils/forgeProviderRoles.js";
import type {
  PluginIpcHandler,
  PluginHostApi,
  PluginChannelSchema,
  PluginHandlerOptions,
  PluginIpcContext,
  PluginTypedIpcHandler,
  PluginHostBinding,
  PluginMcpCaller,
  PluginMcpToolDefinition,
} from "../../../shared/types/plugin.js";
import { type PluginHostFactoryDeps, trackPluginDisposer } from "./pluginHostDeps.js";
import type { PluginEventScope } from "./pluginEventScope.js";

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

/** What the contribution surface reads from `createHost`. */
export interface PluginHostContributionsContext {
  readonly boundPlugin: PluginEventScope["boundPlugin"];
  readonly boundProjectId: PluginHostBinding["projectId"];
  readonly deps: Pick<
    PluginHostFactoryDeps,
    | "actionValidators"
    | "broadcaster"
    | "declaredCapabilities"
    | "pluginActionHandlers"
    | "pluginActionOwners"
    | "pluginActions"
    | "pluginEventCleanups"
    | "plugins"
    | "registerHandler"
    | "services"
    | "validateAndBuildActionDescriptor"
  >;
  readonly isBound: PluginEventScope["isBound"];
  /** True once `activate()` has returned; activation-only registrations refuse after it. */
  readonly isRevoked: () => boolean;
  readonly pluginId: string;
}

/**
 * The host's registrations (actions, channel handlers, providers, services,
 * agent MCP tools) and its calls into other plugins' services.
 */
export function buildContributionsHostApi(
  ctx: PluginHostContributionsContext
): Pick<
  PluginHostApi,
  | "registerAction"
  | "registerHandler"
  | "registerForgeProvider"
  | "registerFileDecorationProvider"
  | "registerWorktreeDeleteNotesProvider"
  | "registerWorktreeSetupStep"
  | "registerSearchProvider"
  | "registerContextProvider"
  | "registerService"
  | "mcp"
  | "services"
> {
  const { boundPlugin, boundProjectId, deps, isBound, isRevoked, pluginId } = ctx;
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

  // The live disposer per `agentMcp` endpoint, so a replaced roster is released
  // rather than kept reachable from the unload cascade for the host's lifetime.
  const mcpRosterDisposers = new Map<string, () => void>();

  return {
    registerAction: (descriptor, handler) => {
      if (isRevoked()) {
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
      if (isRevoked()) {
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
    registerForgeProvider: (descriptor, impl) => {
      if (isRevoked()) {
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
      if (isRevoked()) {
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
      if (isRevoked()) {
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
      if (isRevoked()) {
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
      if (isRevoked()) {
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
      if (isRevoked()) {
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
      if (isRevoked()) {
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
        if (isRevoked()) {
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
  };
}
