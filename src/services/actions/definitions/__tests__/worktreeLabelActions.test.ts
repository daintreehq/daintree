// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@/types";

const worktreesMock = vi.hoisted(() => ({ current: new Map<string, Partial<WorktreeState>>() }));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStore: () => ({
    getState: () => ({ worktrees: worktreesMock.current }),
  }),
  getCurrentViewStoreOrNull: () => ({
    getState: () => ({ worktrees: worktreesMock.current }),
  }),
}));

vi.mock("@/clients", () => ({
  copyTreeClient: { generateAndCopyFile: vi.fn() },
  systemClient: { openInEditor: vi.fn(), openPath: vi.fn() },
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn() },
}));

import type { ActionContext } from "@shared/types/actions";
import type { ActionRegistry, ActionCallbacks } from "../../actionTypes";
import { registerWorktreeContextActions } from "../worktreeContextActions";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

function getAction(
  id: "worktree.setLabelColor" | "worktree.setCustomTitle" = "worktree.setLabelColor"
) {
  const actions: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the action reaches no callback; same stub the sibling suites use.
  const callbacks = {} as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  const factory = actions.get(id);
  if (!factory) throw new Error(`${id} is not registered`);
  return factory();
}

const ctx = {} as ActionContext;

beforeEach(() => {
  worktreesMock.current = new Map([
    ["wt-main", { id: "wt-main", path: "/repo", isMainWorktree: true }],
    ["wt-feature", { id: "wt-feature", path: "/repo-wt/feature" }],
  ]);
  useWorktreeFilterStore.setState({ worktreeLabelColors: {}, worktreeCustomTitles: {} });
});

describe("worktree.setLabelColor", () => {
  it("requires an explicit worktree and a colour or null", () => {
    const schema = getAction().argsSchema!;
    expect(() => schema.parse({ worktreeId: "wt-main", color: "teal" })).not.toThrow();
    expect(() => schema.parse({ worktreeId: "wt-main", color: null })).not.toThrow();
    expect(() => schema.parse({ worktreeId: "wt-main" })).toThrow();
    expect(() => schema.parse({ color: "teal" })).toThrow();
    // Not every category token is a label colour.
    expect(() => schema.parse({ worktreeId: "wt-main", color: "orange" })).toThrow();
  });

  it("labels the main worktree, storing the theme token", async () => {
    await getAction().run({ worktreeId: "wt-main", color: "teal" }, ctx);

    expect(useWorktreeFilterStore.getState().worktreeLabelColors).toEqual({
      "wt-main": "category-teal",
    });
  });

  it("clears a label with null and leaves other worktrees alone", async () => {
    const action = getAction();
    await action.run({ worktreeId: "wt-main", color: "pink" }, ctx);
    await action.run({ worktreeId: "wt-feature", color: "violet" }, ctx);

    await action.run({ worktreeId: "wt-main", color: null }, ctx);

    expect(useWorktreeFilterStore.getState().worktreeLabelColors).toEqual({
      "wt-feature": "category-violet",
    });
  });

  it("rejects a worktree this project does not have, writing nothing", async () => {
    await expect(getAction().run({ worktreeId: "wt-gone", color: "blue" }, ctx)).rejects.toThrow(
      /not found/
    );
    expect(useWorktreeFilterStore.getState().worktreeLabelColors).toEqual({});
  });
});

describe("worktree.setCustomTitle", () => {
  it("requires an explicit worktree and a title or null", () => {
    const schema = getAction("worktree.setCustomTitle").argsSchema!;
    expect(() => schema.parse({ worktreeId: "wt-main", title: "Integration" })).not.toThrow();
    expect(() => schema.parse({ worktreeId: "wt-main", title: null })).not.toThrow();
    expect(() => schema.parse({ worktreeId: "wt-main" })).toThrow();
    expect(() => schema.parse({ title: "Integration" })).toThrow();
  });

  it("stores the title with whitespace and zero-width characters collapsed", async () => {
    await getAction("worktree.setCustomTitle").run(
      { worktreeId: "wt-main", title: "  Release\u200B   prep \n" },
      ctx
    );

    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({
      "wt-main": "Release prep",
    });
  });

  it("clears with null or a blank title and leaves other worktrees alone", async () => {
    const action = getAction("worktree.setCustomTitle");
    await action.run({ worktreeId: "wt-main", title: "Integration" }, ctx);
    await action.run({ worktreeId: "wt-feature", title: "Spike" }, ctx);

    await action.run({ worktreeId: "wt-main", title: "   " }, ctx);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({
      "wt-feature": "Spike",
    });

    await action.run({ worktreeId: "wt-feature", title: null }, ctx);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({});
  });

  it("accepts 80 code points and rejects 81 rather than truncating", async () => {
    const action = getAction("worktree.setCustomTitle");
    // Astral characters are two UTF-16 units each, so the limit has to count code points.
    const eighty = "\u{1F680}".repeat(80);
    await action.run({ worktreeId: "wt-main", title: eighty }, ctx);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles["wt-main"]).toBe(eighty);

    await expect(action.run({ worktreeId: "wt-main", title: `${eighty}x` }, ctx)).rejects.toThrow(
      /80 characters/
    );
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles["wt-main"]).toBe(eighty);
  });

  it("rejects a worktree this project does not have, writing nothing", async () => {
    await expect(
      getAction("worktree.setCustomTitle").run({ worktreeId: "wt-gone", title: "X" }, ctx)
    ).rejects.toThrow(/not found/);
    expect(useWorktreeFilterStore.getState().worktreeCustomTitles).toEqual({});
  });
});
