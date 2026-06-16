import { configure } from "safe-stable-stringify";
import type {
  ForgeRpcMethod,
  ForgeResolveProviderResult,
  WorkspaceHostRequest,
} from "../../shared/types/workspace-host.js";
import type {
  CIStatus,
  ForgeProviderImpl,
  Issue,
  PR,
  PRListProbeResult,
  PRSnapshot,
  RateLimitInfo,
  RepoRef,
} from "../../shared/types/forge.js";
import { makeForgeProviderId } from "../../shared/utils/forgeProviderIds.js";
import { getForgeProviderImpl } from "./forgeProviderRegistry.js";
import { resolveForgeProvider } from "./forgeProviderResolver.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

// PluginService is loaded lazily so importing this file (e.g. from
// `WorkspaceHostProcess` in tests that mock electron's `app` without
// `getVersion()`) doesn't trigger the PluginService singleton constructor
// at module-load time. The first forge RPC dispatch performs the import.
type PluginServiceShape = {
  activatePluginForForgeProvider(namespacedId: string): Promise<void>;
  readonly isPluginScanComplete: boolean;
};
let pluginServicePromise: Promise<PluginServiceShape> | null = null;
function getPluginService(): Promise<PluginServiceShape> {
  if (!pluginServicePromise) {
    pluginServicePromise = import("./PluginService.js").then((mod) => mod.pluginService);
  }
  return pluginServicePromise;
}

// Deterministic stringify so two windows calling the same method with the same
// arg shape coalesce regardless of property order. Mirrors the bridge-side
// singleflight key in `forgeBridge.ts`. NOTE: `Map`/`Set` instances serialize
// as `{}` here and would silently collide — all current `ForgeRpcMethod` args
// are `RepoRef`, primitives, or arrays-of-primitives, so this is safe today.
// If a future method adds a Map/Set arg, key it explicitly before stringify.
const stringifyArgs = configure({ bigint: false });

/**
 * Incoming `forge:rpc` event shape (workspace-host → main). Defined locally as
 * a structural type so this server stays decoupled from the full
 * `WorkspaceHostEvent` union — the only caller is `WorkspaceHostProcess` and
 * it narrows the event before dispatch.
 */
export interface ForgeRpcRequest {
  forgeRequestId: string;
  method: ForgeRpcMethod;
  namespacedId?: string;
  args: unknown[];
}

type Sender = (request: WorkspaceHostRequest) => boolean;

interface Waiter {
  sender: Sender;
  forgeRequestId: string;
  method: ForgeRpcMethod;
}

interface InFlightEntry {
  promise: Promise<void>;
  waiters: Waiter[];
}

// Cross-host singleflight, and the sole dedup layer main owns. Workspace-hosts
// are pooled one-per-project (`WorkspaceHostPool`), so the windows sharing a
// project route through a single host; this map still absorbs the fan-in from
// distinct projects whose calls collapse on `namespacedId`/args, plus any
// transient overlap when a host is restarting or handing off. Identical
// concurrent requests join a single in-flight provider call and the result is
// delivered to every waiter. The bridge-side singleflight in `forgeBridge.ts`
// only dedupes within a single host; this sits at the boundary main owns.
//
// Evicted on settlement (success or error) so retries proceed immediately —
// no TTL caching here; the GitHub response cache in `forgeProvider.runQuery`
// already handles staggered repeats.
const inFlight = new Map<string, InFlightEntry>();

// Hard ceiling on a single in-flight provider call. The bridge's per-caller
// timeout is 30s; this sits just beyond it so a hung third-party provider
// (no internal timeout, no abort signal) can't wedge the singleflight entry
// forever and leak waiters as new identical requests join the dead promise.
// The built-in GitHub provider's own 15s AbortSignal.timeout settles long
// before this; only misbehaving plugins ever reach it.
const FORGE_INVOKE_TIMEOUT_MS = 35_000;

function buildSingleflightKey(req: ForgeRpcRequest): string {
  return `${req.method}\0${req.namespacedId ?? ""}\0${stringifyArgs(req.args) ?? ""}`;
}

function deliverResult(waiter: Waiter, value: unknown): void {
  const sent = waiter.sender({
    type: "forge:rpc-result",
    forgeRequestId: waiter.forgeRequestId,
    ok: true,
    value,
  });
  if (!sent) {
    // `child.postMessage` either threw (non-cloneable result, e.g. a
    // third-party provider whose `rawData` contains functions or proxies)
    // or the child has already exited. Either way, the workspace-host
    // would otherwise hang on the 30s bridge timeout. Send an error
    // envelope so the bridge fails fast.
    waiter.sender({
      type: "forge:rpc-result",
      forgeRequestId: waiter.forgeRequestId,
      ok: false,
      error: `Forge RPC ${waiter.method} result could not be delivered (non-cloneable or child gone)`,
    });
  }
}

function deliverError(waiter: Waiter, error: unknown): void {
  waiter.sender({
    type: "forge:rpc-result",
    forgeRequestId: waiter.forgeRequestId,
    ok: false,
    error: formatErrorMessage(error, `Forge RPC ${waiter.method} failed`),
  });
}

/**
 * Dispatch a forge RPC call from the workspace-host against the local
 * forge provider registry, then send the result back via `sender`. Errors
 * are caught and reported through the same channel — the workspace-host's
 * bridge surfaces them as rejected promises at the call site (e.g. inside
 * `PullRequestService.checkForPRs`).
 *
 * This is the single point where the workspace-host crosses the process
 * boundary into the forge layer. Plugin authors do not need to know it
 * exists — their impls run in main as usual; the bridge is transparent.
 *
 * Concurrent identical requests across any number of workspace-hosts share
 * one upstream provider call: the first request initiates `invoke()`; any
 * matching request that arrives while it is in-flight is registered as a
 * waiter, and the eventual result (or error) is delivered to every waiter
 * with each one's own `forgeRequestId`. See `inFlight` above.
 */
export function dispatchForgeRpc(req: ForgeRpcRequest, sender: Sender): Promise<void> {
  const key = buildSingleflightKey(req);
  const waiter: Waiter = {
    sender,
    forgeRequestId: req.forgeRequestId,
    method: req.method,
  };

  const existing = inFlight.get(key);
  if (existing) {
    existing.waiters.push(waiter);
    return existing.promise;
  }

  const waiters: Waiter[] = [waiter];
  const promise = (async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Forge RPC ${req.method} timed out after ${FORGE_INVOKE_TIMEOUT_MS}ms`)
            ),
          FORGE_INVOKE_TIMEOUT_MS
        );
        timer.unref?.();
      });
      const value = await Promise.race([invoke(req), timeout]);
      for (const w of waiters) deliverResult(w, value);
    } catch (error) {
      for (const w of waiters) deliverError(w, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, { promise, waiters });
  return promise;
}

/** Test-only reset. */
export function _resetForgeRpcInFlightForTests(): void {
  inFlight.clear();
}

async function invoke(req: ForgeRpcRequest): Promise<unknown> {
  if (req.method === "resolveProvider") {
    return invokeResolveProvider(req.args);
  }

  if (!req.namespacedId) {
    throw new Error(`Forge RPC ${req.method} requires a namespacedId`);
  }
  // Implicit activation: force the owning plugin's `activate()` to run before
  // we try to resolve its impl, so a plugin that only binds during activate()
  // is reachable on first use without a startup activation gate.
  const pluginService = await getPluginService();
  await pluginService.activatePluginForForgeProvider(req.namespacedId);
  const impl = getForgeProviderImpl(req.namespacedId);
  if (!impl) {
    throw new Error(`Forge provider "${req.namespacedId}" not registered`);
  }

  switch (req.method) {
    case "findPRByBranch":
      return invokeFindPRByBranch(impl, req.args);
    case "findPRsByBranches":
      return invokeFindPRsByBranches(impl, req.args);
    case "findPRsByNumbers":
      return invokeFindPRsByNumbers(impl, req.args);
    case "getPR":
      return invokeGetPR(impl, req.args);
    case "getIssue":
      return invokeGetIssue(impl, req.args);
    case "getCIStatus":
      return invokeGetCIStatus(impl, req.args);
    case "getCIStatuses":
      return invokeGetCIStatuses(impl, req.args);
    case "probeOpenPRList":
      return invokeProbeOpenPRList(impl, req.args);
    case "getRateLimit":
      return invokeGetRateLimit(impl);
    case "clearPullRequestCaches":
      return invokeClearPullRequestCaches(impl);
    default: {
      const exhaustive: never = req.method;
      throw new Error(`Unhandled forge RPC method: ${String(exhaustive)}`);
    }
  }
}

async function invokeResolveProvider(args: unknown[]): Promise<ForgeResolveProviderResult> {
  const [opts] = args as [
    {
      remoteUrl: string | null;
      forgeProviderOverride: string | null;
      globalDefaultProviderId: string | null;
      projectPath?: string | null;
    },
  ];
  const pluginService = await getPluginService();
  // Hostname matching runs against descriptors registered at manifest
  // scan-time, so a miss is only definitive once `PluginService.initialize()`
  // has finished. Before that, report "not-ready" so the workspace-host keeps
  // its short cold-start retry instead of treating the miss as permanent
  // (#9997). After scan completion every failure mode below is "no-match" —
  // re-evaluated when forge settings or the plugin registry change.
  const miss: ForgeResolveProviderResult = pluginService.isPluginScanComplete
    ? { status: "no-match" }
    : { status: "not-ready" };
  const resolved = resolveForgeProvider({
    remoteUrl: opts.remoteUrl,
    forgeProviderOverride: opts.forgeProviderOverride,
    globalDefaultProviderId: opts.globalDefaultProviderId,
  });
  if (!resolved.entry) return miss;

  const { pluginId, contribution } = resolved.entry;
  const namespacedId = makeForgeProviderId(pluginId, contribution.id);
  // Implicit activation before impl lookup — see `invoke` above for rationale.
  await pluginService.activatePluginForForgeProvider(namespacedId);
  const impl = getForgeProviderImpl(namespacedId);
  if (!impl) return miss;
  if (!opts.remoteUrl) return miss;

  const repo = impl.parseRemote(opts.remoteUrl);
  if (!repo) return miss;

  // Stamp the caller's worktree path onto the ref so the provider receives the
  // on-disk path without reconstructing it from `repo` (#10563). Main is the
  // authority here: the workspace-host supplies its `cwd`, main returns it on
  // the parsed ref.
  const stamped: RepoRef = opts.projectPath ? { ...repo, projectPath: opts.projectPath } : repo;
  return { status: "resolved", namespacedId, repo: stamped };
}

function invokeFindPRByBranch(impl: ForgeProviderImpl, args: unknown[]): Promise<PR | null> {
  const [repo, branch] = args as [RepoRef, string];
  return impl.findPRByBranch(repo, branch);
}

async function invokeFindPRsByBranches(
  impl: ForgeProviderImpl,
  args: unknown[]
): Promise<Map<string, PR | null> | null> {
  const [repo, branches] = args as [RepoRef, string[]];
  if (!impl.findPRsByBranches) return null;
  return impl.findPRsByBranches(repo, branches);
}

async function invokeFindPRsByNumbers(
  impl: ForgeProviderImpl,
  args: unknown[]
): Promise<Map<number, PR | null> | null> {
  const [repo, prNumbers] = args as [RepoRef, number[]];
  if (!impl.batchLookups?.findPRsByNumbers) return null;
  return impl.batchLookups.findPRsByNumbers(repo, prNumbers);
}

function invokeGetPR(impl: ForgeProviderImpl, args: unknown[]): Promise<PR | null> {
  const [repo, prNumber] = args as [RepoRef, number];
  return impl.getPR(repo, prNumber);
}

function invokeGetIssue(impl: ForgeProviderImpl, args: unknown[]): Promise<Issue | null> {
  const [repo, issueNumber] = args as [RepoRef, number];
  return impl.getIssue(repo, issueNumber);
}

function invokeGetCIStatus(impl: ForgeProviderImpl, args: unknown[]): Promise<CIStatus | null> {
  const [repo, prNumber] = args as [RepoRef, number];
  return impl.getCIStatus(repo, prNumber);
}

async function invokeGetCIStatuses(
  impl: ForgeProviderImpl,
  args: unknown[]
): Promise<Map<number, CIStatus | null> | null> {
  const [repo, prNumbers] = args as [RepoRef, number[]];
  if (!impl.batchLookups?.getCIStatuses) return null;
  return impl.batchLookups.getCIStatuses(repo, prNumbers);
}

async function invokeProbeOpenPRList(
  impl: ForgeProviderImpl,
  args: unknown[]
): Promise<PRListProbeResult | null> {
  const [repo, tracked] = args as [RepoRef, PRSnapshot[]];
  if (!impl.batchLookups?.probeOpenPRList) return null;
  return impl.batchLookups.probeOpenPRList(repo, tracked);
}

async function invokeGetRateLimit(impl: ForgeProviderImpl): Promise<RateLimitInfo | null> {
  if (!impl.getRateLimit) return null;
  return impl.getRateLimit();
}

async function invokeClearPullRequestCaches(impl: ForgeProviderImpl): Promise<null> {
  await impl.clearPullRequestCaches?.();
  return null;
}
