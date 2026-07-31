import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { useProjectStore } from "@/store/projectStore";
import { worktreeClient } from "@/clients";
import { notify } from "@/lib/notify";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export function registerWorktreeServiceActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("worktree.refresh", () => ({
    id: "worktree.refresh",
    title: "Refresh Sidebar",
    description: "Refresh worktrees, pull requests, and forge stats",
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
        failureMessage = formatErrorMessage(refreshResult.reason, fallback);
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
    title: "Refresh Pull Requests",
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
    title: "Restart Workspace Service",
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
    isEnabled: () => useProjectStore.getState().worktreeLoadError !== null,
    disabledReason: () =>
      useProjectStore.getState().worktreeLoadError === null
        ? "No worktree load failure to retry"
        : undefined,
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
      title: "Set Active Worktree",
      description: "Set the active worktree in the backend",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      mcpVisibility: "core",
      argsSchema: z.object({ worktreeId: z.string() }),
      run: async ({ worktreeId }) => {
        await worktreeClient.setActive(worktreeId);
      },
    })
  );
}
