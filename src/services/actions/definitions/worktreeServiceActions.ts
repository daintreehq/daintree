import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import { getCurrentViewStoreOrNull } from "@/store/createWorktreeStore";
import { worktreeClient } from "@/clients";

export function registerWorktreeServiceActions(
  actions: ActionRegistry,
  _callbacks: ActionCallbacks
): void {
  actions.set("worktree.refresh", () => ({
    id: "worktree.refresh",
    title: "Refresh Sidebar",
    description: "Refresh worktrees, pull requests, and GitHub stats",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["sync", "reload", "update", "sidebar"],
    run: async () => {
      window.dispatchEvent(new CustomEvent("daintree:refresh-sidebar"));
      await Promise.allSettled([
        window.electron.worktreePort.request("refresh"),
        worktreeClient.refreshPullRequests(),
      ]);
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
    danger: "safe",
    scope: "renderer",
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

  actions.set("worktree.setActive", () =>
    defineAction({
      id: "worktree.setActive",
      title: "Set Active Worktree",
      description: "Set the active worktree in the backend",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ worktreeId: z.string() }),
      run: async ({ worktreeId }) => {
        await worktreeClient.setActive(worktreeId);
      },
    })
  );
}
