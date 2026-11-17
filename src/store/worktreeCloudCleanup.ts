import type {
  CloudWorktreeCleanupOutcome,
  CloudWorktreeCleanupRequest,
  CloudWorktreeRef,
} from "@shared/types/cloudHosts";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { notify } from "@/lib/notify";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import { logWarn } from "@/utils/logger";

/**
 * What becomes of the cloud machines made for a worktree (#17360), as the
 * person chose in its delete confirmation. Machines left out are kept.
 */
export interface WorktreeCloudCleanup {
  worktree: CloudWorktreeRef;
  machines: CloudWorktreeCleanupRequest[];
}

/**
 * Starts the message of a delete stopped because its machine choice couldn't
 * be written down. Not retried by itself, and the card's Retry goes back
 * through the confirmation: what was on offer may have changed.
 */
export const CLOUD_CLEANUP_REFUSED = "Couldn't record what happens to its cloud machine";

function errorText(error: unknown, fallback: string): string {
  return isClientAppError(error) && error.userMessage
    ? error.userMessage
    : clientErrorText(error, fallback);
}

/**
 * Written down before each attempt at the delete, so the card's Retry and a
 * reconnect replay carry the same choice. A failure stops the delete before
 * anything else happens: the person confirmed the delete with that choice.
 */
export async function prepareWorktreeCloudCleanup(
  cleanup: WorktreeCloudCleanup,
  mutationId: string
): Promise<void> {
  try {
    await cloudHostsClient.prepareWorktreeCleanup(cleanup.worktree, cleanup.machines, mutationId);
  } catch (error) {
    throw new Error(`${CLOUD_CLEANUP_REFUSED}: ${errorText(error, "Cloud hosts didn't answer")}`, {
      cause: error,
    });
  }
}

/**
 * An attempt at the delete ended: `deleted` true when the host said the
 * worktree went, false when it refused, null when the answer was lost. Main
 * carries out each machine's stop or delete once the worktree is known to be
 * gone, and drops them when it is still there. A failure is kept on the
 * machine in Settings → Hosts; this says so once.
 */
export function settleWorktreeCloudCleanup(
  cleanup: WorktreeCloudCleanup,
  deleted: boolean | null,
  mutationId: string
): void {
  void cloudHostsClient.settleWorktreeCleanup(cleanup.worktree, deleted, mutationId).then(
    (outcomes) => {
      for (const outcome of outcomes) if (outcome.error !== null) notifyCleanupFailed(outcome);
    },
    (error: unknown) => {
      logWarn("[Worktree] Settling a deleted worktree's cloud machines failed", { error });
    }
  );
}

function notifyCleanupFailed(outcome: CloudWorktreeCleanupOutcome): void {
  const verb = outcome.choice === "delete" ? "delete" : "stop";
  notify({
    type: "error",
    context: { eventKind: "connectivity" },
    supersedeKey: `worktree-cloud-cleanup:${outcome.hostId}`,
    priority: "high",
    title: `Couldn't ${verb} cloud machine`,
    message: `'${outcome.machineName}' wasn't ${verb === "delete" ? "deleted" : "stopped"}: ${outcome.error} Its host in Settings → Hosts links to the provider's console.`,
    action: {
      label: "Retry",
      onClick: () => {
        void cloudHostsClient.retryWorktreeCleanup(outcome.hostId).catch((error: unknown) =>
          notifyCleanupFailed({
            ...outcome,
            error: errorText(error, "The provider didn't answer."),
          })
        );
      },
    },
  });
}
