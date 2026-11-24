import path from "node:path";
import { defineIpcNamespace, op } from "../define.js";
import { getIpcDispatcher } from "../dispatcher.js";
import type { IpcContext } from "../types.js";
import { getRemoteService, requireRemoteService } from "../../remote/runtime.js";
import { projectStore } from "../../services/ProjectStore.js";
import { AppError } from "../../utils/errorTypes.js";
import { CLOUD_HOSTS_METHOD_CHANNELS } from "./cloudHosts.preload.js";
import type {
  CloudHostCreateForWorktreeRequest,
  CloudHostCreateRequest,
  CloudHostImportRequest,
  CloudAccountAddRequest,
  CloudAccountCheckResult,
  CloudAccountSummary,
  CloudCatalog,
  CloudCredentialValues,
  CloudHostsSnapshot,
  CloudResourceSummary,
  CloudWorktreeCleanupOutcome,
  CloudWorktreeCleanupRequest,
  CloudWorktreeRef,
} from "../../../shared/types/cloudHosts.js";

const EMPTY_SNAPSHOT: CloudHostsSnapshot = { providers: [], accounts: [], hosts: [] };

function field(payload: unknown, name: string): unknown {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

/**
 * The local project a machine is being made for, as main knows it. Only a
 * window on this machine, asking for its own project, can mark a machine for
 * one of its worktrees, and only for a working tree git lists for that
 * project: a window bound to another host has none here.
 */
async function requireOwnWorktree(
  ctx: IpcContext,
  worktree: unknown
): Promise<{ projectName: string }> {
  const refuse = (message: string) =>
    new AppError({ code: "VALIDATION", message, userMessage: message });
  if (
    !ctx.event ||
    ctx.client?.kind !== "local" ||
    ctx.endpoint?.kind === "remote-view" ||
    getIpcDispatcher().hostForSender(ctx.webContentsId) !== null
  ) {
    throw refuse("A machine is made for a worktree only from a window on this machine.");
  }
  const projectId = field(worktree, "projectId");
  const worktreeId = field(worktree, "worktreeId");
  if (typeof projectId !== "string" || projectId !== ctx.projectId) {
    throw refuse("The worktree isn't in this window's project.");
  }
  if (typeof worktreeId !== "string" || !path.isAbsolute(worktreeId)) {
    throw refuse("The worktree this machine is for is missing its path.");
  }
  const project = projectStore.getProjectById(projectId);
  if (!project) throw refuse("The worktree's project isn't open on this machine.");
  const { getProjectAcrossHostsService } =
    await import("../../services/projectAcrossHosts/defaults.js");
  try {
    await getProjectAcrossHostsService().requireProjectWorktree(projectId, worktreeId);
  } catch {
    throw refuse("The worktree isn't one of this project's working trees.");
  }
  return { projectName: project.name };
}

/**
 * Cloud accounts and cloud hosts. Credentials come in once (check, add,
 * replace) and never go back out; every answer is the credential-free picture.
 */
export const cloudHostsNamespace = defineIpcNamespace({
  name: "cloudHosts",
  ops: {
    getSnapshot: op(
      CLOUD_HOSTS_METHOD_CHANNELS.getSnapshot,
      async (): Promise<CloudHostsSnapshot> =>
        getRemoteService("cloudHosts")?.snapshot() ?? EMPTY_SNAPSHOT
    ),
    checkAccountKey: op(
      CLOUD_HOSTS_METHOD_CHANNELS.checkAccountKey,
      async (payload: {
        providerId: string;
        credentials: CloudCredentialValues;
        /** For a plugin's provider: the consent fingerprint shown to the person. */
        consent?: string;
      }): Promise<CloudAccountCheckResult> =>
        requireRemoteService("cloudHosts").checkAccountCredentials(
          field(payload, "providerId"),
          field(payload, "credentials"),
          field(payload, "consent")
        )
    ),
    addAccount: op(
      CLOUD_HOSTS_METHOD_CHANNELS.addAccount,
      async (payload: CloudAccountAddRequest): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").addAccount(payload)
    ),
    replaceAccountKey: op(
      CLOUD_HOSTS_METHOD_CHANNELS.replaceAccountKey,
      async (payload: {
        accountId: string;
        credentials: CloudCredentialValues;
        consent?: string;
      }): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").replaceAccountCredentials(
          field(payload, "accountId"),
          field(payload, "credentials"),
          field(payload, "consent")
        )
    ),
    allowAccountProvider: op(
      CLOUD_HOSTS_METHOD_CHANNELS.allowAccountProvider,
      async (payload: { accountId: string; consent: string }): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").allowAccountProvider(
          field(payload, "accountId"),
          field(payload, "consent")
        )
    ),
    renameAccount: op(
      CLOUD_HOSTS_METHOD_CHANNELS.renameAccount,
      async (payload: { accountId: string; displayName: string }): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").renameAccount(
          field(payload, "accountId"),
          field(payload, "displayName")
        )
    ),
    removeAccount: op(
      CLOUD_HOSTS_METHOD_CHANNELS.removeAccount,
      async (payload: { accountId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").removeAccount(field(payload, "accountId"))
    ),
    validateAccount: op(
      CLOUD_HOSTS_METHOD_CHANNELS.validateAccount,
      async (payload: { accountId: string }): Promise<CloudAccountSummary> =>
        requireRemoteService("cloudHosts").validateAccount(field(payload, "accountId"))
    ),
    getCatalog: op(
      CLOUD_HOSTS_METHOD_CHANNELS.getCatalog,
      async (payload: { accountId: string; refresh?: boolean }): Promise<CloudCatalog> =>
        requireRemoteService("cloudHosts").catalog(
          field(payload, "accountId"),
          field(payload, "refresh") === true
        )
    ),
    listResources: op(
      CLOUD_HOSTS_METHOD_CHANNELS.listResources,
      async (payload: { accountId: string }): Promise<CloudResourceSummary[]> =>
        requireRemoteService("cloudHosts").listResources(field(payload, "accountId"))
    ),
    createHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.createHost,
      async (payload: CloudHostCreateRequest): Promise<{ hostId: string }> =>
        requireRemoteService("cloudHosts").createHost(payload)
    ),
    // The only path that marks a machine as made for a worktree; Settings' createHost never does.
    createHostForWorktree: op(
      CLOUD_HOSTS_METHOD_CHANNELS.createHostForWorktree,
      async (
        ctx: IpcContext,
        payload: CloudHostCreateForWorktreeRequest
      ): Promise<{ hostId: string; requestedAt: number }> => {
        const worktree = field(payload, "worktree");
        const { projectName } = await requireOwnWorktree(ctx, worktree);
        return requireRemoteService("cloudHosts").createHostForWorktree(
          field(payload, "machine"),
          worktree,
          projectName
        );
      },
      { withContext: true }
    ),
    importHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.importHost,
      async (payload: CloudHostImportRequest): Promise<{ hostId: string }> =>
        requireRemoteService("cloudHosts").importHost(payload)
    ),
    // A person's Start: the only path that resumes a stopped machine.
    startHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.startHost,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").startHost(field(payload, "hostId"))
    ),
    stopHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.stopHost,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").stopHost(field(payload, "hostId"))
    ),
    retryCreate: op(
      CLOUD_HOSTS_METHOD_CHANNELS.retryCreate,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").retryCreate(field(payload, "hostId"))
    ),
    refreshHost: op(
      CLOUD_HOSTS_METHOD_CHANNELS.refreshHost,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").refreshHost(field(payload, "hostId"))
    ),
    // Names the machine the person confirmed, so a rebind meanwhile deletes nothing.
    deleteMachine: op(
      CLOUD_HOSTS_METHOD_CHANNELS.deleteMachine,
      async (payload: { hostId: string; resourceId: string | null }): Promise<void> =>
        requireRemoteService("cloudHosts").deleteMachine(
          field(payload, "hostId"),
          field(payload, "resourceId")
        )
    ),
    setLifetime: op(
      CLOUD_HOSTS_METHOD_CHANNELS.setLifetime,
      async (payload: { hostId: string; lifetimeHours: number | null }): Promise<void> =>
        requireRemoteService("cloudHosts").setLifetime(
          field(payload, "hostId"),
          field(payload, "lifetimeHours")
        )
    ),
    // Names the fingerprint the person saw, so a key that changed again since is never pinned.
    trustHostKey: op(
      CLOUD_HOSTS_METHOD_CHANNELS.trustHostKey,
      async (payload: { hostId: string; fingerprint: string }): Promise<void> =>
        requireRemoteService("cloudHosts").trustHostKey(
          field(payload, "hostId"),
          field(payload, "fingerprint")
        )
    ),
    // Written before the worktree's delete is sent; each machine must carry that worktree's mark.
    prepareWorktreeCleanup: op(
      CLOUD_HOSTS_METHOD_CHANNELS.prepareWorktreeCleanup,
      async (payload: {
        worktree: CloudWorktreeRef;
        machines: CloudWorktreeCleanupRequest[];
        mutationId: string | null;
      }): Promise<void> =>
        requireRemoteService("cloudHosts").prepareWorktreeCleanup(
          field(payload, "worktree"),
          field(payload, "machines"),
          field(payload, "mutationId")
        )
    ),
    settleWorktreeCleanup: op(
      CLOUD_HOSTS_METHOD_CHANNELS.settleWorktreeCleanup,
      async (payload: {
        worktree: CloudWorktreeRef;
        deleted: boolean | null;
        mutationId: string | null;
      }): Promise<CloudWorktreeCleanupOutcome[]> =>
        requireRemoteService("cloudHosts").settleWorktreeCleanup(
          field(payload, "worktree"),
          field(payload, "deleted"),
          field(payload, "mutationId")
        )
    ),
    retryWorktreeCleanup: op(
      CLOUD_HOSTS_METHOD_CHANNELS.retryWorktreeCleanup,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").retryWorktreeCleanup(field(payload, "hostId"))
    ),
    dismissWorktreeCleanup: op(
      CLOUD_HOSTS_METHOD_CHANNELS.dismissWorktreeCleanup,
      async (payload: { hostId: string }): Promise<void> =>
        requireRemoteService("cloudHosts").dismissWorktreeCleanup(field(payload, "hostId"))
    ),
  },
});

export function registerCloudHostsHandlers(): () => void {
  return cloudHostsNamespace.register();
}
