import { configure } from "safe-stable-stringify";
import type {
  WorkspaceHostEvent,
  ForgeRpcMethod,
  ForgeResolveProviderResult,
} from "../../shared/types/workspace-host.js";
import type {
  CIStatus,
  Issue,
  PR,
  PRListProbeResult,
  PRSnapshot,
  RateLimitInfo,
  RepoRef,
} from "../../shared/types/forge.js";

// Deterministic stringify so identical arg shapes coalesce regardless of
// property order.
const stringifyArgs = configure({ bigint: false });

type SendEvent = (event: WorkspaceHostEvent) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: ForgeRpcMethod;
}

// Slow PR polls can run a few seconds under load; 30s gives real network
// latency room while still surfacing a stuck call before a poller backs up.
const FORGE_RPC_TIMEOUT_MS = 30_000;

/**
 * IPC client for forge provider impls that live in the main process. The
 * workspace-host UtilityProcess has no plugin loader, so it never holds
 * impls of its own — every provider call is dispatched here, sent as a
 * `forge:rpc` event over the parent port, and awaited until main answers
 * with a matching `forge:rpc-result`.
 *
 * Method shape on this client matches the subset of `ForgeProviderImpl` the
 * workspace-host actually needs. `parseRemote` is folded into
 * {@link resolveProvider} so the workspace-host never has to call a
 * synchronous provider method through async IPC.
 */
export class ForgeBridge {
  private pending = new Map<string, PendingCall>();
  private counter = 0;
  // Strict singleflight at the IPC boundary: concurrent identical calls join
  // one in-flight promise instead of crossing the process boundary twice.
  // Evicted on settlement (not TTL-cached) — the 60s response cache in
  // `forgeProvider.runQuery` absorbs staggered bursts on the main-process side.
  private inFlightByArgs = new Map<string, Promise<unknown>>();

  constructor(private readonly sendEvent: SendEvent) {}

  resolveProvider(opts: {
    remoteUrl: string | null;
    forgeProviderOverride: string | null;
    globalDefaultProviderId: string | null;
    // Worktree root this resolution is for; main stamps it onto the returned
    // `RepoRef.projectPath` so the provider gets the on-disk path (#10563).
    projectPath?: string | null;
  }): Promise<ForgeResolveProviderResult> {
    return this.invoke<ForgeResolveProviderResult>("resolveProvider", undefined, [opts]);
  }

  findPRByBranch(namespacedId: string, repo: RepoRef, branch: string): Promise<PR | null> {
    return this.invoke<PR | null>("findPRByBranch", namespacedId, [repo, branch]);
  }

  findPRsByBranches(
    namespacedId: string,
    repo: RepoRef,
    branches: string[]
  ): Promise<Map<string, PR | null> | null> {
    return this.invoke<Map<string, PR | null> | null>("findPRsByBranches", namespacedId, [
      repo,
      branches,
    ]);
  }

  /**
   * Optional batch variant of {@link getPR}. Returns `null` when the provider
   * does not implement `batchLookups.findPRsByNumbers`; the host-side
   * `BatchLoader` then falls back to per-number {@link getPR} calls. A returned
   * `Map` is keyed by PR number — an omitted key means the provider could not
   * resolve that number in the batch (transient), distinct from an explicit
   * `null` value (confirmed not found).
   */
  findPRsByNumbers(
    namespacedId: string,
    repo: RepoRef,
    prNumbers: number[]
  ): Promise<Map<number, PR | null> | null> {
    return this.invoke<Map<number, PR | null> | null>("findPRsByNumbers", namespacedId, [
      repo,
      prNumbers,
    ]);
  }

  getPR(namespacedId: string, repo: RepoRef, prNumber: number): Promise<PR | null> {
    return this.invoke<PR | null>("getPR", namespacedId, [repo, prNumber]);
  }

  getIssue(namespacedId: string, repo: RepoRef, issueNumber: number): Promise<Issue | null> {
    return this.invoke<Issue | null>("getIssue", namespacedId, [repo, issueNumber]);
  }

  getCIStatus(namespacedId: string, repo: RepoRef, prNumber: number): Promise<CIStatus | null> {
    return this.invoke<CIStatus | null>("getCIStatus", namespacedId, [repo, prNumber]);
  }

  /**
   * Optional batch variant of {@link getCIStatus}. Returns `null` when the
   * provider does not implement `batchLookups.getCIStatuses`; the host-side
   * `BatchLoader` then falls back to per-number {@link getCIStatus} calls. A
   * returned `Map` is keyed by PR number.
   */
  getCIStatuses(
    namespacedId: string,
    repo: RepoRef,
    prNumbers: number[]
  ): Promise<Map<number, CIStatus | null> | null> {
    return this.invoke<Map<number, CIStatus | null> | null>("getCIStatuses", namespacedId, [
      repo,
      prNumbers,
    ]);
  }

  /**
   * Optional cheap conditional probe of the repo's open-PR list. Returns `null`
   * when the provider does not implement `batchLookups.probeOpenPRList`; the
   * caller then revalidates every tracked PR as if no probe existed. See
   * {@link PRListProbeResult}.
   */
  probeOpenPRList(
    namespacedId: string,
    repo: RepoRef,
    tracked: PRSnapshot[]
  ): Promise<PRListProbeResult | null> {
    return this.invoke<PRListProbeResult | null>("probeOpenPRList", namespacedId, [repo, tracked]);
  }

  /**
   * Returns `null` when the provider does not implement `getRateLimit`. Mirrors
   * the capability-as-optional-method shape in `ForgeProviderImpl`.
   */
  getRateLimit(namespacedId: string): Promise<RateLimitInfo | null> {
    return this.invoke<RateLimitInfo | null>("getRateLimit", namespacedId, []);
  }

  clearPullRequestCaches(namespacedId: string): Promise<void> {
    return this.invoke<null>("clearPullRequestCaches", namespacedId, []).then(() => undefined);
  }

  /**
   * Called by the workspace-host's port message handler whenever a
   * `forge:rpc-result` arrives. Resolves or rejects the pending promise
   * keyed by `forgeRequestId`. Unknown ids are silently dropped — the
   * caller may have already timed out, in which case the promise has
   * already settled and the result is genuinely irrelevant.
   */
  handleResult(
    result:
      | { forgeRequestId: string; ok: true; value: unknown }
      | { forgeRequestId: string; ok: false; error: string }
  ): void {
    const pending = this.pending.get(result.forgeRequestId);
    if (!pending) return;
    this.pending.delete(result.forgeRequestId);
    clearTimeout(pending.timer);
    if (result.ok) {
      pending.resolve(result.value);
    } else {
      pending.reject(new Error(result.error));
    }
  }

  /** Cancel every pending call. Used on workspace-host shutdown. */
  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Forge bridge disposed (pending ${pending.method})`));
    }
    this.pending.clear();
    this.inFlightByArgs.clear();
  }

  private buildInvokeKey(
    method: ForgeRpcMethod,
    namespacedId: string | undefined,
    args: unknown[]
  ): string {
    return `${method}\0${namespacedId ?? ""}\0${stringifyArgs(args) ?? ""}`;
  }

  private invoke<T>(
    method: ForgeRpcMethod,
    namespacedId: string | undefined,
    args: unknown[]
  ): Promise<T> {
    const key = this.buildInvokeKey(method, namespacedId, args);
    const existing = this.inFlightByArgs.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    const request = this.dispatch<T>(method, namespacedId, args).finally(() => {
      this.inFlightByArgs.delete(key);
    });
    this.inFlightByArgs.set(key, request);
    return request;
  }

  private dispatch<T>(
    method: ForgeRpcMethod,
    namespacedId: string | undefined,
    args: unknown[]
  ): Promise<T> {
    const forgeRequestId = `forge-${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(forgeRequestId)) return;
        this.pending.delete(forgeRequestId);
        reject(new Error(`Forge RPC ${method} timed out after ${FORGE_RPC_TIMEOUT_MS}ms`));
      }, FORGE_RPC_TIMEOUT_MS);

      this.pending.set(forgeRequestId, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolve: resolve as any,
        reject,
        timer,
        method,
      });

      this.sendEvent({
        type: "forge:rpc",
        forgeRequestId,
        method,
        namespacedId,
        args,
      });
    });
  }
}

let _bridge: ForgeBridge | null = null;

/** Create the workspace-host's singleton bridge. Called once during bootstrap. */
export function initForgeBridge(sendEvent: SendEvent): ForgeBridge {
  if (_bridge !== null) {
    throw new Error("ForgeBridge already initialized");
  }
  _bridge = new ForgeBridge(sendEvent);
  return _bridge;
}

/** Access the singleton bridge from anywhere in the workspace-host. */
export function getForgeBridge(): ForgeBridge {
  if (_bridge === null) {
    throw new Error(
      "ForgeBridge not initialized — call initForgeBridge() during workspace-host bootstrap"
    );
  }
  return _bridge;
}

/** Test-only reset. */
export function _resetForgeBridgeForTests(): void {
  _bridge?.dispose();
  _bridge = null;
}
