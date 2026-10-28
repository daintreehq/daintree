// What a dev worker contributes to the host (#14332): actions, IPC handlers,
// renderer pushes and panel surfaces, and the providers, services, MCP rosters,
// setup steps and search providers whose implementations live in the worker.
// Each provider is a thin proxy that round-trips its calls back over the port;
// this module owns their disposers, retired with the generation that bound them.

import { AGENT_MCP_MAX_RESULT_BYTES } from "../../../../shared/types/plugin.js";
import type {
  PluginMcpToolDefinition,
  PluginSearchProvider,
  PluginSearchResult,
  PluginWorktreeDeleteNote,
  PluginWorktreeSetupStepContext,
  PluginWorktreeSnapshot,
} from "../../../../shared/types/plugin.js";
import { PLUGIN_SERVICE_MAX_METHODS } from "../../../../shared/config/pluginBudgets.js";
import { SEARCH_PROVIDER_MAX_RESPONSE_BYTES } from "../../../../shared/config/pluginSearchProviders.js";
import type { FileDecoration, FileDecorationProviderImpl } from "../../../../shared/types/forge.js";
import type {
  ContextProviderContent,
  ContextProviderImpl,
  ContextProviderItem,
} from "../../../../shared/types/pluginContextProvider.js";
import type {
  BroadcastToRendererParams,
  InvalidateFileDecorationsParams,
  PluginHostNotifyMethod,
  PluginWorkerSubscriptionKind,
  PostToPanelParams,
  RegisterActionParams,
  RegisterContextProviderParams,
  RegisterFileDecorationProviderParams,
  RegisterHandlerParams,
  RegisterMcpToolsParams,
  RegisterServiceParams,
  RegisterWorktreeDeleteNotesProviderParams,
  SearchProviderRegistrationParams,
  SetPanelBadgeParams,
  SetPanelMenuItemsParams,
  SetToolbarButtonBadgeParams,
  UnregisterContextProviderParams,
  UnregisterFileDecorationProviderParams,
  UnregisterMcpToolsParams,
  UnregisterServiceParams,
  UnregisterWorktreeDeleteNotesProviderParams,
  WorktreeSetupStepRegistrationParams,
} from "../../../../shared/types/pluginDevWorker.js";
import type { PluginIpcContext } from "../../../../shared/types/plugin.js";
import type { PluginServiceCallContext } from "../../../../shared/types/pluginServices.js";
import { createLogger } from "../../../utils/logger.js";
import { invokeSignalFor } from "../pluginInvokeDeadline.js";
import { observePluginPushListeners } from "../pluginInternalApprovers.js";
import { PluginServiceUnavailableError } from "../pluginServiceInvocation.js";
import type {
  DevWorkerBridgeContext,
  HostNotifyHandler,
  SubscribeHandler,
} from "./bridgeContext.js";

const logger = createLogger("main:PluginDevWorkerBridge");

/**
 * A worker tool result arrives as the JSON text the worker serialized. The size
 * is checked before parsing, so a worker cannot make main build a value larger
 * than the result budget; everything downstream then handles plain JSON data.
 */
function parseWorkerToolResult(result: unknown): unknown {
  if (typeof result !== "string") {
    throw new Error("plugin worker returned a tool result that is not serialized JSON");
  }
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes > AGENT_MCP_MAX_RESULT_BYTES) {
    throw new Error(
      `the tool result is ${bytes} bytes, over the ${AGENT_MCP_MAX_RESULT_BYTES}-byte limit for plugin tool results`
    );
  }
  return JSON.parse(result) as unknown;
}

/** A runtime search provider's answer, which the worker sends as one JSON string. */
function parseWorkerSearchResult(result: unknown): unknown {
  if (typeof result !== "string") {
    throw new Error("plugin worker returned search results that are not serialized JSON");
  }
  if (Buffer.byteLength(result, "utf8") > SEARCH_PROVIDER_MAX_RESPONSE_BYTES) {
    throw new Error(
      `the search results are over the ${SEARCH_PROVIDER_MAX_RESPONSE_BYTES}-byte limit for one answer`
    );
  }
  return JSON.parse(result) as unknown;
}

export class ContributionsDomain {
  constructor(private readonly ctx: DevWorkerBridgeContext) {}

  /** Disposers for providers (file decoration, and context providers under a
   * `context:` key) the worker registered on the real host, keyed by provider
   * id. Torn down on reload and dispose so a reloaded generation re-registers
   * cleanly. */
  private readonly providerDisposers = new Map<string, () => void>();
  /** The same for worktree delete notes providers (#13805). Kept apart from
   * decoration providers so the two kinds can share an id. */
  private readonly worktreeDeleteNotesDisposers = new Map<string, () => void>();
  /** Disposers for the `agentMcp` rosters the worker bound, keyed by endpoint id.
   * Retired with the generation like providers: the roster's `execute`s live in
   * the outgoing worker, and the replacement re-registers its own on activate. */
  private readonly mcpRosterDisposers = new Map<string, () => void>();
  /** Disposers for the worktree setup step handlers the worker bound, keyed by
   * step id. Retired with the generation like providers. */
  private readonly setupStepDisposers = new Map<string, () => void>();
  /** Disposers for the quick switcher search providers the worker bound, keyed by
   * provider id. Kept apart from {@link providerDisposers}: a decoration provider
   * and a search provider may share an id. Retired with the generation too. */
  private readonly searchProviderDisposers = new Map<string, () => void>();

  readonly notifications = {
    registerAction: async (params) => {
      const { descriptor } = params as RegisterActionParams;
      const namespacedId = `${this.ctx.pluginId}.${descriptor.id}`;
      // The host registers synchronously and resolves; await so a deep-
      // validation rejection routes to the register-error channel.
      await this.ctx.host.registerAction(descriptor, (args) =>
        this.ctx.invoke({ kind: "action", namespacedId, args })
      );
      return;
    },
    registerHandler: async (params) => {
      const p = params as RegisterHandlerParams;
      if (p.hasSchema && p.requires && p.requires.length > 0) {
        // Fail-closed capability gate — the untyped wrapper we register on the
        // host doesn't carry the schema's `requires`, so enforce it here to
        // match the typed overload's contract.
        const declared = new Set(this.ctx.getCapabilities());
        const missing = p.requires.filter((cap) => !declared.has(cap));
        if (missing.length > 0) {
          throw new Error(
            `PERMISSION_REQUIRED: channel "${p.channel}" requires capabilities not declared in the manifest: ${missing.join(", ")}`
          );
        }
      }
      // The deadline wrapper main installs around this handler hands its
      // signal over beside the context; aborting it cancels the worker invoke.
      const handler = (ctx: PluginIpcContext, ...args: unknown[]) =>
        this.ctx.invoke({ kind: "handler", channel: p.channel, ctx, args }, invokeSignalFor(ctx));
      if (p.timeoutMs !== undefined) {
        await this.ctx.host.registerHandler(p.channel, handler, { timeoutMs: p.timeoutMs });
      } else {
        await this.ctx.host.registerHandler(p.channel, handler);
      }
      return;
    },
    broadcastToRenderer: async (params) => {
      const p = params as BroadcastToRendererParams;
      await this.ctx.host.broadcastToRenderer(p.channel, p.payload);
      return;
    },
    postToPanel: async (params) => {
      const p = params as PostToPanelParams;
      await this.ctx.host.postToPanel(p.channel, p.payload, p.panelId);
      return;
    },
    invalidateFileDecorations: async (params) => {
      const p = params as InvalidateFileDecorationsParams;
      await this.ctx.host.invalidateFileDecorations(p.scope, p.paths);
      return;
    },
    setPanelBadge: async (params) => {
      const p = params as SetPanelBadgeParams;
      await this.ctx.host.setPanelBadge(p.panelId, p.badge);
      return;
    },
    setToolbarButtonBadge: async (params) => {
      const p = params as SetToolbarButtonBadgeParams;
      await this.ctx.host.setToolbarButtonBadge(p.buttonId, p.badge);
      return;
    },
    setPanelMenuItems: async (params) => {
      const p = params as SetPanelMenuItemsParams;
      await this.ctx.host.setPanelMenuItems(p.panelId, p.items);
      return;
    },
    registerFileDecorationProvider: async (params) => {
      const { descriptor } = params as RegisterFileDecorationProviderParams;
      const providerId = descriptor.id;
      // A re-register on the same id replaces the prior binding — dispose it
      // first so the host registry doesn't accumulate stale proxy impls.
      const prior = this.providerDisposers.get(providerId);
      if (prior) {
        try {
          prior();
        } catch {
          // best-effort
        }
      }
      // The impl lives in the worker; register a thin proxy whose single
      // method round-trips each call back over the port (mirrors the action
      // wrapper). `provideDecorations` is async, so this composes cleanly.
      const proxyImpl: FileDecorationProviderImpl = {
        provideDecorations: (scope: string, paths: string[]) =>
          this.ctx.invoke({
            kind: "file-decoration-method",
            providerId,
            method: "provideDecorations",
            args: [scope, paths],
          }) as Promise<Record<string, FileDecoration>>,
      };
      const generation = this.ctx.generation();
      const dispose = await this.ctx.host.registerFileDecorationProvider(descriptor, proxyImpl);
      // The bridge may have been torn down (dispose) or reloaded while the host
      // registration was settling — don't leak the freshly bound provider past
      // the cleanup pass that already ran.
      if (this.ctx.isDisposed() || generation !== this.ctx.generation()) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return;
      }
      this.providerDisposers.set(providerId, dispose);
      return;
    },
    unregisterFileDecorationProvider: async (params) => {
      const { providerId } = params as UnregisterFileDecorationProviderParams;
      const dispose = this.providerDisposers.get(providerId);
      if (dispose) {
        this.providerDisposers.delete(providerId);
        dispose();
      }
      return;
    },
    registerWorktreeDeleteNotesProvider: async (params) => {
      const { descriptor } = params as RegisterWorktreeDeleteNotesProviderParams;
      const providerId = descriptor.id;
      const prior = this.worktreeDeleteNotesDisposers.get(providerId);
      if (prior) {
        try {
          prior();
        } catch {
          // best-effort
        }
      }
      // The impl lives in the worker. The host hands this proxy its deadline
      // as a second argument, so a missed deadline cancels the invoke rather
      // than leaving it pending until the worker answers.
      const proxyImpl = {
        provideNotes: (worktree: PluginWorktreeSnapshot, signal?: AbortSignal) =>
          this.ctx.invoke(
            { kind: "worktree-delete-notes", providerId, worktree },
            signal
          ) as Promise<PluginWorktreeDeleteNote[]>,
      };
      const generation = this.ctx.generation();
      const dispose = await this.ctx.host.registerWorktreeDeleteNotesProvider(
        descriptor,
        proxyImpl
      );
      if (this.ctx.isDisposed() || generation !== this.ctx.generation()) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return;
      }
      this.worktreeDeleteNotesDisposers.set(providerId, dispose);
      return;
    },
    unregisterWorktreeDeleteNotesProvider: async (params) => {
      const { providerId } = params as UnregisterWorktreeDeleteNotesProviderParams;
      const dispose = this.worktreeDeleteNotesDisposers.get(providerId);
      if (dispose) {
        this.worktreeDeleteNotesDisposers.delete(providerId);
        dispose();
      }
      return;
    },
    registerWorktreeSetupStep: async (params) => {
      const { stepId } = params as WorktreeSetupStepRegistrationParams;
      if (typeof stepId !== "string" || stepId.length === 0) {
        throw new Error("registerWorktreeSetupStep: stepId must be a non-empty string");
      }
      const prior = this.setupStepDisposers.get(stepId);
      if (prior) {
        try {
          prior();
        } catch {
          // best-effort
        }
      }
      // The handler lives in the worker. Its signal cannot cross the port, so
      // the wrapper forwards the context without it and cancels the invoke
      // when it aborts; the worker aborts a signal of its own in turn.
      const handler = ({ signal, ...context }: PluginWorktreeSetupStepContext) =>
        this.ctx
          .invoke({ kind: "worktree-setup-step", stepId, context }, signal)
          .then(() => undefined);
      const generation = this.ctx.generation();
      const dispose = await this.ctx.host.registerWorktreeSetupStep(stepId, handler);
      if (this.ctx.isDisposed() || generation !== this.ctx.generation()) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return;
      }
      this.setupStepDisposers.set(stepId, dispose);
      return;
    },
    unregisterWorktreeSetupStep: async (params) => {
      const { stepId } = params as WorktreeSetupStepRegistrationParams;
      const dispose = this.setupStepDisposers.get(stepId);
      if (dispose) {
        this.setupStepDisposers.delete(stepId);
        dispose();
      }
      return;
    },
    registerContextProvider: async (params) => {
      const { descriptor } = params as RegisterContextProviderParams;
      const providerId = descriptor.id;
      const key = `context:${providerId}`;
      const prior = this.providerDisposers.get(key);
      if (prior) {
        try {
          prior();
        } catch {
          // best-effort
        }
      }
      // Both methods round-trip to the worker under the caller's signal, so a
      // deadline the host enforces reaches the plugin as an abort.
      const proxyImpl: ContextProviderImpl = {
        search: (query, options) =>
          this.ctx.invoke(
            { kind: "context-provider-method", providerId, method: "search", args: [query] },
            options.signal
          ) as Promise<ContextProviderItem[]>,
        resolve: (itemId, options) =>
          this.ctx.invoke(
            { kind: "context-provider-method", providerId, method: "resolve", args: [itemId] },
            options.signal
          ) as Promise<ContextProviderContent | null>,
      };
      const generation = this.ctx.generation();
      const dispose = await this.ctx.host.registerContextProvider({ id: providerId }, proxyImpl);
      if (this.ctx.isDisposed() || generation !== this.ctx.generation()) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return;
      }
      this.providerDisposers.set(key, dispose);
      return;
    },
    unregisterContextProvider: async (params) => {
      const { providerId } = params as UnregisterContextProviderParams;
      const key = `context:${providerId}`;
      const dispose = this.providerDisposers.get(key);
      if (dispose) {
        this.providerDisposers.delete(key);
        dispose();
      }
      return;
    },
    registerService: async (params) => {
      const { name, methods } = params as RegisterServiceParams;
      // Bounded before anything is built from it; main then holds the set
      // to the manifest's declaration.
      if (
        typeof name !== "string" ||
        !Array.isArray(methods) ||
        methods.length > PLUGIN_SERVICE_MAX_METHODS ||
        methods.some((method) => typeof method !== "string")
      ) {
        throw new Error(`registerService: malformed registration for "${String(name)}"`);
      }
      const key = `service:${name}`;
      const prior = this.providerDisposers.get(key);
      if (prior) {
        try {
          prior();
        } catch {
          // best-effort
        }
      }
      // One proxy per method the worker bound. Main checks the set against
      // the manifest; each runs in the worker under the call's signal.
      const proxy: Record<string, (args: unknown, ctx: PluginServiceCallContext) => unknown> = {};
      for (const method of methods) {
        proxy[method] = (args, ctx) => {
          // A crash-respawned worker binds again from inside its own
          // activate(), while the instance still reads as activated: only a
          // generation that has committed its activation answers.
          if (this.ctx.activationPhase() !== "succeeded") {
            throw new PluginServiceUnavailableError(
              `the provider of "${name}" is starting again after a crash`
            );
          }
          return this.ctx.invoke(
            { kind: "service-method", serviceName: name, method, args, caller: ctx.caller },
            ctx.signal
          );
        };
      }
      const generation = this.ctx.generation();
      const dispose = await this.ctx.host.registerService(name, proxy);
      if (this.ctx.isDisposed() || generation !== this.ctx.generation()) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return;
      }
      this.providerDisposers.set(key, dispose);
      return;
    },
    unregisterService: async (params) => {
      const { name } = params as UnregisterServiceParams;
      const key = `service:${name}`;
      const dispose = this.providerDisposers.get(key);
      if (dispose) {
        this.providerDisposers.delete(key);
        dispose();
      }
      return;
    },
    "mcp.registerTools": async (params) => {
      const p = params as Partial<RegisterMcpToolsParams> | null | undefined;
      if (
        !p ||
        typeof p !== "object" ||
        typeof p.endpointId !== "string" ||
        !p.tools ||
        typeof p.tools !== "object"
      ) {
        throw new Error("mcp.registerTools: malformed roster");
      }
      const endpointId = p.endpointId;
      const wire = p.tools as Record<string, unknown>;
      const generation = this.ctx.generation();
      // Null prototype: the names are worker-chosen, and one spelled
      // `__proto__` must land as an own key for the host to reject by name
      // rather than silently re-parent this object.
      const tools = Object.create(null) as Record<string, PluginMcpToolDefinition>;
      for (const toolName of Object.keys(wire)) {
        const entry = wire[toolName];
        if (!entry || typeof entry !== "object") {
          throw new Error(`mcp.registerTools: tool "${toolName}" is malformed`);
        }
        // Checked here because the rebuild below would drop the field, and a
        // roster making a read-only claim must fail whole, as it does in-process.
        for (const key of ["readOnly", "readOnlyHint"]) {
          if (Object.hasOwn(entry, key)) {
            throw new Error(
              `mcp.registerTools: tool "${toolName}" ${key} is not allowed: only the host may mark a tool read-only`
            );
          }
        }
        const { description, inputSchema, outputSchema, annotations, group } = entry as Partial<
          RegisterMcpToolsParams["tools"][string]
        >;
        // Descriptor fields are handed to the host as the worker sent them —
        // the host's roster validation is the one check, for both paths.
        tools[toolName] = {
          description: description as string,
          inputSchema: inputSchema as PluginMcpToolDefinition["inputSchema"],
          ...(outputSchema !== undefined ? { outputSchema } : {}),
          ...(annotations !== undefined ? { annotations } : {}),
          ...(group !== undefined ? { group } : {}),
          execute: (args, caller, signal) => {
            // Fenced to the generation that registered it. Retirement unbinds
            // the roster, but a caller that looked it up just before can still
            // call in, and relaying that to the replacement — booting, its
            // proxy not built yet — would be dropped and hang until the
            // caller's own deadline.
            if (generation !== this.ctx.generation()) {
              return Promise.reject(
                new Error(
                  `Plugin "${this.ctx.pluginId}" worker restarted before tool "${toolName}" could run`
                )
              );
            }
            return this.ctx
              .invoke({ kind: "mcp-tool", endpointId, toolName, args, caller }, signal)
              .then(parseWorkerToolResult);
          },
        };
      }
      const dispose = await this.ctx.host.mcp.registerTools(endpointId, tools);
      if (this.ctx.isDisposed() || generation !== this.ctx.generation()) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return;
      }
      // Replace, then release the prior disposer: the host registry swaps the
      // roster atomically and makes the superseded disposer inert, so an agent
      // never sees the endpoint drop out between the two rosters.
      const prior = this.mcpRosterDisposers.get(endpointId);
      this.mcpRosterDisposers.set(endpointId, dispose);
      if (prior) {
        try {
          prior();
        } catch {
          // best-effort
        }
      }
      return;
    },
    registerSearchProvider: async (params) => {
      const { providerId } = params as SearchProviderRegistrationParams;
      if (typeof providerId !== "string" || providerId.length === 0) {
        throw new Error("registerSearchProvider: malformed provider id");
      }
      const generation = this.ctx.generation();
      // The function lives in the worker; this proxy asks it over the port and
      // forwards the caller's signal, so a superseded query is cancelled there.
      const proxy: PluginSearchProvider = (query, context) => {
        // Fenced to the generation that registered it, as MCP tools are: a
        // replacement worker hasn't bound its own provider yet.
        if (generation !== this.ctx.generation()) {
          return Promise.reject(
            new Error(`Plugin "${this.ctx.pluginId}" worker restarted before the search could run`)
          );
        }
        return this.ctx
          .invoke(
            {
              kind: "search-provider",
              providerId,
              query,
              context: { mode: context.mode, limit: context.limit },
            },
            context.signal
          )
          .then(parseWorkerSearchResult) as Promise<PluginSearchResult[]>;
      };
      const dispose = await this.ctx.host.registerSearchProvider(providerId, proxy);
      if (this.ctx.isDisposed() || generation !== this.ctx.generation()) {
        try {
          dispose();
        } catch {
          // best-effort
        }
        return;
      }
      const prior = this.searchProviderDisposers.get(providerId);
      this.searchProviderDisposers.set(providerId, dispose);
      // The registry's own disposer is identity-checked, so releasing the
      // superseded binding after the swap can't drop the new one.
      if (prior) {
        try {
          prior();
        } catch {
          // best-effort
        }
      }
      return;
    },
    unregisterSearchProvider: async (params) => {
      const { providerId } = params as SearchProviderRegistrationParams;
      const dispose = this.searchProviderDisposers.get(providerId);
      if (dispose) {
        this.searchProviderDisposers.delete(providerId);
        dispose();
      }
      return;
    },
    "mcp.unregisterTools": async (params) => {
      const { endpointId } = params as UnregisterMcpToolsParams;
      const dispose = this.mcpRosterDisposers.get(endpointId);
      if (dispose) {
        this.mcpRosterDisposers.delete(endpointId);
        dispose();
      }
      return;
    },
  } satisfies Partial<Record<PluginHostNotifyMethod, HostNotifyHandler>>;

  readonly subscriptions = {
    "push-listeners": async (msg, push) => {
      const channel = msg.key;
      if (!channel) {
        logger.warn(`[${this.ctx.pluginId}] push-listeners subscribe missing key`);
        return undefined;
      }
      const { hasListeners, onDidChangeListeners } = this.ctx.host;
      if (!hasListeners || !onDidChangeListeners) {
        push(true);
        return undefined;
      }
      // Watch first, then send the current value, so no change can fall
      // between the two. The worker ignores a value it already holds.
      const dispose = onDidChangeListeners.call(this.ctx.host, channel, (has) => push(has));
      push(hasListeners.call(this.ctx.host, channel));
      return dispose;
    },
    "push-listeners-observe": async (msg, push) => {
      const channel = msg.key;
      if (!channel) {
        logger.warn(`[${this.ctx.pluginId}] push-listeners-observe subscribe missing key`);
        return undefined;
      }
      // Untracked by idle governance (see `observePluginPushListeners`); this
      // bridge's own subscription cleanup is what releases it.
      const observation = observePluginPushListeners(this.ctx.host, channel, (has) => push(has));
      if (!observation) {
        push(true);
        return undefined;
      }
      push(observation.current);
      return observation.dispose;
    },
  } satisfies Partial<Record<PluginWorkerSubscriptionKind, SubscribeHandler>>;

  /** Tear down every provider and MCP roster the worker registered on the real host. */
  disposeProviders(): void {
    for (const dispose of [
      ...this.providerDisposers.values(),
      ...this.worktreeDeleteNotesDisposers.values(),
      ...this.mcpRosterDisposers.values(),
      ...this.setupStepDisposers.values(),
      ...this.searchProviderDisposers.values(),
    ]) {
      try {
        dispose();
      } catch {
        // best-effort
      }
    }
    this.providerDisposers.clear();
    this.worktreeDeleteNotesDisposers.clear();
    this.mcpRosterDisposers.clear();
    this.setupStepDisposers.clear();
    this.searchProviderDisposers.clear();
  }
}
