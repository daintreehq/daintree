import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { worktreeClient } from "@/clients";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { isClientBrokerError } from "@/utils/clientBrokerError";
import { logWarn } from "@/utils/logger";

/**
 * A load failure worth retrying: one main or the port watchdog reported, or an
 * open project whose worktree store settled without ever receiving a snapshot.
 * The second has no error of its own to show, which is why it used to read as
 * an empty repository instead of a connection failure (#12576). A workspace
 * service error is excluded — a crashed host needs `worktree.restartService`,
 * which Retry's reload can't stand in for.
 */
function hasRetryableWorktreeLoadFailure(): boolean {
  const { worktreeLoadError, currentProject } = useProjectStore.getState();
  const viewState = getCurrentViewStoreOrNull()?.getState();
  // Checked before a reported load failure, which a dead host usually causes
  // too: Retry beside it would offer a fix that cannot work.
  if (hasServiceError()) return false;
  if (worktreeLoadError !== null) return true;
  if (!currentProject) return false;
  return viewState !== undefined && !viewState.isInitialized && !viewState.isLoading;
}

function hasServiceError(): boolean {
  const error = getCurrentViewStoreOrNull()?.getState().error;
  return error !== undefined && error !== null;
}

// Module state is per project view: each view runs its own renderer context.
let pendingPortRefresh: (() => void) | null = null;

/**
 * Re-issue a refresh the port wasn't there to take. Re-attaching only re-reads
 * cached snapshots, so without this a refresh asked for while the port was
 * missing would never run. Repeated misses coalesce into one pending refresh.
 */
function refreshWhenPortReady(): void {
  if (pendingPortRefresh !== null) return;
  let fired = false;
  const unsubscribe = window.electron.worktreePort.onReady(() => {
    if (fired) return;
    fired = true;
    pendingPortRefresh = null;
    // Deferred: preload is iterating its ready callbacks when this runs, and
    // removing one mid-loop would skip the next listener. It also covers
    // onReady calling back synchronously, before `unsubscribe` is assigned.
    queueMicrotask(() => unsubscribe());
    window.electron.worktreePort.request("refresh").catch((error: unknown) => {
      logWarn("Deferred worktree refresh failed", { error });
    });
  });
  if (!fired) pendingPortRefresh = unsubscribe;
}

export function registerWorktreeServiceActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("worktree.refresh", () => ({
    id: "worktree.refresh",
    title: "Refresh sidebar",
    description:
      "Re-read worktree state, pull requests and forge statistics from disk and the provider, discarding what is cached. Use this after changes made outside the app leave stale data on screen. It costs provider round trips against your rate limit, so prefer it over routine polling rather than as a habit.",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["sync", "reload", "update", "sidebar"],
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
      const [refreshResult] = await Promise.allSettled([
        window.electron.worktreePort.request("refresh"),
        worktreeClient.refreshPullRequests(),
      ]);
      // Two failure modes the user can't otherwise see, both surfaced (the old
      // allSettled swallowed them, which is why a wedged host looked like a dead
      // Refresh button): a rejection means the host isn't responding at all
      // (transport timeout / exit); an ok:false result means the host's own
      // refresh watchdog tripped. The Refresh button is itself the retry
      // surface, so no action button.
      const fallback = "The worktree host isn't responding. Try again in a moment.";
      let failureMessage: string | null = null;
      if (refreshResult.status === "rejected") {
        const reason: unknown = refreshResult.reason;
        // Decoding also strips the `[BrokerError|<code>]` transport prefix from
        // the message, so it never reaches the toast. A port that isn't attached
        // yet (or is mid-replacement, or the app is quitting) isn't a failure the
        // user can act on — a dead host has its own reconnect and restart
        // surfaces. Toasting it made a successful forge token save read as an
        // error (#12759).
        if (
          isClientBrokerError(reason) &&
          (reason.code === "HOST_EXITED" || reason.code === "APP_SHUTDOWN")
        ) {
          logWarn("Worktree refresh deferred: port unavailable", {
            code: reason.code,
            reason: reason.message,
          });
          if (reason.code === "HOST_EXITED") refreshWhenPortReady();
          return;
        }
        failureMessage = formatErrorMessage(reason, fallback);
      } else if (refreshResult.value.ok === false) {
        failureMessage = refreshResult.value.error ?? fallback;
      }
      if (failureMessage !== null) {
        // eslint-disable-next-line no-restricted-syntax -- notify-no-action: ok
        notify({
          type: "error",
          title: "Refresh failed",
          message: failureMessage,
          duration: 5000,
        });
      }
    },
  }));

  actions.set("worktree.reconcileTopology", () => ({
    id: "worktree.reconcileTopology",
    title: "Reconcile worktree list",
    description:
      "Force a full re-scan of worktrees. Recovers from a dark topology watcher that stopped reporting worktree changes.",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["watcher", "dark", "topology", "reconcile", "sync", "stale"],
    run: async () => {
      // force: this is explicit user-initiated recovery — bypass the cooldown
      // and pollingEnabled gate so it can never be coalesced into a no-op.
      await window.electron.worktreePort.request("reconcile-topology", { force: true });
    },
  }));

  actions.set("worktree.refreshPullRequests", () => ({
    id: "worktree.refreshPullRequests",
    title: "Refresh pull requests",
    description: "Refresh PR information for all worktrees",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["pr", "github", "fetch", "sync"],
    run: async () => {
      await worktreeClient.refreshPullRequests();
    },
  }));

  actions.set("worktree.restartService", () => ({
    id: "worktree.restartService",
    title: "Restart workspace service",
    description:
      "Restart the workspace host. Available after the service has crashed and could not recover automatically.",
    category: "worktree",
    kind: "command",
    danger: "confirm",
    scope: "renderer",
    dangerRationale:
      "Restarts the workspace host process. A hard restart drops in-flight watchers and may cause brief unavailability.",
    keywords: ["workspace", "backend", "recover", "host"],
    isEnabled: () => {
      const store = getCurrentViewStoreOrNull();
      return store !== null && store.getState().error !== null;
    },
    disabledReason: () => {
      const store = getCurrentViewStoreOrNull();
      if (store === null) return "No project view available";
      if (store.getState().error === null) return "Workspace service has not crashed";
      return undefined;
    },
    run: async () => {
      await worktreeClient.restartService();
    },
  }));

  actions.set("worktree.retryProjectLoad", () => ({
    id: "worktree.retryProjectLoad",
    title: "Retry loading worktrees",
    description: "Retry loading worktrees after a project switch failed to load them",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    keywords: ["reload", "recover", "switch", "worktree"],
    isEnabled: () => hasRetryableWorktreeLoadFailure(),
    disabledReason: () =>
      hasRetryableWorktreeLoadFailure()
        ? undefined
        : hasServiceError()
          ? "The workspace service is down; restart it first"
          : "No worktree load failure to retry",
    run: async () => {
      const retriedError = useProjectStore.getState().worktreeLoadError;
      await worktreeClient.retryProjectLoad();
      // Clear only if the banner still shows the same failure we retried — a
      // concurrent switch may have set a *new* worktreeLoadError mid-flight,
      // and that one must not be wiped by this success. A failure rejects above
      // and leaves the banner untouched.
      if (useProjectStore.getState().worktreeLoadError === retriedError) {
        useProjectStore.getState().setWorktreeLoadError(null);
      }
    },
  }));

  actions.set("worktree.setActive", () =>
    defineAction({
      id: "worktree.setActive",
      title: "Set active worktree",
      description:
        "Switch the active worktree, moving what the user sees and the default target of every later call that omits a worktree. Switching mid-task can silently retarget later work.",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({
        worktreeId: z.string().describe("Worktree id from the worktree listing."),
      }),
      run: async ({ worktreeId }) => {
        await worktreeClient.setActive(worktreeId);
      },
    })
  );
}
