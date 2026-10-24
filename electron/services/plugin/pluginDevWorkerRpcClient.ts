// Worker-side transport for the dev hot-reload worker (#9304): the request ids,
// pending host calls, deadlines and cancellation, invocation attribution and
// subscription dispatch that every `PluginDevWorkerHostProxy` facet shares.
// Knows nothing about the host API's domains; facets inject their own
// late-result cleanup through `onLateResult`.

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  PluginIdentity,
  PluginSettingsScope,
  PluginStorageScope,
} from "../../../shared/types/plugin.js";
import { PLUGIN_HOST_CALL_TIMEOUT_MS } from "../../../shared/types/plugin.js";
import { abortErrorFor } from "./pluginAbortError.js";
import { errorWithFields } from "./pluginHostErrorFields.js";
import { hostCallDeadlineMs, hostCallTimeoutError } from "./pluginHostCallDeadline.js";
import type {
  PluginHostCallMethod,
  PluginHostNotifyMethod,
  PluginHostToWorkerMessage,
  PluginWorkerSubscriptionKind,
  PluginWorkerToHostMessage,
} from "../../../shared/types/pluginDevWorker.js";

export type Post = (message: PluginWorkerToHostMessage) => void;

export type SubscribeMessage = Extract<PluginWorkerToHostMessage, { type: "subscribe" }>;

export interface HostCallOptions {
  /**
   * When set, {@link PluginDevWorkerRpcClient.dispose} resolves this call with
   * `grace.value` instead of rejecting it, and a cancel settles it with that
   * value too. Used by the imperative UI prompts (#10522), whose contract is to
   * resolve the dismiss value (undefined/false) on plugin unload rather than throw.
   */
  grace?: { value: unknown };
  /**
   * For a call whose outcome main decides even after a cancel: the abort still
   * reaches main as a `host-cancel`, but the caller keeps waiting for main's
   * answer instead of being settled here, because main may already have acted
   * and reports what actually happened.
   */
  hostAnswersAbort?: boolean;
  /**
   * Run with main's answer when it arrives after this worker's deadline gave
   * up on the call (#13410, #13819). Main may already have acted, and nothing
   * else will ever learn what that late answer names, so the facet that owns
   * the call releases it here. Only an `ok` answer reaches it.
   */
  onLateResult?: (result: unknown) => void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Detach the abort listener and clear the deadline once the call settles. */
  cleanup?: () => void;
  grace?: { value: unknown };
}

/** What every host proxy facet is constructed with. */
export interface HostProxyFacetDeps {
  rpc: PluginDevWorkerRpc;
  pluginId: string;
  identity: PluginIdentity;
  /** Throws once `activate()` has returned or timed out (the host is revoked). */
  assertActivationOpen: (name: string) => void;
}

/** The transport surface a host proxy facet is handed. */
export interface PluginDevWorkerRpc {
  readonly disposed: boolean;
  post(message: PluginWorkerToHostMessage): void;
  call<T>(
    method: PluginHostCallMethod,
    params: unknown,
    signal?: AbortSignal,
    options?: HostCallOptions
  ): Promise<T>;
  callWithGrace<T>(
    method: PluginHostCallMethod,
    params: unknown,
    graceValue: T,
    signal?: AbortSignal,
    options?: Omit<HostCallOptions, "grace">
  ): Promise<T>;
  notify(method: PluginHostNotifyMethod, params: unknown, registrationKey?: string): void;
  nextSubscriptionId(): string;
  addSubscription(subscriptionId: string, callback: (payload: unknown) => unknown): void;
  deleteSubscription(subscriptionId: string): void;
  subscribe(
    kind: PluginWorkerSubscriptionKind,
    callback: (payload: unknown) => void,
    key?: string,
    scope?: PluginSettingsScope | PluginStorageScope,
    debounceMs?: number
  ): () => void;
  openSubscription(message: SubscribeMessage, callback: (payload: unknown) => void): () => void;
  runInInvocation<R>(invocationId: string, fn: () => R): R;
  /** The main-side invocation the current async context is answering, if any. */
  currentInvocation(): string | undefined;
}

export class PluginDevWorkerRpcClient implements PluginDevWorkerRpc {
  private readonly pluginId: string;
  private readonly postMessage: Post;

  private nextId = 1;
  private isDisposed = false;

  private readonly pendingCalls = new Map<string, PendingCall>();
  /** Calls this worker's deadline gave up on whose owner wants main's late answer. */
  private readonly abandonedCalls = new Map<string, (result: unknown) => void>();
  private readonly subscriptions = new Map<string, (payload: unknown) => unknown>();
  /**
   * The main-side invocation the plugin's current work is answering. Stamped
   * on each host call so main can put a prompt or clipboard call in front of
   * the person who made that invocation, not whoever called the plugin last.
   */
  private readonly invocation = new AsyncLocalStorage<string>();

  constructor(pluginId: string, post: Post) {
    this.pluginId = pluginId;
    this.postMessage = post;
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  post(message: PluginWorkerToHostMessage): void {
    this.postMessage(message);
  }

  dispose(): void {
    this.isDisposed = true;
    for (const pending of this.pendingCalls.values()) {
      pending.cleanup?.();
      if (pending.grace) {
        pending.resolve(pending.grace.value);
      } else {
        pending.reject(new Error("Plugin dev worker disposed"));
      }
    }
    this.pendingCalls.clear();
    this.abandonedCalls.clear();
    this.subscriptions.clear();
  }

  runInInvocation<R>(invocationId: string, fn: () => R): R {
    return this.invocation.run(invocationId, fn);
  }

  currentInvocation(): string | undefined {
    return this.invocation.getStore();
  }

  handleHostResult(msg: Extract<PluginHostToWorkerMessage, { type: "host-result" }>): void {
    const pending = this.pendingCalls.get(msg.requestId);
    if (!pending) {
      const onLateResult = this.abandonedCalls.get(msg.requestId);
      this.abandonedCalls.delete(msg.requestId);
      if (onLateResult && msg.ok) onLateResult(msg.result);
      return;
    }
    this.pendingCalls.delete(msg.requestId);
    pending.cleanup?.();
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(errorWithFields(msg.error, msg.errorFields));
  }

  handleSubscriptionEvent(
    msg: Extract<PluginHostToWorkerMessage, { type: "subscription-event" }>
  ): void {
    const cb = this.subscriptions.get(msg.subscriptionId);
    if (!cb) return;
    try {
      const result: unknown = cb(msg.payload);
      // An async callback's rejection is the same failure as a throw.
      if (result instanceof Promise) {
        result.catch((err: unknown) =>
          console.error(`[plugin-dev:${this.pluginId}] subscription callback threw:`, err)
        );
      }
    } catch (err) {
      console.error(`[plugin-dev:${this.pluginId}] subscription callback threw:`, err);
    }
  }

  nextSubscriptionId(): string {
    return `s${this.nextId++}`;
  }

  addSubscription(subscriptionId: string, callback: (payload: unknown) => unknown): void {
    this.subscriptions.set(subscriptionId, callback);
  }

  deleteSubscription(subscriptionId: string): void {
    this.subscriptions.delete(subscriptionId);
  }

  /**
   * Like {@link call} but, instead of rejecting when the proxy is disposed
   * (plugin unload), resolves the pending promise with `graceValue`. Used by the
   * imperative UI prompts (#10522): their host contract resolves the dismiss
   * value (undefined / false) on unload rather than throwing.
   */
  callWithGrace<T>(
    method: PluginHostCallMethod,
    params: unknown,
    graceValue: T,
    signal?: AbortSignal,
    options?: Omit<HostCallOptions, "grace">
  ): Promise<T> {
    if (this.isDisposed) {
      return Promise.resolve(graceValue);
    }
    if (signal?.aborted) {
      return Promise.resolve(graceValue);
    }
    // Cancellation settles the grace value inside `call`'s abort branch, so a
    // real validation or transport error is never rewritten into a dismissal.
    return this.call<T>(method, params, signal, { ...options, grace: { value: graceValue } });
  }

  call<T>(
    method: PluginHostCallMethod,
    params: unknown,
    signal?: AbortSignal,
    options?: HostCallOptions
  ): Promise<T> {
    if (this.isDisposed) {
      return Promise.reject(new Error("Plugin dev worker disposed"));
    }
    // An already-aborted signal rejects before anything crosses the port.
    if (signal?.aborted) {
      return Promise.reject(abortErrorFor(signal));
    }
    const grace = options?.grace;
    const hostAnswersAbort = options?.hostAnswersAbort ?? false;
    const onLateResult = options?.onLateResult;
    const requestId = `c${this.nextId++}`;
    const deadlineMs = hostCallDeadlineMs(method, params);
    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (onAbort && signal) signal.removeEventListener("abort", onAbort);
        if (deadline !== undefined) clearTimeout(deadline);
      };
      // Armed in the worker so the caller is released even when main is the
      // side that stopped answering (#13410). A timeout rejects even a
      // grace-bearing call: grace is for unload and cancellation, and a
      // stalled host is neither.
      const armDeadline = (ms: number): void => {
        deadline = setTimeout(() => {
          if (!this.pendingCalls.has(requestId)) return;
          this.pendingCalls.delete(requestId);
          cleanup();
          if (onLateResult) this.abandonedCalls.set(requestId, onLateResult);
          try {
            this.postMessage({ type: "host-cancel", requestId });
          } catch {
            // best-effort — the entry is already claimed
          }
          reject(hostCallTimeoutError(this.pluginId, method, ms));
        }, ms);
        deadline.unref?.();
      };
      this.pendingCalls.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanup,
        grace,
      });
      if (signal) {
        onAbort = (): void => {
          const pending = this.pendingCalls.get(requestId);
          if (!pending) return;
          if (hostAnswersAbort) {
            try {
              this.postMessage({ type: "host-cancel", requestId });
            } catch {
              // best-effort — the call itself is still in flight, and its
              // answer (or dispose's grace value) still settles the caller
            }
            // A call with no deadline of its own (a picker waiting on the
            // person) is owed main's answer to the cancel, not the person's,
            // so that answer gets an ordinary deadline.
            if (deadline === undefined) armDeadline(PLUGIN_HOST_CALL_TIMEOUT_MS);
            return;
          }
          this.pendingCalls.delete(requestId);
          cleanup();
          try {
            // Tell main to abort the in-flight host call (AbortSignal itself is not
            // structured-clone-safe, so the requestId is the cancellation handle).
            this.postMessage({ type: "host-cancel", requestId });
          } catch {
            // best-effort — the entry is already claimed, so a failed cancel
            // post must not leave the caller's promise unsettled forever
          }
          // A grace-bearing call (the imperative prompts) treats cancellation as
          // a dismissal rather than a failure. Settling it HERE is what makes
          // that safe: this branch only runs when the abort actually claimed the
          // pending entry, so a genuine error that already settled the call can
          // never be rewritten into a dismissal (#12279).
          if (grace) {
            resolve(grace.value as T);
            return;
          }
          reject(abortErrorFor(signal));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      if (deadlineMs > 0) armDeadline(deadlineMs);
      try {
        const invocationId = this.invocation.getStore();
        this.postMessage({
          type: "host-call",
          requestId,
          method,
          params,
          ...(invocationId !== undefined ? { invocationId } : {}),
        });
      } catch (err) {
        // A non-structured-clone-safe `params` makes `postMessage` throw
        // (DataCloneError). Drop the pending entry so it doesn't leak until
        // dispose, then reject the caller.
        this.pendingCalls.delete(requestId);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: PluginHostNotifyMethod, params: unknown, registrationKey?: string): void {
    if (this.isDisposed) return;
    this.postMessage({ type: "host-notify", method, params, registrationKey });
  }

  subscribe(
    kind: PluginWorkerSubscriptionKind,
    callback: (payload: unknown) => void,
    key?: string,
    scope?: PluginSettingsScope | PluginStorageScope,
    debounceMs?: number
  ): () => void {
    const subscriptionId = this.nextSubscriptionId();
    return this.openSubscription(
      { type: "subscribe", subscriptionId, kind, key, scope, debounceMs },
      callback
    );
  }

  /** Register `callback`, post the (fully-formed) subscribe message, and return
   * an idempotent disposer that drops the callback and posts `unsubscribe`. */
  openSubscription(message: SubscribeMessage, callback: (payload: unknown) => void): () => void {
    this.subscriptions.set(message.subscriptionId, callback);
    this.postMessage(message);
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      this.subscriptions.delete(message.subscriptionId);
      this.postMessage({ type: "unsubscribe", subscriptionId: message.subscriptionId });
    };
  }
}
