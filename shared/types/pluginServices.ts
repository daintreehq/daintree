/**
 * Services between cooperating plugins (#14105). A provider exports named,
 * versioned methods under its own manifest id; a consumer declares the
 * services it imports with a semver range and calls them through
 * `host.services`. The host resolves each call when it is made — to the
 * provider instance bound to the consumer's project, else the app-global one —
 * starts that provider if it isn't running, and bounds the call by a deadline,
 * payload caps and cancellation. Nothing is installed, enabled or ordered from
 * these declarations, and no call reaches a renderer.
 */

/** One `contributes.services.provides` entry. */
export interface PluginServiceProvideContribution {
  /**
   * `{manifest id}.{local name}`, e.g. `acme.jira.issues`. A plugin can only
   * provide services under its own id, so a consumer's import names exactly
   * one plugin and no other plugin can answer in its place.
   */
  name: string;
  /** The contract's semver version, e.g. `1.2.0`. Consumers match it with a range. */
  version: string;
  /** Every method a consumer may call. `host.registerService` binds exactly these. */
  methods: string[];
}

/** One `contributes.services.requires` entry. */
export interface PluginServiceRequireContribution {
  /** The provided service's full name, e.g. `acme.jira.issues`. */
  name: string;
  /** Provider versions this plugin works with, as a semver range, e.g. `^1.0.0`. */
  range: string;
  /**
   * The plugin works without it. A required service that can't be reached is
   * written to the plugin's log; an optional one isn't. Calls report the same
   * result either way. Defaults to `false`.
   */
  optional?: boolean;
}

/** `contributes.services`. */
export interface PluginServicesContribution {
  provides: PluginServiceProvideContribution[];
  requires: PluginServiceRequireContribution[];
}

/** Who made a service call, as the host saw it. Nothing in it comes from the caller. */
export interface PluginServiceCaller {
  /** The calling plugin's manifest id. */
  pluginId: string;
  /** The project the calling instance is bound to, or `null` for an app-global plugin. */
  projectId: string | null;
}

/** Handed to a provider's method beside the arguments. */
export interface PluginServiceCallContext {
  /** Aborted when the caller cancels, the deadline passes, or either plugin unloads. */
  signal: AbortSignal;
  caller: PluginServiceCaller;
}

/**
 * Method name → argument and result types. Share one between the provider and
 * its consumers as a TypeScript type to type both ends of a call.
 */
export type PluginServiceContract = Record<string, { args: unknown; result: unknown }>;

/** The implementation `host.registerService` binds: one function per declared method. */
export type PluginServiceHandlers<TContract extends PluginServiceContract = PluginServiceContract> =
  {
    [M in keyof TContract]: (
      args: TContract[M]["args"],
      ctx: PluginServiceCallContext
    ) => TContract[M]["result"] | Promise<TContract[M]["result"]>;
  };

export interface PluginServiceCallOptions {
  /** Cancels the call. The provider's `ctx.signal` aborts with it. */
  signal?: AbortSignal;
  /**
   * The call's deadline in milliseconds, starting the provider included.
   * Defaults to 30 seconds; at most 120 seconds. A call made inside another
   * service call never outlives the outer call's deadline.
   */
  timeoutMs?: number;
}

/**
 * Why a service call failed:
 * - `not-declared` — the caller's manifest doesn't list the service in `contributes.services.requires`.
 * - `unavailable` — no provider is installed, enabled and visible to the caller, it didn't bind the service or is still starting again after a crash, it unloaded or crashed mid-call, it is at its concurrent-call limit, or the caller is still inside `activate()`.
 * - `incompatible` — the provider is there, but its version is outside the declared range.
 * - `cycle` — the call would re-enter a service already waiting on this one.
 * - `timeout` / `cancelled` — the deadline passed, or the caller's signal aborted.
 * - `invalid` — an unknown method, a bad option, or arguments or a result that can't be copied between processes.
 * - `payload-too-large` — the arguments or the result are over the size limit.
 * - `provider-error` — the provider's method threw; `message` carries its error.
 */
export type PluginServiceFailureReason =
  | "not-declared"
  | "unavailable"
  | "incompatible"
  | "cycle"
  | "timeout"
  | "cancelled"
  | "invalid"
  | "payload-too-large"
  | "provider-error";

/** A service call's outcome. Expected failures resolve; they never reject. */
export type PluginServiceResult<T = unknown> =
  { ok: true; value: T } | { ok: false; reason: PluginServiceFailureReason; message: string };

/** The provider a service resolves to. */
export interface PluginServiceProviderInfo {
  /** The provider's manifest id. */
  pluginId: string;
  /** The project the provider instance belongs to, or `null` for an app-global one. */
  projectId: string | null;
  /** The version the provider declares for the service. */
  version: string;
  methods: string[];
  /**
   * The provider's declared capabilities: what it can do with what it is sent.
   * Disclosure only — calling it grants the caller none of them.
   */
  capabilities: string[];
}

/** Whether a declared import can be called now, from `host.services.status`. */
export type PluginServiceStatus =
  | {
      available: true;
      /** Whether the caller declared the import required. */
      required: boolean;
      provider: PluginServiceProviderInfo;
      /** The provider has bound the service. When false, the first call starts it. */
      running: boolean;
    }
  | {
      available: false;
      required: boolean;
      reason: "not-declared" | "unavailable" | "incompatible";
      message: string;
    };

/** `host.services`: calls into other plugins' services. */
export interface PluginServicesApi {
  /**
   * Call `method` on a service declared in `contributes.services.requires`.
   * Resolves to `{ ok: true, value }` or `{ ok: false, reason, message }` and
   * never rejects for an expected failure. Calls made before this plugin's
   * `activate()` has returned resolve as `unavailable`.
   */
  call<TContract extends PluginServiceContract, M extends keyof TContract & string>(
    name: string,
    method: M,
    args: TContract[M]["args"],
    options?: PluginServiceCallOptions
  ): Promise<PluginServiceResult<TContract[M]["result"]>>;
  /** Where a declared import would resolve now, without starting the provider. */
  status(name: string): Promise<PluginServiceStatus>;
}
