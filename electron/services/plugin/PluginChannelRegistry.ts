import type {
  PluginManifest,
  PluginIpcHandler,
  PluginChannelSchema,
  PluginTypedIpcHandler,
  BuiltInPluginCapability,
} from "../../../shared/types/plugin.js";

/**
 * Discriminate between the typed `registerHandler(channel, schema, handler)`
 * overload and the legacy `registerHandler(channel, handler)` overload. A
 * typed schema must expose `args` and `result` Zod-compatible types — we
 * probe for a `safeParse` method on both rather than trusting structural
 * shape alone, so a JS plugin author bypassing TypeScript can't slip a
 * malformed `{ args: {}, result: ... }` past registration only to crash at
 * dispatch with a raw `safeParse is not a function` TypeError outside the
 * documented `SCHEMA_ERROR:` envelope.
 */
export function isChannelSchema(value: unknown): value is PluginChannelSchema<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  if (!("args" in value) || !("result" in value)) return false;
  const args = (value as { args: unknown }).args;
  const result = (value as { result: unknown }).result;
  return (
    typeof args === "object" &&
    args !== null &&
    typeof (args as { safeParse?: unknown }).safeParse === "function" &&
    typeof result === "object" &&
    result !== null &&
    typeof (result as { safeParse?: unknown }).safeParse === "function"
  );
}

interface PluginChannelRegistryDeps {
  /**
   * Manifest lookup for the registering plugin. Returns `undefined` when the
   * plugin is not loaded so registration fails closed with an `Unknown plugin`
   * error; the manifest's `capabilities` array backs the fail-closed gate.
   */
  getManifest: (pluginId: string) => PluginManifest | undefined;
}

/**
 * Owns the typed/legacy IPC handler maps and their registration, the
 * capability gate, per-channel schema/requires bookkeeping, and per-plugin
 * removal. Does NOT own `dispatchHandler` — that stays in PluginService where
 * it is woven with activation, the action descriptor table, ajv input-schema
 * validation, and manifest-command lazy loading. The dispatch path reads this
 * registry's three maps through the {@link getHandler} / {@link getSchema} /
 * {@link getRequires} getters, keeping dispatch semantics byte-for-byte
 * identical to the pre-extraction inline form.
 */
export class PluginChannelRegistry {
  private readonly deps: PluginChannelRegistryDeps;
  private handlerMap = new Map<string, PluginIpcHandler>();
  /**
   * Per-channel Zod schemas for typed registrations, keyed by the same
   * `pluginId:channel` key as {@link handlerMap}. Only populated for the typed
   * overload — legacy untyped registrations omit the entry and skip schema
   * validation at dispatch. Cleared per-plugin in {@link removeHandlers}
   * alongside the handler entry.
   */
  private channelSchemas = new Map<string, PluginChannelSchema<unknown, unknown>>();
  /**
   * Per-channel capability gate for typed registrations, keyed by the same
   * `pluginId:channel` key as {@link handlerMap}. Authoritative check runs at
   * registration (throws `PERMISSION_REQUIRED:` for missing capabilities); the
   * dispatch-time re-check in PluginService is defense-in-depth for future code
   * paths that mutate manifests after load.
   */
  private channelRequires = new Map<string, readonly BuiltInPluginCapability[]>();

  constructor(deps: PluginChannelRegistryDeps) {
    this.deps = deps;
  }

  register<TArgs, TResult>(
    pluginId: string,
    channel: string,
    schema: PluginChannelSchema<TArgs, TResult>,
    handler: PluginTypedIpcHandler<TArgs, TResult>
  ): void;
  register(pluginId: string, channel: string, handler: PluginIpcHandler): void;
  register(
    pluginId: string,
    channel: string,
    schemaOrHandler:
      | PluginChannelSchema<unknown, unknown>
      | PluginIpcHandler
      | PluginTypedIpcHandler<unknown, unknown>,
    typedHandler?: PluginTypedIpcHandler<unknown, unknown>
  ): void {
    const manifest = this.deps.getManifest(pluginId);
    if (!manifest) {
      throw new Error(`Unknown plugin: ${pluginId}`);
    }
    if (channel.includes(":")) {
      throw new Error(`Plugin channel must not contain colons: ${channel}`);
    }

    const key = `${pluginId}:${channel}`;
    const isTypedOverload = isChannelSchema(schemaOrHandler);

    if (isTypedOverload) {
      const schema = schemaOrHandler;
      if (typeof typedHandler !== "function") {
        throw new Error(`Plugin handler must be a function, got ${typeof typedHandler}`);
      }
      // Fail-closed at registration: every capability listed in `requires`
      // must already be declared in the plugin's manifest. Throwing here
      // surfaces author misconfiguration loudly at load instead of at first
      // dispatch (where it would look like a transient runtime error).
      const requires = schema.requires ?? [];
      const declared = new Set<BuiltInPluginCapability>(manifest.capabilities ?? []);
      const missing = requires.filter((cap) => !declared.has(cap));
      if (missing.length > 0) {
        throw new Error(
          `PERMISSION_REQUIRED: channel "${channel}" requires capability "${missing[0]}" which is not declared in plugin "${pluginId}" manifest.capabilities`
        );
      }

      const boundHandler = typedHandler;
      // Adapt the single-payload typed handler to the variadic
      // PluginIpcHandler shape so the dispatch path stays uniform. The
      // first variadic arg is the parsed payload; `dispatchHandler` only
      // calls this after `schema.args.safeParse` succeeds, so the cast is
      // safe at call time.
      const adapter: PluginIpcHandler = (ctx, ...args) =>
        boundHandler(ctx, args.length > 0 ? args[0] : undefined);

      this.handlerMap.set(key, adapter);
      this.channelSchemas.set(key, schema);
      this.channelRequires.set(key, requires);
      return;
    }

    if (typeof schemaOrHandler !== "function") {
      throw new Error(`Plugin handler must be a function, got ${typeof schemaOrHandler}`);
    }
    // Re-registration drops any prior typed-channel metadata so a legacy
    // re-bind doesn't strand a stale schema or capability gate keyed to the
    // same channel.
    this.channelSchemas.delete(key);
    this.channelRequires.delete(key);
    this.handlerMap.set(key, schemaOrHandler);
  }

  getHandler(key: string): PluginIpcHandler | undefined {
    return this.handlerMap.get(key);
  }

  getSchema(key: string): PluginChannelSchema<unknown, unknown> | undefined {
    return this.channelSchemas.get(key);
  }

  getRequires(key: string): readonly BuiltInPluginCapability[] | undefined {
    return this.channelRequires.get(key);
  }

  removeHandlers(pluginId: string): void {
    const prefix = `${pluginId}:`;
    for (const key of [...this.handlerMap.keys()]) {
      if (key.startsWith(prefix)) {
        this.handlerMap.delete(key);
        // Action input-schema validators are keyed by the namespaced action id
        // and cleared by unregisterPluginActions, not here.
        this.channelSchemas.delete(key);
        this.channelRequires.delete(key);
      }
    }
  }
}
