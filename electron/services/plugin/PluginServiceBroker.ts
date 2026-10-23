import * as semver from "semver";
import {
  makeProjectPluginInstanceKey,
  pluginManifestIdFromInstanceKey,
  projectIdFromPluginInstanceKey,
} from "../../../shared/types/plugin.js";
import type {
  PluginServiceCallContext,
  PluginServiceCallOptions,
  PluginServiceFailureReason,
  PluginServiceProvideContribution,
  PluginServiceProviderInfo,
  PluginServiceRequireContribution,
  PluginServiceResult,
  PluginServiceStatus,
} from "../../../shared/types/pluginServices.js";
import {
  PLUGIN_SERVICE_DEFAULT_TIMEOUT_MS,
  PLUGIN_SERVICE_MAX_ARGS_BYTES,
  PLUGIN_SERVICE_MAX_CALL_DEPTH,
  PLUGIN_SERVICE_MAX_CONCURRENT_CALLS,
  PLUGIN_SERVICE_MAX_MESSAGE_LENGTH,
  PLUGIN_SERVICE_MAX_RESULT_BYTES,
  PLUGIN_SERVICE_MAX_TIMEOUT_MS,
} from "../../../shared/config/pluginBudgets.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import {
  PLUGIN_PAYLOAD_TOO_LARGE,
  assertPayloadWithinLimit,
  isPluginPayloadTooLargeError,
  snapshotPayload,
} from "./pluginPayloadLimits.js";
import {
  PluginServiceUnavailableError,
  currentServiceInvocation,
  runWithServiceInvocation,
  type PluginServiceInvocation,
} from "./pluginServiceInvocation.js";
import type { LoadedPlugin } from "./PluginServiceTypes.js";

/** Runs one method of a bound service. A worker's runner is a round trip to it. */
export type PluginServiceMethodRunner = (
  method: string,
  args: unknown,
  ctx: PluginServiceCallContext
) => unknown;

/** The instance a call comes from, as its host closure captured it. */
export interface PluginServiceConsumer {
  instanceId: string;
  projectId: string | null;
}

export interface PluginServiceBrokerDeps {
  getPlugin(instanceId: string): LoadedPlugin | undefined;
  /** Whether an app-global instance is switched on for `projectId`. */
  isVisibleInProject(instanceId: string, projectId: string): boolean;
  isActivated(instanceId: string): boolean;
  /** Never rejects; a failed start leaves the service unbound. */
  activatePlugin(instanceId: string): Promise<void>;
  /** A required import couldn't be reached. Called once per instance, service and reason. */
  reportUnresolvedRequired(consumerId: string, message: string): void;
}

interface Binding {
  readonly instanceId: string;
  /** The load that bound it; a binding outlived by its load answers nothing. */
  readonly plugin: LoadedPlugin;
  readonly name: string;
  readonly run: PluginServiceMethodRunner;
  readonly calls: Set<PendingCall>;
}

interface PendingCall {
  readonly consumerId: string;
  readonly providerId: string;
  binding: Binding | null;
  settle(result: PluginServiceResult): void;
}

type Resolution =
  | {
      ok: true;
      declared: PluginServiceRequireContribution;
      providerId: string;
      provider: LoadedPlugin;
      provided: PluginServiceProvideContribution;
    }
  | {
      ok: false;
      declared: PluginServiceRequireContribution | undefined;
      reason: "not-declared" | "unavailable" | "incompatible";
      message: string;
    };

interface CallOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

function fail(reason: PluginServiceFailureReason, message: string): PluginServiceResult<never> {
  // A provider's error text is its own; bounded so it can't outgrow the result cap.
  const bounded =
    message.length > PLUGIN_SERVICE_MAX_MESSAGE_LENGTH
      ? `${message.slice(0, PLUGIN_SERVICE_MAX_MESSAGE_LENGTH - 1)}…`
      : message;
  return { ok: false, reason, message: bounded };
}

function bindingKey(instanceId: string, name: string): string {
  return `${instanceId}\u0000${name}`;
}

function readOptions(raw: unknown): CallOptions | string {
  if (raw === undefined || raw === null) return { timeoutMs: PLUGIN_SERVICE_DEFAULT_TIMEOUT_MS };
  if (typeof raw !== "object") return "options must be an object";
  const { signal, timeoutMs } = raw as PluginServiceCallOptions;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return "options.signal must be an AbortSignal";
  }
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== "number" ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > PLUGIN_SERVICE_MAX_TIMEOUT_MS)
  ) {
    return `options.timeoutMs must be a whole number from 1 to ${PLUGIN_SERVICE_MAX_TIMEOUT_MS}`;
  }
  return { signal, timeoutMs: timeoutMs ?? PLUGIN_SERVICE_DEFAULT_TIMEOUT_MS };
}

function payloadFailure(err: unknown): PluginServiceResult<never> {
  const message = formatErrorMessage(err, "the payload can't be copied");
  return fail(isPluginPayloadTooLargeError(err) ? "payload-too-large" : "invalid", message);
}

/**
 * Typed services between plugins (#14105): resolves a consumer's declared
 * import to a provider instance when the call is made, starts the provider if
 * it hasn't run, and owns every call until it settles exactly once.
 *
 * Resolution never consults focus or a renderer. A project-bound consumer gets
 * its own project's instance of the provider first, then the app-global one if
 * it is switched on for that project; an app-global consumer only ever reaches
 * app-global providers. Service names carry their provider's manifest id (the
 * manifest gate enforces it), so a name picks one plugin and only the instance
 * is chosen here.
 *
 * Bindings are per load: unloading a provider, crashing its worker or binding
 * the name again retires the old binding and settles its calls as
 * `unavailable` at once. A call never moves to a replacement mid-flight; the
 * next call resolves afresh.
 */
export class PluginServiceBroker {
  private readonly bindings = new Map<string, Binding>();
  private readonly pending = new Set<PendingCall>();
  private readonly reported = new Set<string>();

  constructor(private readonly deps: PluginServiceBrokerDeps) {}

  /**
   * Bind `name` for the `plugin` load of `instanceId`. The caller has checked
   * it against that load's manifest; a load that has since been replaced
   * can't bind, so a late registration never answers for its successor.
   */
  bind(
    instanceId: string,
    plugin: LoadedPlugin,
    name: string,
    run: PluginServiceMethodRunner
  ): () => void {
    if (this.deps.getPlugin(instanceId) !== plugin) {
      throw new Error(`Plugin "${instanceId}" is no longer loaded`);
    }
    const prior = this.bindings.get(bindingKey(instanceId, name));
    if (prior) this.retireBinding(prior, `"${name}" was registered again`);
    const binding: Binding = { instanceId, plugin, name, run, calls: new Set() };
    this.bindings.set(bindingKey(instanceId, name), binding);
    return () => this.retireBinding(binding, `the provider of "${name}" stopped`);
  }

  /**
   * Drop what one instance holds: its bindings, the calls running in or
   * waiting on it, and the calls it made. Fires on unload, before the plugin's
   * own cleanup runs, so that cleanup can't start another call against it.
   */
  retireInstance(instanceId: string): void {
    for (const binding of [...this.bindings.values()]) {
      if (binding.instanceId === instanceId) {
        this.retireBinding(binding, `the provider of "${binding.name}" unloaded`);
      }
    }
    for (const call of [...this.pending]) {
      if (call.consumerId === instanceId) {
        call.settle(fail("cancelled", "the calling plugin unloaded"));
      } else if (call.providerId === instanceId) {
        call.settle(fail("unavailable", "the provider unloaded before answering"));
      }
    }
    const prefix = `${instanceId}\u0000`;
    for (const key of [...this.reported]) {
      if (key.startsWith(prefix)) this.reported.delete(key);
    }
  }

  status(consumer: PluginServiceConsumer, name: unknown): PluginServiceStatus {
    const resolution = this.resolve(consumer, name);
    const required = resolution.declared !== undefined && resolution.declared.optional !== true;
    if (!resolution.ok) {
      this.reportIfRequired(consumer.instanceId, resolution);
      return { available: false, required, reason: resolution.reason, message: resolution.message };
    }
    const binding = this.bindings.get(bindingKey(resolution.providerId, resolution.provided.name));
    return {
      available: true,
      required,
      provider: providerInfo(resolution),
      running: binding !== undefined && binding.plugin === resolution.provider,
    };
  }

  /** One service call. Every outcome resolves; nothing here rejects. */
  async call(
    consumer: PluginServiceConsumer,
    name: unknown,
    method: unknown,
    args: unknown,
    options?: unknown
  ): Promise<PluginServiceResult> {
    if (typeof name !== "string" || typeof method !== "string") {
      return fail("invalid", "the service name and method must be strings");
    }
    const opts = readOptions(options);
    if (typeof opts === "string") return fail("invalid", opts);
    if (opts.signal?.aborted) return fail("cancelled", "the call was cancelled before it started");
    // A call from inside activate() could wait on a provider that is itself
    // waiting on this plugin's activation. Refusing it keeps activation free of
    // dependency order instead of deadlocking until the deadline.
    if (!this.deps.isActivated(consumer.instanceId)) {
      return fail("unavailable", "service calls can be made once activate() has returned");
    }

    const resolution = this.resolve(consumer, name);
    if (!resolution.ok) {
      this.reportIfRequired(consumer.instanceId, resolution);
      return fail(resolution.reason, resolution.message);
    }
    if (!resolution.provided.methods.includes(method)) {
      return fail(
        "invalid",
        `"${name}" has no method "${method}"; it offers ${resolution.provided.methods.join(", ")}`
      );
    }

    const parent = currentServiceInvocation();
    const chain = parent?.chain ?? [];
    if (chain.some((f) => f.providerId === resolution.providerId && f.serviceName === name)) {
      const path = [...chain.map((f) => f.serviceName), name].join(" → ");
      return fail("cycle", `"${name}" is already waiting on this call (${path})`);
    }
    if (chain.length >= PLUGIN_SERVICE_MAX_CALL_DEPTH) {
      return fail("cycle", `service calls nest at most ${PLUGIN_SERVICE_MAX_CALL_DEPTH} deep`);
    }

    let payload: unknown;
    try {
      const what = `arguments for "${name}.${method}"`;
      assertPayloadWithinLimit(consumer.instanceId, what, args, PLUGIN_SERVICE_MAX_ARGS_BYTES);
      payload = snapshotPayload(consumer.instanceId, what, args);
    } catch (err) {
      return payloadFailure(err);
    }

    let running = 0;
    for (const call of this.pending) if (call.providerId === resolution.providerId) running++;
    if (running >= PLUGIN_SERVICE_MAX_CONCURRENT_CALLS) {
      return fail(
        "unavailable",
        `the provider of "${name}" is already answering ${PLUGIN_SERVICE_MAX_CONCURRENT_CALLS} calls`
      );
    }

    return this.start(consumer, resolution, method, payload, opts, parent);
  }

  private start(
    consumer: PluginServiceConsumer,
    resolution: Extract<Resolution, { ok: true }>,
    method: string,
    args: unknown,
    opts: CallOptions,
    parent: PluginServiceInvocation | null
  ): Promise<PluginServiceResult> {
    const name = resolution.provided.name;
    const startedAt = Date.now();
    // A nested call never outlives the call it was made inside.
    const deadlineAt = Math.min(startedAt + opts.timeoutMs, parent?.deadlineAt ?? Infinity);
    const controller = new AbortController();
    return new Promise<PluginServiceResult>((resolve) => {
      if (parent?.signal.aborted) {
        resolve(fail("cancelled", "the service call this one was made inside ended"));
        return;
      }
      if (deadlineAt <= startedAt) {
        resolve(fail("timeout", `the service call this one was made inside is past its deadline`));
        return;
      }
      const onCallerAbort = (): void =>
        call.settle(fail("cancelled", "the caller cancelled the call"));
      const onParentAbort = (): void =>
        call.settle(fail("cancelled", "the service call this one was made inside ended"));
      const call: PendingCall = {
        consumerId: consumer.instanceId,
        providerId: resolution.providerId,
        binding: null,
        settle: (result) => {
          if (!this.pending.delete(call)) return;
          call.binding?.calls.delete(call);
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onCallerAbort);
          parent?.signal.removeEventListener("abort", onParentAbort);
          // The call has ended either way: the provider's ctx.signal (or a
          // worker's invoke-cancel) tells it to stop, and anything its work
          // starts from here inherits an ended scope and is refused.
          controller.abort(new Error(result.ok ? "the call ended" : result.message));
          resolve(result);
        },
      };
      const budgetMs = Math.max(0, deadlineAt - startedAt);
      const timer = setTimeout(
        () =>
          call.settle(fail("timeout", `"${name}.${method}" didn't answer within ${budgetMs} ms`)),
        budgetMs
      );
      this.pending.add(call);
      opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
      parent?.signal.addEventListener("abort", onParentAbort, { once: true });
      const invocation: PluginServiceInvocation = {
        chain: [...(parent?.chain ?? []), { providerId: resolution.providerId, serviceName: name }],
        deadlineAt,
        signal: controller.signal,
      };
      void this.execute(call, consumer, resolution, method, args, invocation);
    });
  }

  private async execute(
    call: PendingCall,
    consumer: PluginServiceConsumer,
    resolution: Extract<Resolution, { ok: true }>,
    method: string,
    args: unknown,
    invocation: PluginServiceInvocation
  ): Promise<void> {
    const { providerId, provider } = resolution;
    const name = resolution.provided.name;
    const key = bindingKey(providerId, name);
    try {
      // Even with the service bound: a provider binds during activate() and
      // may still be setting up, so no call runs until it has finished.
      if (!this.deps.isActivated(providerId)) {
        await this.deps.activatePlugin(providerId);
        if (!this.pending.has(call)) return;
      }
      // Identity, not presence: the id may have been unloaded and loaded
      // again meanwhile, and that is not the provider resolved.
      if (this.deps.getPlugin(providerId) !== provider) {
        call.settle(fail("unavailable", `the provider of "${name}" unloaded while starting`));
        return;
      }
      if (!this.deps.isActivated(providerId)) {
        call.settle(fail("unavailable", `the provider of "${name}" failed to start`));
        return;
      }
      const binding = this.bindings.get(key);
      if (binding?.plugin !== provider) {
        call.settle(fail("unavailable", `the provider started but didn't register "${name}"`));
        return;
      }
      call.binding = binding;
      binding.calls.add(call);
      const ctx: PluginServiceCallContext = {
        signal: invocation.signal,
        caller: {
          pluginId: pluginManifestIdFromInstanceKey(consumer.instanceId),
          projectId: consumer.projectId,
        },
      };
      const run = binding.run;
      const value = await runWithServiceInvocation(invocation, () => run(method, args, ctx));
      if (!this.pending.has(call)) return;
      let result: unknown;
      try {
        const what = `result of "${name}.${method}"`;
        assertPayloadWithinLimit(providerId, what, value, PLUGIN_SERVICE_MAX_RESULT_BYTES);
        result = snapshotPayload(providerId, what, value);
      } catch (err) {
        call.settle(payloadFailure(err));
        return;
      }
      call.settle({ ok: true, value: result });
    } catch (err) {
      if (err instanceof PluginServiceUnavailableError) {
        call.settle(fail("unavailable", err.message));
        return;
      }
      const message = formatErrorMessage(err, `"${name}.${method}" failed`);
      // A worker refuses its own oversize result before the port, and only
      // that refusal's text crosses it.
      const oversize =
        message.startsWith(`${PLUGIN_PAYLOAD_TOO_LARGE}:`) &&
        message.includes(`"${name}.${method}"`);
      call.settle(fail(oversize ? "payload-too-large" : "provider-error", message));
    }
  }

  private resolve(consumer: PluginServiceConsumer, name: unknown): Resolution {
    const consumerPlugin = this.deps.getPlugin(consumer.instanceId);
    const declared =
      typeof name === "string"
        ? consumerPlugin?.manifest.contributes.services?.requires.find((r) => r.name === name)
        : undefined;
    if (!declared) {
      return {
        ok: false,
        declared: undefined,
        reason: "not-declared",
        message: `"${String(name)}" isn't listed in this plugin's contributes.services.requires`,
      };
    }
    const providerManifestId = declared.name.slice(0, declared.name.lastIndexOf("."));
    const candidates =
      consumer.projectId === null
        ? [providerManifestId]
        : [
            makeProjectPluginInstanceKey(consumer.projectId, providerManifestId),
            providerManifestId,
          ];
    const offered: string[] = [];
    for (const id of candidates) {
      if (id === consumer.instanceId) continue;
      const provider = this.deps.getPlugin(id);
      if (!provider) continue;
      if (
        consumer.projectId !== null &&
        projectIdFromPluginInstanceKey(id) === null &&
        !this.deps.isVisibleInProject(id, consumer.projectId)
      ) {
        continue;
      }
      const provided = provider.manifest.contributes.services?.provides.find(
        (p) => p.name === declared.name
      );
      if (!provided) continue;
      if (semver.satisfies(provided.version, declared.range)) {
        return { ok: true, declared, providerId: id, provider, provided };
      }
      offered.push(provided.version);
    }
    if (offered.length > 0) {
      return {
        ok: false,
        declared,
        reason: "incompatible",
        message: `"${declared.name}" ${declared.range} is required, but the provider offers ${offered.join(" and ")}`,
      };
    }
    return {
      ok: false,
      declared,
      reason: "unavailable",
      message: `no enabled plugin provides "${declared.name}"${consumer.projectId === null ? "" : " to this project"}`,
    };
  }

  private reportIfRequired(consumerId: string, resolution: Extract<Resolution, { ok: false }>) {
    const declared = resolution.declared;
    if (!declared || declared.optional === true) return;
    const key = `${consumerId}\u0000${declared.name}\u0000${resolution.reason}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.deps.reportUnresolvedRequired(
      consumerId,
      `Required service ${resolution.reason}: ${resolution.message}`
    );
  }

  private retireBinding(binding: Binding, why: string): void {
    const key = bindingKey(binding.instanceId, binding.name);
    if (this.bindings.get(key) === binding) this.bindings.delete(key);
    for (const call of [...binding.calls]) call.settle(fail("unavailable", why));
  }
}

function providerInfo(resolution: Extract<Resolution, { ok: true }>): PluginServiceProviderInfo {
  return {
    pluginId: pluginManifestIdFromInstanceKey(resolution.providerId),
    projectId: projectIdFromPluginInstanceKey(resolution.providerId),
    version: resolution.provided.version,
    methods: [...resolution.provided.methods],
    capabilities: [...(resolution.provider.manifest.capabilities ?? [])],
  };
}
