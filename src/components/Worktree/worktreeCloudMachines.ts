import {
  cloudMarkNamesWorktree,
  type CloudHostStatus,
  type CloudHostsSnapshot,
  type CloudProviderInfo,
  type CloudWorktreeCleanupChoice,
  type CloudWorktreeRef,
} from "@shared/types/cloudHosts";
import { getViewHostId } from "@/hooks/useHostConnection";
import { getViewWorkspaceId } from "@/store/viewWorkspaceId";
import {
  billsWhileStopped,
  canDeleteMachines,
  cloudProviderFor,
  keepMachineDescription,
  stopKeepsSentence,
} from "@/components/Hosts/cloud/cloudHostLabels";

/**
 * The worktree as a machine's mark names it: the host this view's project is
 * on, the project's own id there, and the worktree's root path. Null when the
 * view doesn't know its project, so nothing can be matched.
 */
export function worktreeRefForView(worktreeId: string): CloudWorktreeRef | null {
  const projectId = getViewWorkspaceId();
  if (!projectId || !worktreeId) return null;
  return { hostId: getViewHostId(), projectId, worktreeId };
}

/** One machine made for the worktree, with what can be done with it as its worktree goes. */
export interface WorktreeCloudMachine {
  status: CloudHostStatus;
  /** Its provider's declaration; null while that provider isn't registered. */
  provider: CloudProviderInfo | null;
  providerName: string;
  /** What it's called in the provider's account, or its id. */
  name: string;
  /** The choices offered, Keep first; only Keep when nothing else can be done from here. */
  choices: CloudWorktreeCleanupChoice[];
  /** Why only Keep is offered, when it is; null otherwise. */
  keptBecause: string | null;
}

/**
 * The machines whose mark names this worktree, and only those: an unmarked
 * machine, an imported one, or one made for another worktree never appears.
 */
export function machinesMarkedFor(
  snapshot: CloudHostsSnapshot,
  worktree: CloudWorktreeRef
): WorktreeCloudMachine[] {
  return snapshot.hosts
    .filter(
      (status) =>
        status.ownership === "created-by-daintree" &&
        status.machine !== "deleted" &&
        cloudMarkNamesWorktree(status.createdFor, worktree)
    )
    .map((status) => {
      const provider = cloudProviderFor(snapshot.providers, status);
      const providerName = provider?.name ?? status.providerId;
      const name = status.machineName ?? status.resourceId ?? status.hostId;
      const keptBecause =
        status.providerUnavailable !== null || provider === null
          ? `${providerName} isn't available right now, so '${name}' is kept.`
          : status.resourceId === null
            ? `'${name}' is still being created, so it's kept. Remove it from Settings → Hosts once it's up.`
            : null;
      const choices: CloudWorktreeCleanupChoice[] =
        keptBecause !== null
          ? ["keep"]
          : [
              "keep",
              ...(status.machine === "stopped" ? [] : (["stop"] as const)),
              ...(canDeleteMachines(provider) ? (["delete"] as const) : []),
            ];
      return { status, provider, providerName, name, choices, keptBecause };
    });
}

/** What each choice does and costs, in its provider's own terms. */
export function cleanupChoiceCopy(
  machine: WorktreeCloudMachine,
  choice: CloudWorktreeCleanupChoice,
  now: number
): { label: string; description: string } {
  const { status, provider, providerName } = machine;
  const billedStopped = billsWhileStopped(provider);
  const storageBilled = provider?.capabilities.persistence.stoppedStorageBilled === true;
  switch (choice) {
    case "keep":
      return {
        label: `Keep it on ${providerName}`,
        description: keepMachineDescription(
          status,
          providerName,
          billedStopped,
          storageBilled,
          now,
          false
        ),
      };
    case "stop": {
      const kept = provider ? ` ${stopKeepsSentence(provider.capabilities.persistence)}` : "";
      const billing = billedStopped
        ? ` ${providerName} keeps billing ${status.accountName} for it while it's stopped, until it's deleted.`
        : ` ${status.accountName} stops paying for its compute once it's stopped.`;
      return {
        label: "Stop it",
        description: `It stops once the worktree is deleted.${kept}${billing}`,
      };
    }
    case "delete":
      return {
        label: "Delete it",
        description: `It and everything on its disk are deleted from ${providerName} for good once the worktree is deleted, and ${status.accountName} stops paying for it. Its host leaves your list.`,
      };
  }
}

/** The line a chosen stop or delete adds to what the delete will do. */
export function cleanupConsequence(
  machine: WorktreeCloudMachine,
  choice: Exclude<CloudWorktreeCleanupChoice, "keep">
): string {
  return choice === "delete"
    ? `Cloud machine '${machine.name}' will be deleted from ${machine.providerName}`
    : `Cloud machine '${machine.name}' will be stopped`;
}
