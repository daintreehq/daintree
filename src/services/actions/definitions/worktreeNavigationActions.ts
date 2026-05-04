import type { ActionCallbacks, ActionRegistry } from "../actionTypes";
import { defineAction } from "../defineAction";
import { z } from "zod";
import type { ActionContext, ActionId } from "@shared/types/actions";
import { getVisibleWorktreesForCycling } from "@/lib/worktreeCyclingOrder";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";

export function registerWorktreeNavigationActions(
  actions: ActionRegistry,
  callbacks: ActionCallbacks
): void {
  actions.set("worktree.select", () =>
    defineAction({
      id: "worktree.select",
      title: "Select Worktree",
      description: "Select a worktree by ID",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      keywords: ["choose", "activate", "focus", "switch"],
      argsSchema: z.object({ worktreeId: z.string().optional() }).optional(),
      nonRepeatable: true,
      run: async (args, ctx: ActionContext) => {
        const worktreeId = args?.worktreeId;
        const targetWorktreeId = worktreeId ?? ctx.focusedWorktreeId ?? ctx.activeWorktreeId;
        if (!targetWorktreeId) {
          throw new Error("No worktree selected");
        }
        useWorktreeSelectionStore.getState().selectWorktree(targetWorktreeId);
      },
    })
  );

  actions.set("worktree.next", () => ({
    id: "worktree.next",
    title: "Next Worktree",
    description: "Switch to the next worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["cycle", "forward", "advance", "switch"],
    nonRepeatable: true,
    run: async () => {
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const worktrees = getVisibleWorktreesForCycling(activeWorktreeId);
      if (worktrees.length === 0) return;
      const currentIndex = activeWorktreeId
        ? worktrees.findIndex((w) => w.id === activeWorktreeId)
        : -1;
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % worktrees.length;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[nextIndex]!.id);
    },
  }));

  actions.set("worktree.previous", () => ({
    id: "worktree.previous",
    title: "Previous Worktree",
    description: "Switch to the previous worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["cycle", "back", "switch", "last"],
    nonRepeatable: true,
    run: async () => {
      const activeWorktreeId = callbacks.getActiveWorktreeId();
      const worktrees = getVisibleWorktreesForCycling(activeWorktreeId);
      if (worktrees.length === 0) return;
      const currentIndex = activeWorktreeId
        ? worktrees.findIndex((w) => w.id === activeWorktreeId)
        : -1;
      // When the active worktree is outside the visible list, wrap from the
      // end — this matches worktree.up/upVim so directional and cycle actions
      // agree when filters hide the active worktree.
      const prevIndex =
        currentIndex === -1
          ? worktrees.length - 1
          : (currentIndex - 1 + worktrees.length) % worktrees.length;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[prevIndex]!.id);
    },
  }));

  actions.set("worktree.switchIndex", () =>
    defineAction({
      id: "worktree.switchIndex",
      title: "Switch to Worktree by Index",
      description: "Switch to worktree at a specific position (1-9)",
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      argsSchema: z.object({ index: z.number().int().min(1).max(9) }),
      nonRepeatable: true,
      run: async ({ index }) => {
        const activeWorktreeId = callbacks.getActiveWorktreeId();
        const worktrees = getVisibleWorktreesForCycling(activeWorktreeId);
        if (worktrees.length >= index) {
          useWorktreeSelectionStore.getState().selectWorktree(worktrees[index - 1]!.id);
        }
      },
    })
  );

  for (let index = 1; index <= 9; index++) {
    const actionId = `worktree.switch${index}` as ActionId;
    actions.set(actionId, () => ({
      id: actionId,
      title: `Switch to Worktree ${index}`,
      description: `Switch to worktree at position ${index}`,
      category: "worktree",
      kind: "command",
      danger: "safe",
      scope: "renderer",
      nonRepeatable: true,
      run: async () => {
        const activeWorktreeId = callbacks.getActiveWorktreeId();
        const worktrees = getVisibleWorktreesForCycling(activeWorktreeId);
        if (worktrees.length >= index) {
          useWorktreeSelectionStore.getState().selectWorktree(worktrees[index - 1]!.id);
        }
      },
    }));
  }

  const selectWorktreeByOffset = (offset: number) => {
    const activeWorktreeId = callbacks.getActiveWorktreeId();
    const worktrees = getVisibleWorktreesForCycling(activeWorktreeId);
    if (worktrees.length === 0) return;
    const currentIndex = activeWorktreeId
      ? worktrees.findIndex((w) => w.id === activeWorktreeId)
      : -1;
    let nextIndex: number;
    if (currentIndex === -1) {
      // Active worktree is outside the visible list (filtered out or unset).
      // Moving down lands on the first visible entry; moving up lands on the last.
      nextIndex = offset > 0 ? 0 : worktrees.length - 1;
    } else {
      nextIndex = currentIndex + offset;
      if (nextIndex < 0 || nextIndex >= worktrees.length) return;
    }
    useWorktreeSelectionStore.getState().selectWorktree(worktrees[nextIndex]!.id);
  };

  actions.set("worktree.up", () => ({
    id: "worktree.up",
    title: "Worktree Up",
    description: "Move selection up in the worktree list",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      selectWorktreeByOffset(-1);
    },
  }));

  actions.set("worktree.down", () => ({
    id: "worktree.down",
    title: "Worktree Down",
    description: "Move selection down in the worktree list",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      selectWorktreeByOffset(1);
    },
  }));

  actions.set("worktree.upVim", () => ({
    id: "worktree.upVim",
    title: "Worktree Up (Vim)",
    description: "Move selection up in the worktree list",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      selectWorktreeByOffset(-1);
    },
  }));

  actions.set("worktree.downVim", () => ({
    id: "worktree.downVim",
    title: "Worktree Down (Vim)",
    description: "Move selection down in the worktree list",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      selectWorktreeByOffset(1);
    },
  }));

  actions.set("worktree.home", () => ({
    id: "worktree.home",
    title: "Worktree Home",
    description: "Select the first worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      const worktrees = getVisibleWorktreesForCycling(callbacks.getActiveWorktreeId());
      if (worktrees.length === 0) return;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[0]!.id);
    },
  }));

  actions.set("worktree.end", () => ({
    id: "worktree.end",
    title: "Worktree End",
    description: "Select the last worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      const worktrees = getVisibleWorktreesForCycling(callbacks.getActiveWorktreeId());
      if (worktrees.length === 0) return;
      useWorktreeSelectionStore.getState().selectWorktree(worktrees[worktrees.length - 1]!.id);
    },
  }));

  actions.set("worktree.selectSpace", () => ({
    id: "worktree.selectSpace",
    title: "Select Worktree (Space)",
    description: "Select the currently focused worktree",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    nonRepeatable: true,
    run: async () => {
      const focused = useWorktreeSelectionStore.getState().focusedWorktreeId;
      if (!focused) return;
      useWorktreeSelectionStore.getState().selectWorktree(focused);
    },
  }));

  actions.set("worktree.openPalette", () => ({
    id: "worktree.openPalette",
    title: "Open Worktree Palette",
    description: "Open the worktree selection palette",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["switcher", "chooser", "list", "picker"],
    nonRepeatable: true,
    run: async () => {
      callbacks.onOpenWorktreePalette();
    },
  }));

  actions.set("worktree.overview", () => ({
    id: "worktree.overview",
    title: "Toggle Worktree Overview",
    description: "Open or close the full-screen worktree overview modal",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dashboard", "grid", "summary", "modal"],
    nonRepeatable: true,
    run: async () => {
      callbacks.onToggleWorktreeOverview();
    },
  }));

  actions.set("worktree.overview.open", () => ({
    id: "worktree.overview.open",
    title: "Open Worktree Overview",
    description: "Open the full-screen worktree overview modal",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dashboard", "grid", "summary", "modal"],
    nonRepeatable: true,
    run: async () => {
      callbacks.onOpenWorktreeOverview();
    },
  }));

  actions.set("worktree.overview.close", () => ({
    id: "worktree.overview.close",
    title: "Close Worktree Overview",
    description: "Close the full-screen worktree overview modal",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["dismiss", "hide", "exit", "escape"],
    nonRepeatable: true,
    run: async () => {
      callbacks.onCloseWorktreeOverview();
    },
  }));

  actions.set("worktree.panel", () => ({
    id: "worktree.panel",
    title: "Open Worktree Panel",
    description: "Open the worktree panel",
    category: "worktree",
    kind: "command",
    danger: "safe",
    scope: "renderer",
    keywords: ["sidebar", "switcher", "chooser", "picker"],
    nonRepeatable: true,
    run: async () => {
      callbacks.onOpenWorktreePalette();
    },
  }));
}
