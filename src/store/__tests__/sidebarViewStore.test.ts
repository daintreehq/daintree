// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "daintree-sidebar-view:default";

async function loadStore() {
  vi.resetModules();
  return import("../sidebarViewStore");
}

afterEach(() => {
  localStorage.clear();
});

describe("sidebarViewStore", () => {
  it("remembers the chosen view, never the one shown in its place", async () => {
    const { useSidebarViewStore } = await loadStore();
    useSidebarViewStore.getState().chooseSidebarView("acme.beads.board");
    // The chosen view isn't on offer, so the host shows the worktree list.
    useSidebarViewStore.getState().setActiveSidebarView("worktrees");

    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    expect(stored).toEqual({ state: { chosenSidebarView: "acme.beads.board" }, version: 1 });
  });

  it("restores the choice in the next session while showing the worktree list until it applies", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ state: { chosenSidebarView: "acme.beads.board" }, version: 1 })
    );
    const { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } = await loadStore();
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe("acme.beads.board");
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
  });

  it.each([
    ["an empty id", { chosenSidebarView: "" }],
    ["a non-string id", { chosenSidebarView: 42 }],
    ["no id", {}],
  ])("falls back to the worktree list for a stored record with %s", async (_label, state) => {
    localStorage.setItem(KEY, JSON.stringify({ state, version: 1 }));
    const { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } = await loadStore();
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
  });
});
