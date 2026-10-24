// What the dev-worker bridge's domain modules see of it (#14332). The bridge
// keeps every piece of generation and invocation ownership — request ids,
// attribution, retirement, reply serialization — and hands each domain only
// read-only views of that state, and the few operations a handler performs.

import type {
  PluginHostApi,
  PluginIpcContext,
  PluginMcpCaller,
  PluginWorktreeSnapshot,
} from "../../../../shared/types/plugin.js";
import type {
  PluginHostToWorkerMessage,
  PluginWorkerToHostMessage,
  WorktreeSetupStepWireContext,
} from "../../../../shared/types/pluginDevWorker.js";
import type { PluginServiceCaller } from "../../../../shared/types/pluginServices.js";

export type InvokeTarget =
  | { kind: "action"; namespacedId: string; args: unknown }
  | { kind: "command"; namespacedId: string; resolvedPath: string; args: unknown }
  | { kind: "handler"; channel: string; ctx: PluginIpcContext; args: unknown[] }
  | { kind: "file-decoration-method"; providerId: string; method: string; args: unknown[] }
  | { kind: "worktree-delete-notes"; providerId: string; worktree: PluginWorktreeSnapshot }
  | {
      kind: "context-provider-method";
      providerId: string;
      method: "search" | "resolve";
      args: [string];
    }
  | {
      kind: "mcp-tool";
      endpointId: string;
      toolName: string;
      args: Record<string, unknown>;
      caller: PluginMcpCaller;
    }
  | { kind: "worktree-setup-step"; stepId: string; context: WorktreeSetupStepWireContext }
  | {
      kind: "search-provider";
      providerId: string;
      query: string;
      context: { mode: "scoped" | "blended"; limit: number };
    }
  | {
      kind: "service-method";
      serviceName: string;
      method: string;
      args: unknown;
      caller: PluginServiceCaller;
    };

/**
 * Where the current generation's activation stands (#12282).
 *
 * `activating` → the worker has not reported `activated` yet; a registration
 * settling now must not commit anything. `draining` → `activated` arrived and
 * the commit is waiting on the last required registration. `succeeded` /
 * `failed` are terminal for the generation, and `failed` latches: the FIRST
 * failure is the one the author sees, so a rejected contribution isn't
 * overwritten by a later, vaguer `activate-error`.
 */
export type ActivationPhase = "activating" | "draining" | "succeeded" | "failed";

export interface DevWorkerBridgeContext {
  readonly pluginId: string;
  readonly host: PluginHostApi;
  isDisposed(): boolean;
  /** Bumped when a generation is retired. Capture it before an await to fence what settles after. */
  generation(): number;
  activationPhase(): ActivationPhase;
  getCapabilities(): readonly string[];
  send(message: PluginHostToWorkerMessage): boolean;
  invoke(target: InvokeTarget, signal?: AbortSignal): Promise<unknown>;
  /** Hand a live subscription to the bridge, which tears it down with its generation. */
  trackSubscription(subscriptionId: string, dispose: () => void): void;
}

export type SubscribeMessage = Extract<PluginWorkerToHostMessage, { type: "subscribe" }>;

export type HostCallHandler = (
  params: unknown,
  signal: AbortSignal,
  method: string
) => Promise<unknown>;
export type HostNotifyHandler = (params: unknown, method: string) => Promise<void>;
/** Resolves to the subscription's disposer, or undefined when nothing was subscribed. */
export type SubscribeHandler = (
  msg: SubscribeMessage,
  push: (payload: unknown) => void
) => Promise<(() => void) | undefined>;

/**
 * Compile-time proof that the domains together route every name in `All`: a
 * method added to the protocol without a handler fails typecheck where this is
 * applied.
 */
export type RoutesCover<All extends string, Routed extends All> = [Exclude<All, Routed>] extends [
  never,
]
  ? true
  : Exclude<All, Routed>;

/**
 * One route per name across every domain. A `Map`, not a lookup on a plain
 * object: names arrive from the worker, and one spelled `toString` must not
 * find `Object.prototype`. A name claimed twice is a wiring bug and throws.
 */
export function routesFrom<H>(
  tables: readonly Readonly<Record<string, H>>[]
): ReadonlyMap<string, H> {
  const routes = new Map<string, H>();
  for (const table of tables) {
    for (const [name, handler] of Object.entries(table)) {
      if (routes.has(name)) {
        throw new Error(`plugin dev worker route "${name}" is claimed by two domains`);
      }
      routes.set(name, handler);
    }
  }
  return routes;
}
