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
  RateLimitInfo,
  RepoRef,
} from "../../shared/types/forge.js";
import { makeForgeProviderId } from "../../shared/utils/forgeProviderIds.js";
import { getForgeProviderImpl } from "./forgeProviderRegistry.js";
import { resolveForgeProvider } from "./forgeProviderResolver.js";
import { formatErrorMessage } from "../../shared/utils/errorMessage.js";

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
 */
export async function dispatchForgeRpc(req: ForgeRpcRequest, sender: Sender): Promise<void> {
  try {
    const value = await invoke(req);
    const sent = sender({
      type: "forge:rpc-result",
      forgeRequestId: req.forgeRequestId,
      ok: true,
      value,
    });
    if (!sent) {
      // `child.postMessage` either threw (non-cloneable result, e.g. a
      // third-party provider whose `rawData` contains functions or proxies)
      // or the child has already exited. Either way, the workspace-host
      // would otherwise hang on the 30s bridge timeout. Send an error
      // envelope so the bridge fails fast.
      sender({
        type: "forge:rpc-result",
        forgeRequestId: req.forgeRequestId,
        ok: false,
        error: `Forge RPC ${req.method} result could not be delivered (non-cloneable or child gone)`,
      });
    }
  } catch (error) {
    sender({
      type: "forge:rpc-result",
      forgeRequestId: req.forgeRequestId,
      ok: false,
      error: formatErrorMessage(error, `Forge RPC ${req.method} failed`),
    });
  }
}

async function invoke(req: ForgeRpcRequest): Promise<unknown> {
  if (req.method === "resolveProvider") {
    return invokeResolveProvider(req.args);
  }

  if (!req.namespacedId) {
    throw new Error(`Forge RPC ${req.method} requires a namespacedId`);
  }
  const impl = getForgeProviderImpl(req.namespacedId);
  if (!impl) {
    throw new Error(`Forge provider "${req.namespacedId}" not registered`);
  }

  switch (req.method) {
    case "findPRByBranch":
      return invokeFindPRByBranch(impl, req.args);
    case "findPRsByBranches":
      return invokeFindPRsByBranches(impl, req.args);
    case "getPR":
      return invokeGetPR(impl, req.args);
    case "getIssue":
      return invokeGetIssue(impl, req.args);
    case "getCIStatus":
      return invokeGetCIStatus(impl, req.args);
    case "getRateLimit":
      return invokeGetRateLimit(impl);
    default: {
      const exhaustive: never = req.method;
      throw new Error(`Unhandled forge RPC method: ${String(exhaustive)}`);
    }
  }
}

function invokeResolveProvider(args: unknown[]): ForgeResolveProviderResult | null {
  const [opts] = args as [
    {
      remoteUrl: string | null;
      forgeProviderOverride: string | null;
      globalDefaultProviderId: string | null;
    },
  ];
  const resolved = resolveForgeProvider({
    remoteUrl: opts.remoteUrl,
    forgeProviderOverride: opts.forgeProviderOverride,
    globalDefaultProviderId: opts.globalDefaultProviderId,
  });
  if (!resolved.entry) return null;

  const { pluginId, contribution } = resolved.entry;
  const namespacedId = makeForgeProviderId(pluginId, contribution.id);
  const impl = getForgeProviderImpl(namespacedId);
  if (!impl) return null;
  if (!opts.remoteUrl) return null;

  const repo = impl.parseRemote(opts.remoteUrl);
  if (!repo) return null;

  return { namespacedId, repo };
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

async function invokeGetRateLimit(impl: ForgeProviderImpl): Promise<RateLimitInfo | null> {
  if (!impl.getRateLimit) return null;
  return impl.getRateLimit();
}
