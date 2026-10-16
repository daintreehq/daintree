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

function getAction() {
  const actions: ActionRegistry = new Map();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the action reaches no callback; same stub the sibling suites use.
  const callbacks = {} as unknown as ActionCallbacks;
  registerWorktreeContextActions(actions, callbacks);
  const factory = actions.get("worktree.setLabelColor");
  if (!factory) throw new Error("worktree.setLabelColor is not registered");
  return factory();
}

const ctx = {} as ActionContext;

beforeEach(() => {
  worktreesMock.current = new Map([
    ["wt-main", { id: "wt-main", path: "/repo", isMainWorktree: true }],
    ["wt-feature", { id: "wt-feature", path: "/repo-wt/feature" }],
  ]);
  useWorktreeFilterStore.setState({ worktreeLabelColors: {} });
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
