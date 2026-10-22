// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = "daintree-sidebar-view:default";

async function loadStore() {
  vi.resetModules();
  return import("../sidebarViewStore");
}

afterEach(() => {
  localStorage.clear();
  delete window.__DAINTREE_HOST_ID__;
});

describe("sidebarViewStore", () => {
  it("remembers the chosen view, never the one shown in its place", async () => {
    const { useSidebarViewStore } = await loadStore();
    useSidebarViewStore.getState().chooseSidebarView("acme.beads.board");
    // The chosen view isn't on offer, so the host shows the worktree list.
    useSidebarViewStore.getState().setActiveSidebarView("worktrees");

    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    expect(stored).toEqual({
      state: { chosenSidebarView: "acme.beads.board", defaultAnswers: {} },
      version: 2,
    });
  });

  it("restores the choice in the next session while showing the worktree list until it applies", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { chosenSidebarView: "acme.beads.board", defaultAnswers: {} },
        version: 2,
      })
    );
    const { useSidebarViewStore, WORKTREES_SIDEBAR_VIEW_ID } = await loadStore();
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe("acme.beads.board");
    expect(useSidebarViewStore.getState().activeSidebarView).toBe(WORKTREES_SIDEBAR_VIEW_ID);
  });

  it("keeps a remote host's project apart from a local one with the same id", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { chosenSidebarView: "acme.local.view", defaultAnswers: {} },
        version: 2,
      })
    );
    window.__DAINTREE_HOST_ID__ = { id: "studio" };
    const { useSidebarViewStore } = await loadStore();
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
    useSidebarViewStore.getState().chooseSidebarView("acme.remote.view");
    const local: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    expect(local).toEqual({
      state: { chosenSidebarView: "acme.local.view", defaultAnswers: {} },
      version: 2,
    });
  });

  it.each([
    ["an empty id", { chosenSidebarView: "" }],
    ["a non-string id", { chosenSidebarView: 42 }],
    ["no id", {}],
  ])("has no pick for a stored record with %s", async (_label, state) => {
    localStorage.setItem(KEY, JSON.stringify({ state, version: 2 }));
    const { useSidebarViewStore } = await loadStore();
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
  });

  it("starts with no pick, and a project that never chose follows the default", async () => {
    const { useSidebarViewStore } = await loadStore();
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
    expect(useSidebarViewStore.getState().defaultAnswers).toEqual({});
  });

  it("reads a v1 worktree list as no pick and any other id as a pick", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ state: { chosenSidebarView: "worktrees" }, version: 1 })
    );
    expect((await loadStore()).useSidebarViewStore.getState().chosenSidebarView).toBeNull();

    localStorage.setItem(
      KEY,
      JSON.stringify({ state: { chosenSidebarView: "acme.beads.board" }, version: 1 })
    );
    expect((await loadStore()).useSidebarViewStore.getState().chosenSidebarView).toBe(
      "acme.beads.board"
    );
  });

  it("remembers an answer per view, and 'worktrees' is also an explicit pick", async () => {
    const { useSidebarViewStore } = await loadStore();
    useSidebarViewStore.getState().answerDefaultView("project:acme.beads.board", "keep");
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
    useSidebarViewStore.getState().answerDefaultView("project:acme.beads.docs", "worktrees");
    expect(useSidebarViewStore.getState().chosenSidebarView).toBe("worktrees");

    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    expect(stored).toMatchObject({
      state: {
        defaultAnswers: {
          "project:acme.beads.board": "keep",
          "project:acme.beads.docs": "worktrees",
        },
      },
    });
  });

  it("drops stored answers it doesn't recognise", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { chosenSidebarView: null, defaultAnswers: { a: "keep", b: "nope", c: 3 } },
        version: 2,
      })
    );
    const { useSidebarViewStore } = await loadStore();
    expect(useSidebarViewStore.getState().defaultAnswers).toEqual({ a: "keep" });
  });

  it("reset forgets the pick and every answer", async () => {
    const { useSidebarViewStore } = await loadStore();
    useSidebarViewStore.getState().chooseSidebarView("acme.beads.board");
    useSidebarViewStore.getState().answerDefaultView("acme.beads.board", "keep");
    useSidebarViewStore.getState().resetDefaultView();
    expect(useSidebarViewStore.getState().chosenSidebarView).toBeNull();
    expect(useSidebarViewStore.getState().defaultAnswers).toEqual({});
  });
});
