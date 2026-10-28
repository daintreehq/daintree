// Contribution registrations for the dev worker's host proxy (#9304, #14331):
// actions, IPC handlers, providers, services and agent MCP rosters, plus the
// inbound side that runs them when main invokes one. The handlers stay HERE in
// the worker, so a reload (whole-worker respawn) discards them cleanly.
//
// Fidelity note: the real in-process host throws synchronously from
// `registerAction`/`registerHandler` during `activate()`. Over IPC, deep
// validation happens in main *after* the proxy call returns, so the proxy
// re-runs the host's structural checks locally (object/function/id shape) to
// preserve synchronous authoring feedback; deeper rejections (id format,
// capability gate) arrive asynchronously as a `register-error` and are logged
// loudly rather than thrown.

import type {
  ActionHandler,
  PluginChannelSchema,
  PluginHostApi,
  PluginIpcContext,
  PluginIpcHandler,
  PluginMcpToolDefinition,
  PluginTypedIpcHandler,
  PluginHandlerOptions,
  PluginWorktreeSetupStepHandler,
  PluginSearchProvider,
  WorktreeDeleteNotesProviderDescriptor,
  WorktreeDeleteNotesProviderImpl,
} from "../../../shared/types/plugin.js";
import { SEARCH_PROVIDER_MAX_RESPONSE_BYTES } from "../../../shared/config/pluginSearchProviders.js";
import { pathToFileURL } from "node:url";
import type {
  FileDecorationProviderDescriptor,
  FileDecorationProviderImpl,
  ForgeProviderDescriptor,
  ForgeProviderImpl,
} from "../../../shared/types/forge.js";
import type {
  ContextProviderDescriptor,
  ContextProviderImpl,
} from "../../../shared/types/pluginContextProvider.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { validatePluginWorktreeDeleteNotes } from "../../../shared/utils/pluginWorktreeDeleteNotes.js";
import { AGENT_MCP_MAX_RESULT_BYTES } from "../../../shared/types/plugin.js";
import { withTimeout } from "../../utils/withTimeout.js";
import { actionHandlerArityHint, appendHandlerHint } from "./pluginHandlerHints.js";
import {
  PLUGIN_INVOKE_MAX_RESULT_BYTES,
  PLUGIN_SERVICE_MAX_RESULT_BYTES,
} from "../../../shared/config/pluginBudgets.js";
import type { PluginServiceCallContext } from "../../../shared/types/pluginServices.js";
import { PluginPayloadTooLargeError, estimatePayloadBytes } from "./pluginPayloadLimits.js";
import { resolveInvokeTimeoutMs } from "./pluginInvokeDeadline.js";
import { validateAgentMcpTools } from "../pluginAgentMcp/validateTools.js";
import type {
  PluginHostToWorkerMessage,
  RegisterMcpToolsParams,
} from "../../../shared/types/pluginDevWorker.js";
import type { HostProxyFacetDeps, PluginDevWorkerRpc } from "./pluginDevWorkerRpcClient.js";
interface RegisteredHandler {
  handler: PluginIpcHandler | PluginTypedIpcHandler<unknown, unknown>;
  schema?: PluginChannelSchema<unknown, unknown>;
}

/** One tool of a bound roster, captured at registration like the host captures it. */
interface RegisteredMcpTool {
  definition: PluginMcpToolDefinition;
  execute: PluginMcpToolDefinition["execute"];
}

/**
 * Budget for importing one manifest command's handler module (#12274). Matches
 * the `IMPORT_TIMEOUT_MS` that bounded this import back when it ran in main, so
 * moving the import out of the main process doesn't silently drop the bound: a
 * handler module with a hanging top-level await must fail its dispatch rather
 * than pin a pending invoke forever.
 */
const COMMAND_IMPORT_TIMEOUT_MS = 5000;

export type ContributionHostApi = Pick<
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
>;

export class PluginDevWorkerContributionFacet {
  readonly api: ContributionHostApi;
  private readonly rpc: PluginDevWorkerRpc;
  private readonly pluginId: string;
  private readonly assertActivationOpen: (name: string) => void;
  private readonly actionHandlers = new Map<string, ActionHandler>();
  private readonly ipcHandlers = new Map<string, RegisteredHandler>();
  private readonly fileDecorationProviders = new Map<string, FileDecorationProviderImpl>();
  /** Keyed by id. The entry object is the registration's identity, so a disposer
   * only unbinds its own registration even when the same impl was registered twice. */
  private readonly worktreeDeleteNotesProviders = new Map<
    string,
    { impl: WorktreeDeleteNotesProviderImpl }
  >();
  /** Quick switcher search providers bound with `host.registerSearchProvider`, by provider id.
   * The record object per registration is its identity, so a disposer only ever
   * unbinds the registration it came from, even when a later one reused the function. */
  private readonly searchProviders = new Map<string, { provider: PluginSearchProvider }>();
  private readonly contextProviders = new Map<string, ContextProviderImpl>();
  /** Signals handed to in-flight context provider calls, keyed by invoke requestId,
   * so a main-side `invoke-cancel` (its deadline passed) reaches the plugin. */
  private readonly contextProviderAborts = new Map<string, AbortController>();
  /** Services bound with `host.registerService`, by name. The record object per
   * registration is its identity, so a disposer only unbinds its own. */
  private readonly services = new Map<string, { handlers: Record<string, unknown> }>();
  /** Signals handed to in-flight service methods, keyed by invoke requestId, so a
   * main-side `invoke-cancel` (the caller stopped waiting) reaches the plugin. */
  private readonly serviceInvokeAborts = new Map<string, AbortController>();
  /** Bound `agentMcp` rosters, keyed by endpoint id. The map object per roster
   * is its identity: a disposer only unbinds the roster it was handed for. */
  private readonly mcpRosters = new Map<string, Map<string, RegisteredMcpTool>>();
  /** Signals handed to in-flight `mcp-tool` executes and `search-provider` calls,
   * keyed by invoke requestId, so a main-side `invoke-cancel` reaches the plugin. */
  private readonly mcpInvokeAborts = new Map<string, AbortController>();
  /** Bound `worktreeSetupSteps` handlers, keyed by step id. Each registration
   * is its own binding object, so a disposer owns exactly the one it made even
   * when a later registration reuses the same callback. */
  private readonly worktreeSetupSteps = new Map<
    string,
    { readonly handler: PluginWorktreeSetupStepHandler }
  >();
  /** Signals handed to in-flight `worktree-setup-step` handlers, keyed by invoke
   * requestId, so a main-side `invoke-cancel` reaches the handler. */
  private readonly setupStepInvokeAborts = new Map<string, AbortController>();
  /**
   * Non-MCP invokes still running, and whether main has since cancelled each
   * (its deadline passed). A cancelled invoke's handler cannot be interrupted,
   * but its result is no longer awaited, so it is never cloned back to main.
   */
  private readonly runningInvokes = new Map<string, { cancelled: boolean }>();
  /**
   * Manifest command handlers (#12274), keyed by the file URL of the module
   * main resolved. Holds the in-flight IMPORT promise, not the settled handler,
   * so concurrent first dispatches of the same command share one import instead
   * of racing two. A rejection is evicted rather than cached: a timeout is
   * transient, and the main-process loader this replaces never cached failures
   * either. Cleared on dispose — though the real reclamation of the imported
   * module's state is the worker exiting, not this map.
   */
  private readonly commandModules = new Map<string, Promise<ActionHandler>>();

  constructor(deps: HostProxyFacetDeps) {
    this.rpc = deps.rpc;
    this.pluginId = deps.pluginId;
    this.assertActivationOpen = deps.assertActivationOpen;
    this.api = this.buildApi();
  }

  dispose(): void {
    this.actionHandlers.clear();
    this.ipcHandlers.clear();
    this.fileDecorationProviders.clear();
    this.worktreeDeleteNotesProviders.clear();
    this.searchProviders.clear();
    this.contextProviders.clear();
    for (const controller of this.contextProviderAborts.values()) controller.abort();
    this.contextProviderAborts.clear();
    this.services.clear();
    for (const controller of this.serviceInvokeAborts.values()) controller.abort();
    this.serviceInvokeAborts.clear();
    this.mcpRosters.clear();
    for (const controller of this.mcpInvokeAborts.values()) controller.abort();
    this.mcpInvokeAborts.clear();
    this.worktreeSetupSteps.clear();
    for (const controller of this.setupStepInvokeAborts.values()) controller.abort();
    this.setupStepInvokeAborts.clear();
    // Forgotten, not cancelled: an invoke settling after dispose still reports
    // (a command disposed mid-import answers with that error), but nothing
    // here keeps it alive.
    this.runningInvokes.clear();
    this.commandModules.clear();
  }

  /** Test seam: plain invokes whose result is still awaited. */
  runningInvokeCount(): number {
    return this.runningInvokes.size;
  }

  handleInvoke(msg: Extract<PluginHostToWorkerMessage, { type: "invoke" }>): void {
    if (msg.kind === "mcp-tool") void this.handleMcpToolInvoke(msg);
    else if (msg.kind === "worktree-setup-step") void this.handleSetupStepInvoke(msg);
    else if (msg.kind === "search-provider") void this.handleSearchProviderInvoke(msg);
    else void this.rpc.runInInvocation(msg.requestId, () => this.runInvoke(msg));
  }

  handleCancel(msg: Extract<PluginHostToWorkerMessage, { type: "invoke-cancel" }>): void {
    // Released here rather than when `execute` settles: a tool that ignores
    // its signal may never settle, and its entry must not outlive the call.
    // The invoke still holds the controller, so it still sees the abort and
    // posts nothing. A no-op once the execute settled.
    const controller =
      this.mcpInvokeAborts.get(msg.requestId) ??
      this.contextProviderAborts.get(msg.requestId) ??
      this.serviceInvokeAborts.get(msg.requestId);
    this.mcpInvokeAborts.delete(msg.requestId);
    this.contextProviderAborts.delete(msg.requestId);
    this.serviceInvokeAborts.delete(msg.requestId);
    controller?.abort();
    const setupStep = this.setupStepInvokeAborts.get(msg.requestId);
    this.setupStepInvokeAborts.delete(msg.requestId);
    setupStep?.abort();
    // Same for a plain invoke: the entry goes now, and the cancelled mark on
    // the object its settle closure holds makes a late result a no-op.
    const running = this.runningInvokes.get(msg.requestId);
    if (running) {
      running.cancelled = true;
      this.runningInvokes.delete(msg.requestId);
    }
  }

  /**
   * Run one `agentMcp` tool. Separate from {@link handleInvoke} because it is the
   * one kind main can cancel: the plugin's `execute` gets a signal aborted by a
   * matching `invoke-cancel`, and once that has happened nothing is posted back —
   * main settled the caller when it cancelled and would drop the result anyway.
   */
  private async handleMcpToolInvoke(
    msg: Extract<PluginHostToWorkerMessage, { type: "invoke"; kind: "mcp-tool" }>
  ): Promise<void> {
    const controller = new AbortController();
    this.mcpInvokeAborts.set(msg.requestId, controller);
    const settle = (
      outcome: { ok: true; result: unknown } | { ok: false; error: string }
    ): void => {
      if (controller.signal.aborted || this.rpc.disposed) return;
      try {
        this.rpc.post({ type: "invoke-result", requestId: msg.requestId, ...outcome });
      } catch (err) {
        // A post that fails anyway (the port closing mid-send) must still try
        // to settle main's pending call, as an error.
        this.rpc.post({
          type: "invoke-result",
          requestId: msg.requestId,
          ok: false,
          error: formatErrorMessage(err, "tool result could not be sent"),
        });
      }
    };
    try {
      const tool = this.mcpRosters.get(msg.endpointId)?.get(msg.toolName);
      if (!tool) {
        throw new Error(
          `No MCP tool "${msg.toolName}" registered for endpoint "${msg.endpointId}"`
        );
      }
      // Re-frozen on arrival for the same reason as panel-lifecycle events: the
      // port hands back a mutable copy of what main froze.
      const caller = Object.freeze({ ...msg.caller });
      const result: unknown = await Reflect.apply(tool.execute, tool.definition, [
        msg.args,
        caller,
        controller.signal,
      ]);
      // Serialized here, in the plugin's process, and sent as one string. The
      // agent receives JSON either way, so `toJSON` behaves as the author wrote
      // it; and a graph that only explodes when serialized (shared references
      // fan out) costs this worker its budget rather than stalling main.
      const json = JSON.stringify(result === undefined ? null : result);
      if (json === undefined) {
        throw new Error("the tool returned a value that cannot be serialized to JSON");
      }
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > AGENT_MCP_MAX_RESULT_BYTES) {
        throw new Error(
          `the tool result is ${bytes} bytes, over the ${AGENT_MCP_MAX_RESULT_BYTES}-byte limit for plugin tool results`
        );
      }
      settle({ ok: true, result: json });
    } catch (err) {
      settle({ ok: false, error: formatErrorMessage(err, "tool call failed") });
    } finally {
      if (this.mcpInvokeAborts.get(msg.requestId) === controller) {
        this.mcpInvokeAborts.delete(msg.requestId);
      }
    }
  }

  /**
   * Run one worktree setup step. Like {@link handleMcpToolInvoke}, the handler
   * gets a signal a matching `invoke-cancel` aborts — main's timeout, or the
   * worktree being deleted — and nothing is posted back once it has.
   */
  private async handleSetupStepInvoke(
    msg: Extract<PluginHostToWorkerMessage, { type: "invoke"; kind: "worktree-setup-step" }>
  ): Promise<void> {
    const controller = new AbortController();
    this.setupStepInvokeAborts.set(msg.requestId, controller);
    const settle = (outcome: { ok: true; result: null } | { ok: false; error: string }): void => {
      if (controller.signal.aborted || this.rpc.disposed) return;
      this.rpc.post({ type: "invoke-result", requestId: msg.requestId, ...outcome });
    };
    try {
      const handler = this.worktreeSetupSteps.get(msg.stepId)?.handler;
      if (!handler) {
        throw new Error(`No worktree setup step registered for "${msg.stepId}"`);
      }
      await handler(Object.freeze({ ...msg.context, signal: controller.signal }));
      settle({ ok: true, result: null });
    } catch (err) {
      settle({ ok: false, error: formatErrorMessage(err, "setup step failed") });
    } finally {
      if (this.setupStepInvokeAborts.get(msg.requestId) === controller) {
        this.setupStepInvokeAborts.delete(msg.requestId);
      }
    }
  }

  /**
   * Ask one quick switcher search provider (#13792). Cancellable like an
   * `mcp-tool`: the provider's signal aborts on a matching `invoke-cancel`, and
   * nothing is posted back after that. The answer is bounded and serialized
   * here, in the plugin's process, so an oversized one costs this worker.
   */
  private async handleSearchProviderInvoke(
    msg: Extract<PluginHostToWorkerMessage, { type: "invoke"; kind: "search-provider" }>
  ): Promise<void> {
    const controller = new AbortController();
    this.mcpInvokeAborts.set(msg.requestId, controller);
    const settle = (outcome: { ok: true; result: string } | { ok: false; error: string }): void => {
      if (controller.signal.aborted || this.rpc.disposed) return;
      this.rpc.post({ type: "invoke-result", requestId: msg.requestId, ...outcome });
    };
    try {
      const provider = this.searchProviders.get(msg.providerId)?.provider;
      if (!provider) throw new Error(`No search provider "${msg.providerId}" registered`);
      const results: unknown = await provider(msg.query, {
        mode: msg.context.mode,
        limit: msg.context.limit,
        signal: controller.signal,
      });
      const json = JSON.stringify(
        Array.isArray(results) ? results.slice(0, msg.context.limit) : (results ?? null)
      );
      if (json === undefined) {
        throw new Error("the provider returned a value that cannot be serialized to JSON");
      }
      if (Buffer.byteLength(json, "utf8") > SEARCH_PROVIDER_MAX_RESPONSE_BYTES) {
        throw new Error(
          `the provider's results are over the ${SEARCH_PROVIDER_MAX_RESPONSE_BYTES}-byte limit for one answer`
        );
      }
      settle({ ok: true, result: json });
    } catch (err) {
      settle({ ok: false, error: formatErrorMessage(err, "search failed") });
    } finally {
      if (this.mcpInvokeAborts.get(msg.requestId) === controller) {
        this.mcpInvokeAborts.delete(msg.requestId);
      }
    }
  }
  private async runInvoke(
    msg: Exclude<
      Extract<PluginHostToWorkerMessage, { type: "invoke" }>,
      { kind: "mcp-tool" } | { kind: "worktree-setup-step" } | { kind: "search-provider" }
    >
  ): Promise<void> {
    const running = { cancelled: false };
    this.runningInvokes.set(msg.requestId, running);
    // What a plugin:invoke result is named after; decoration results are not
    // plugin:invoke results and keep their own budget.
    const capTarget =
      msg.kind === "handler"
        ? msg.channel
        : msg.kind === "file-decoration-method" || msg.kind === "worktree-delete-notes"
          ? null
          : msg.kind === "context-provider-method"
            ? `context provider "${msg.providerId}"`
            : msg.kind === "service-method"
              ? `"${msg.serviceName}.${msg.method}"`
              : msg.namespacedId;
    const resultCap =
      msg.kind === "service-method"
        ? PLUGIN_SERVICE_MAX_RESULT_BYTES
        : PLUGIN_INVOKE_MAX_RESULT_BYTES;
    const settle = (
      outcome: { ok: true; result: unknown } | { ok: false; error: string }
    ): void => {
      if (this.runningInvokes.get(msg.requestId) === running) {
        this.runningInvokes.delete(msg.requestId);
      }
      if (running.cancelled) return;
      // Refused here, before the clone across the port, rather than only by
      // main's re-check after it has already paid for it.
      const resultBytes =
        outcome.ok && capTarget !== null ? estimatePayloadBytes(outcome.result, resultCap) : 0;
      if (outcome.ok && resultBytes > resultCap) {
        outcome = {
          ok: false,
          error: new PluginPayloadTooLargeError(
            this.pluginId,
            `result of "${capTarget}"`,
            resultCap,
            resultBytes
          ).message,
        };
      }
      if (outcome.ok) {
        this.rpc.post({
          type: "invoke-result",
          requestId: msg.requestId,
          ok: true,
          result: outcome.result,
        });
      } else {
        this.rpc.post({
          type: "invoke-result",
          requestId: msg.requestId,
          ok: false,
          error: outcome.error,
        });
      }
    };
    try {
      if (msg.kind === "action") {
        const handler = this.actionHandlers.get(msg.namespacedId);
        if (!handler) {
          throw new Error(`No action handler registered for "${msg.namespacedId}"`);
        }
        const result = await handler(msg.args);
        settle({ ok: true, result });
        return;
      }
      if (msg.kind === "command") {
        const handler = await this.loadCommandHandler(msg.namespacedId, msg.resolvedPath);
        // A dispose that landed while the module was importing means the plugin
        // is gone; running its handler now would let a torn-down generation take
        // effect. `dispose()` has already rejected every pending host call, so
        // the handler would fail on its first host API use anyway — fail here,
        // before any side effect.
        if (this.rpc.disposed) {
          throw new Error(`Plugin dev worker disposed before command "${msg.namespacedId}" ran`);
        }
        let result: unknown;
        try {
          result = await handler(msg.args);
        } catch (err) {
          // Arity hint (#12214) applied HERE, against the plugin's real closure.
          // Main only ever sees the synthetic RPC thunk, whose arity says nothing
          // about how the author wrote their handler, so appending the hint
          // main-side stopped working the moment this import moved off it.
          appendHandlerHint(err, actionHandlerArityHint(handler, err));
          throw err;
        }
        settle({ ok: true, result });
        return;
      }
      if (msg.kind === "file-decoration-method") {
        const impl = this.fileDecorationProviders.get(msg.providerId);
        if (!impl) {
          throw new Error(`No file decoration provider registered for "${msg.providerId}"`);
        }
        if (msg.method !== "provideDecorations") {
          throw new Error(`Unknown file decoration provider method "${msg.method}"`);
        }
        const [scope, paths] = msg.args as [string, string[]];
        const result = await impl.provideDecorations(scope, paths);
        settle({ ok: true, result });
        return;
      }
      if (msg.kind === "worktree-delete-notes") {
        const impl = this.worktreeDeleteNotesProviders.get(msg.providerId)?.impl;
        if (!impl) {
          throw new Error(`No worktree delete notes provider registered for "${msg.providerId}"`);
        }
        // Vetted here so only a bounded answer crosses the port; main vets it
        // again, being the side that decides what is shown.
        const vetted = validatePluginWorktreeDeleteNotes(await impl.provideNotes(msg.worktree));
        if (!vetted.ok) throw new Error(vetted.error);
        settle({ ok: true, result: vetted.notes });
        return;
      }
      if (msg.kind === "context-provider-method") {
        const impl = this.contextProviders.get(msg.providerId);
        if (!impl) {
          throw new Error(`No context provider registered for "${msg.providerId}"`);
        }
        const controller = new AbortController();
        this.contextProviderAborts.set(msg.requestId, controller);
        try {
          const [arg] = msg.args;
          const options = { signal: controller.signal };
          let result: unknown;
          try {
            if (msg.method === "search") result = await impl.search(arg, options);
            else if (msg.method === "resolve") result = await impl.resolve(arg, options);
            else throw new Error(`Unknown context provider method "${String(msg.method)}"`);
          } catch (err) {
            // Aborted by a cancel or by dispose: main has stopped waiting, so
            // whatever the plugin made of the abort is not sent.
            if (controller.signal.aborted) return;
            throw err;
          }
          if (controller.signal.aborted) return;
          settle({ ok: true, result });
        } finally {
          if (this.contextProviderAborts.get(msg.requestId) === controller) {
            this.contextProviderAborts.delete(msg.requestId);
          }
        }
        return;
      }
      if (msg.kind === "service-method") {
        const binding = this.services.get(msg.serviceName);
        const fn =
          binding && Object.hasOwn(binding.handlers, msg.method)
            ? binding.handlers[msg.method]
            : undefined;
        if (!binding || typeof fn !== "function") {
          throw new Error(`No method "${msg.method}" registered for service "${msg.serviceName}"`);
        }
        const controller = new AbortController();
        this.serviceInvokeAborts.set(msg.requestId, controller);
        try {
          const ctx: PluginServiceCallContext = {
            signal: controller.signal,
            caller: { pluginId: msg.caller.pluginId, projectId: msg.caller.projectId },
          };
          let result: unknown;
          try {
            result = await (fn as (args: unknown, ctx: PluginServiceCallContext) => unknown).call(
              binding.handlers,
              msg.args,
              ctx
            );
          } catch (err) {
            // Main has stopped waiting; what the plugin made of the abort isn't sent.
            if (controller.signal.aborted) return;
            throw err;
          }
          if (controller.signal.aborted) return;
          settle({ ok: true, result });
        } finally {
          if (this.serviceInvokeAborts.get(msg.requestId) === controller) {
            this.serviceInvokeAborts.delete(msg.requestId);
          }
        }
        return;
      }
      // kind === "handler"
      const entry = this.ipcHandlers.get(msg.channel);
      if (!entry) {
        throw new Error(`No handler registered for channel "${msg.channel}"`);
      }
      const result = await this.invokeIpcHandler(entry, msg.ctx, msg.args);
      settle({ ok: true, result });
    } catch (err) {
      settle({ ok: false, error: formatErrorMessage(err, "invocation failed") });
    }
  }

  /**
   * Import a manifest-declared command's handler module and return its default
   * export (#12274). `resolvedPath` is the absolute path main already probed
   * and containment-checked in `resolveCommandHandlerPath` — the worker takes
   * it as given rather than re-deriving it, so the two sides can never disagree
   * about which file a command maps to and the worker holds no second copy of
   * the command registry.
   */
  private loadCommandHandler(namespacedId: string, resolvedPath: string): Promise<ActionHandler> {
    const url = pathToFileURL(resolvedPath).href;
    const cached = this.commandModules.get(url);
    if (cached) return cached;
    const pending = withTimeout(
      import(url) as Promise<{ default?: unknown }>,
      COMMAND_IMPORT_TIMEOUT_MS,
      `Command "${namespacedId}" handler module "${resolvedPath}" did not import within ${COMMAND_IMPORT_TIMEOUT_MS}ms`
    ).then((mod) => {
      if (typeof mod.default !== "function") {
        throw new Error(
          `Command "${namespacedId}" handler module "${resolvedPath}" has no callable default export`
        );
      }
      return mod.default as ActionHandler;
    });
    // Evict a failed import so the next dispatch retries. Only a timeout is
    // genuinely transient — ESM's URL-keyed cache will hand a broken module the
    // same failure again — but caching the rejection would turn a slow first
    // import into a permanently dead command, and the main-process loader this
    // replaces never cached failures either.
    pending.catch(() => {
      if (this.commandModules.get(url) === pending) this.commandModules.delete(url);
    });
    this.commandModules.set(url, pending);
    return pending;
  }

  private async invokeIpcHandler(
    entry: RegisteredHandler,
    ctx: PluginIpcContext,
    args: unknown[]
  ): Promise<unknown> {
    if (entry.schema) {
      // Typed overload: validate the single args payload, invoke, validate result.
      const parsedArgs = entry.schema.args.safeParse(args[0]);
      if (!parsedArgs.success) {
        throw new Error(`SCHEMA_ERROR: ${formatZodIssues(parsedArgs.error)}`);
      }
      const typed = entry.handler as PluginTypedIpcHandler<unknown, unknown>;
      const result = await typed(ctx, parsedArgs.data);
      const parsedResult = entry.schema.result.safeParse(result);
      if (!parsedResult.success) {
        throw new Error(`SCHEMA_ERROR: ${formatZodIssues(parsedResult.error)}`);
      }
      return parsedResult.data;
    }
    const legacy = entry.handler as PluginIpcHandler;
    return legacy(ctx, ...args);
  }

  private buildApi(): ContributionHostApi {
    return {
      registerAction: (descriptor, handler) => {
        this.assertActivationOpen("registerAction");
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(`Plugin "${this.pluginId}" registerAction: descriptor must be an object`);
        }
        if (typeof handler !== "function") {
          throw new Error(`Plugin "${this.pluginId}" registerAction: handler must be a function`);
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerAction: descriptor.id must be a non-empty string`
          );
        }
        if (descriptor.id.startsWith(`${this.pluginId}.`)) {
          throw new Error(
            `Plugin "${this.pluginId}" registerAction: descriptor.id "${descriptor.id}" must not include the plugin prefix — Daintree adds it`
          );
        }
        const namespacedId = `${this.pluginId}.${descriptor.id}`;
        // Replace semantics mirror the real host: re-registering the same id
        // overwrites the prior handler.
        this.actionHandlers.set(namespacedId, handler);
        this.rpc.notify(
          "registerAction",
          {
            descriptor: {
              id: descriptor.id,
              title: descriptor.title,
              description: descriptor.description,
              category: descriptor.category,
              kind: descriptor.kind,
              danger: descriptor.danger,
              keywords: descriptor.keywords,
              when: descriptor.when,
              enablement: descriptor.enablement,
              inputSchema: descriptor.inputSchema,
              resultSchema: descriptor.resultSchema,
              requires: descriptor.requires,
            },
          },
          `action:${namespacedId}`
        );
        // Sync structural validation + handler capture happen above (sync throws
        // still surface at the call site); only the return value is async.
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
        this.assertActivationOpen("registerHandler");
        if (typeof channel !== "string" || channel.length === 0) {
          throw new Error(`Plugin "${this.pluginId}" registerHandler: channel must be a string`);
        }
        // A function in third position is the typed overload by definition. Short
        // of that, a function in second position is the legacy overload, whose
        // optional third argument is the options bag.
        const isLegacy =
          typeof typedHandlerOrOptions !== "function" && typeof schemaOrHandler === "function";
        const options = isLegacy
          ? (typedHandlerOrOptions as PluginHandlerOptions | undefined)
          : typedOptions;
        const rawTimeoutMs: unknown = options?.timeoutMs;
        // Validated here too so a bad value throws at the author's call site,
        // not as a deferred register-error.
        resolveInvokeTimeoutMs(this.pluginId, channel, rawTimeoutMs);
        const timeoutMs = rawTimeoutMs as number | undefined;
        if (!isLegacy) {
          const typedHandler = typedHandlerOrOptions;
          if (!isChannelSchema(schemaOrHandler)) {
            throw new Error(
              `Plugin "${this.pluginId}" registerHandler: second argument must be a channel schema { args, result } when a typed handler is provided`
            );
          }
          if (typeof typedHandler !== "function") {
            throw new Error(
              `Plugin "${this.pluginId}" registerHandler: handler must be a function`
            );
          }
          const schema = schemaOrHandler;
          this.ipcHandlers.set(channel, {
            handler: typedHandler as PluginTypedIpcHandler<unknown, unknown>,
            schema,
          });
          this.rpc.notify(
            "registerHandler",
            {
              channel,
              hasSchema: true,
              requires: schema.requires ? [...schema.requires] : undefined,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            },
            `handler:${channel}`
          );
        } else {
          this.ipcHandlers.set(channel, { handler: schemaOrHandler as PluginIpcHandler });
          this.rpc.notify(
            "registerHandler",
            { channel, hasSchema: false, ...(timeoutMs !== undefined ? { timeoutMs } : {}) },
            `handler:${channel}`
          );
        }
        return Promise.resolve();
      }) as PluginHostApi["registerHandler"],
      registerForgeProvider: (descriptor: ForgeProviderDescriptor, _impl: ForgeProviderImpl) => {
        this.assertActivationOpen("registerForgeProvider");
        // Forge providers don't run from the worker yet, in dev or prod. A
        // provider serving code can't: its `parseRemote` (the routing gate), URL
        // builders and `classifyPushError` are SYNCHRONOUS, and every worker
        // host call is async over this MessagePort. An issues-only provider
        // (`roles: ["issues"]`) is nearly async already — only `buildIssueUrl`
        // and `buildIssuesUrl` are synchronous, and their callers are async —
        // so the gap there is a missing bridge, not a contract: proxying
        // `ForgeIssueProviderImpl`, delivering `setCredentials` over the port
        // and mirroring or dropping `healthEvents`. Until that lands, issue
        // trackers ship as built-ins (Linear does).
        console.warn(
          `[plugin:${this.pluginId}] registerForgeProvider("${descriptor?.id}") is not supported from a plugin worker yet — forge providers currently run only as built-in plugins.`
        );
        return Promise.resolve(() => {});
      },
      registerFileDecorationProvider: (
        descriptor: FileDecorationProviderDescriptor,
        impl: FileDecorationProviderImpl
      ) => {
        this.assertActivationOpen("registerFileDecorationProvider");
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(
            `Plugin "${this.pluginId}" registerFileDecorationProvider: descriptor must be an object`
          );
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerFileDecorationProvider: descriptor.id must be a non-empty string`
          );
        }
        if (!impl || typeof impl !== "object" || typeof impl.provideDecorations !== "function") {
          throw new Error(
            `Plugin "${this.pluginId}" registerFileDecorationProvider: impl must expose provideDecorations()`
          );
        }
        const providerId = descriptor.id;
        // Replace semantics mirror the real host: a second register on the same
        // id overwrites the prior impl held here.
        this.fileDecorationProviders.set(providerId, impl);
        this.rpc.notify(
          "registerFileDecorationProvider",
          { descriptor: { id: providerId, scopes: descriptor.scopes } },
          `fileDecorationProvider:${providerId}`
        );
        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          // Identity-guard the delete so a stale disposer (from a prior register
          // on the same id that a later register overwrote) can't drop the
          // currently-active impl — mirrors the real host's registry semantics.
          if (this.fileDecorationProviders.get(providerId) === impl) {
            this.fileDecorationProviders.delete(providerId);
          }
          this.rpc.notify("unregisterFileDecorationProvider", { providerId });
        };
        return Promise.resolve(dispose);
      },
      registerWorktreeDeleteNotesProvider: (
        descriptor: WorktreeDeleteNotesProviderDescriptor,
        impl: WorktreeDeleteNotesProviderImpl
      ) => {
        this.assertActivationOpen("registerWorktreeDeleteNotesProvider");
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(
            `Plugin "${this.pluginId}" registerWorktreeDeleteNotesProvider: descriptor must be an object`
          );
        }
        if (typeof descriptor.id !== "string" || descriptor.id.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerWorktreeDeleteNotesProvider: descriptor.id must be a non-empty string`
          );
        }
        if (!impl || typeof impl !== "object" || typeof impl.provideNotes !== "function") {
          throw new Error(
            `Plugin "${this.pluginId}" registerWorktreeDeleteNotesProvider: impl must expose provideNotes()`
          );
        }
        const providerId = descriptor.id;
        const registration = { impl };
        this.worktreeDeleteNotesProviders.set(providerId, registration);
        this.rpc.notify(
          "registerWorktreeDeleteNotesProvider",
          { descriptor: { id: providerId } },
          `worktreeDeleteNotesProvider:${providerId}`
        );
        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          // A disposer from a binding a later register replaced is inert, here
          // and in main: it must not unbind its successor.
          if (this.worktreeDeleteNotesProviders.get(providerId) !== registration) return;
          this.worktreeDeleteNotesProviders.delete(providerId);
          this.rpc.notify("unregisterWorktreeDeleteNotesProvider", { providerId });
        };
        return Promise.resolve(dispose);
      },
      registerWorktreeSetupStep: (stepId: string, handler: PluginWorktreeSetupStepHandler) => {
        this.assertActivationOpen("registerWorktreeSetupStep");
        if (typeof stepId !== "string" || stepId.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerWorktreeSetupStep: stepId must be a non-empty string`
          );
        }
        if (typeof handler !== "function") {
          throw new Error(
            `Plugin "${this.pluginId}" registerWorktreeSetupStep: handler must be a function`
          );
        }
        const binding = { handler };
        this.worktreeSetupSteps.set(stepId, binding);
        this.rpc.notify("registerWorktreeSetupStep", { stepId }, `worktreeSetupStep:${stepId}`);
        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          // A disposer whose binding a later register replaced is inert: main
          // holds one binding per step id, and it is the replacement's.
          if (this.worktreeSetupSteps.get(stepId) !== binding) return;
          this.worktreeSetupSteps.delete(stepId);
          this.rpc.notify("unregisterWorktreeSetupStep", { stepId });
        };
        return Promise.resolve(dispose);
      },
      registerSearchProvider: (id: string, provider: PluginSearchProvider) => {
        this.assertActivationOpen("registerSearchProvider");
        if (typeof id !== "string" || id.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerSearchProvider: id must be a non-empty string`
          );
        }
        if (typeof provider !== "function") {
          throw new Error(
            `Plugin "${this.pluginId}" registerSearchProvider: provider must be a function`
          );
        }
        const binding = { provider };
        this.searchProviders.set(id, binding);
        this.rpc.notify("registerSearchProvider", { providerId: id }, `searchProvider:${id}`);
        let disposed = false;
        const dispose = (): void => {
          if (disposed) return;
          disposed = true;
          // Only while it is still the bound one: a later register on the same
          // id replaced it, and unbinding then would drop the replacement.
          if (this.searchProviders.get(id) !== binding) return;
          this.searchProviders.delete(id);
          this.rpc.notify("unregisterSearchProvider", { providerId: id });
        };
        return Promise.resolve(dispose);
      },
      // Async so a refusal arrives as a rejection, as it does in process.
      registerContextProvider: async (
        descriptor: ContextProviderDescriptor,
        impl: ContextProviderImpl
      ) => {
        this.assertActivationOpen("registerContextProvider");
        if (!descriptor || typeof descriptor !== "object") {
          throw new Error(
            `Plugin "${this.pluginId}" registerContextProvider: descriptor must be an object`
          );
        }
        const providerId = descriptor.id;
        if (typeof providerId !== "string" || providerId.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerContextProvider: descriptor.id must be a non-empty string`
          );
        }
        if (
          !impl ||
          typeof impl !== "object" ||
          typeof impl.search !== "function" ||
          typeof impl.resolve !== "function"
        ) {
          throw new Error(
            `Plugin "${this.pluginId}" registerContextProvider: impl must expose search() and resolve()`
          );
        }
        // Main checks the id against the manifest, which lives there, and
        // reports a refusal as a `register-error` that fails activation.
        this.contextProviders.set(providerId, impl);
        this.rpc.notify(
          "registerContextProvider",
          { descriptor: { id: providerId } },
          `contextProvider:${providerId}`
        );
        let disposed = false;
        return (): void => {
          if (disposed) return;
          disposed = true;
          // A disposer from a binding a later register replaced unbinds nothing.
          if (this.contextProviders.get(providerId) !== impl) return;
          this.contextProviders.delete(providerId);
          this.rpc.notify("unregisterContextProvider", { providerId });
        };
      },
      // Async so a refusal arrives as a rejection, as it does in process.
      registerService: (async (name: unknown, handlers: unknown) => {
        this.assertActivationOpen("registerService");
        if (typeof name !== "string" || name.length === 0) {
          throw new Error(
            `Plugin "${this.pluginId}" registerService: name must be a non-empty string`
          );
        }
        if (!handlers || typeof handlers !== "object") {
          throw new Error(
            `Plugin "${this.pluginId}" registerService("${name}"): handlers must be an object with one function per declared method`
          );
        }
        const record = { handlers: handlers as Record<string, unknown> };
        const methods = Object.keys(record.handlers);
        const notFunction = methods.find((method) => typeof record.handlers[method] !== "function");
        if (notFunction !== undefined) {
          throw new Error(
            `Plugin "${this.pluginId}" registerService("${name}"): "${notFunction}" must be a function`
          );
        }
        // Main checks the name and methods against the manifest, which lives
        // there, and reports a refusal as a `register-error` that fails activation.
        this.services.set(name, record);
        this.rpc.notify("registerService", { name, methods }, `service:${name}`);
        let disposed = false;
        return (): void => {
          if (disposed) return;
          disposed = true;
          if (this.services.get(name) !== record) return;
          this.services.delete(name);
          this.rpc.notify("unregisterService", { name });
        };
      }) as PluginHostApi["registerService"],
      mcp: {
        registerTools: (endpointId, tools) => {
          this.assertActivationOpen("mcp.registerTools");
          if (typeof endpointId !== "string" || endpointId.length === 0) {
            throw new Error(
              `Plugin "${this.pluginId}" mcp.registerTools: endpointId must be a non-empty string`
            );
          }
          // The same validator the host runs, so a roster mistake throws here at
          // the call site. The host re-runs it on what arrives (the worker is the
          // untrusted side) and alone checks `mcp:expose` and the declared
          // endpoint — the manifest lives in main — which surface as a
          // `register-error` and fail activation by name.
          let descriptors: ReturnType<typeof validateAgentMcpTools>;
          try {
            descriptors = validateAgentMcpTools(tools);
          } catch (err) {
            throw new Error(
              `Plugin "${this.pluginId}" mcp.registerTools("${endpointId}"): ${formatErrorMessage(err, "invalid tool roster")}`,
              { cause: err }
            );
          }
          const roster = new Map<string, RegisteredMcpTool>();
          const wire: RegisterMcpToolsParams["tools"] = {};
          for (const descriptor of descriptors) {
            const definition = tools[descriptor.name];
            roster.set(descriptor.name, { definition, execute: definition.execute });
            // Descriptor fields only: `execute` stays here, and the validated
            // copies are plain JSON, so nothing uncloneable reaches the port.
            wire[descriptor.name] = {
              description: descriptor.description,
              inputSchema: descriptor.inputSchema,
              ...(descriptor.outputSchema !== undefined
                ? { outputSchema: descriptor.outputSchema }
                : {}),
              ...(descriptor.annotations !== undefined
                ? { annotations: { ...descriptor.annotations } }
                : {}),
              // Only its shape is checked on this side; main checks it names a
              // group the manifest declares.
              ...(typeof definition.group === "string" ? { group: definition.group } : {}),
            };
          }
          this.mcpRosters.set(endpointId, roster);
          this.rpc.notify(
            "mcp.registerTools",
            { endpointId, tools: wire },
            `agentMcp:${endpointId}`
          );
          let disposed = false;
          const dispose = (): void => {
            if (disposed) return;
            disposed = true;
            // A disposer for a roster a later call replaced must not unbind the
            // replacement — here or, via the notify, in main.
            if (this.mcpRosters.get(endpointId) !== roster) return;
            this.mcpRosters.delete(endpointId);
            this.rpc.notify("mcp.unregisterTools", { endpointId });
          };
          return Promise.resolve(dispose);
        },
      },
    };
  }
}

/** Structural guard mirroring `isChannelSchema` from PluginChannelRegistry,
 * duplicated worker-side to avoid pulling main-process deps into the worker. */
function isChannelSchema(value: unknown): value is PluginChannelSchema<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { args?: { safeParse?: unknown }; result?: { safeParse?: unknown } };
  // Require `safeParse` on both sides so a plain `{ args: {}, result: {} }`
  // object is rejected at registration with a clear error instead of throwing an
  // opaque "safeParse is not a function" TypeError at the first dispatch.
  return (
    typeof v.args === "object" &&
    v.args !== null &&
    typeof v.args.safeParse === "function" &&
    typeof v.result === "object" &&
    v.result !== null &&
    typeof v.result.safeParse === "function"
  );
}

function formatZodIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  return error.issues
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
