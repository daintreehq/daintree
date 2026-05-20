import { describe, expect, it } from "vitest";
import type { ActionRegistry, AnyActionDefinition } from "../../actionTypes";
import { registerWorktreeBulkActions } from "../worktreeBulkActions";

function setupActions(): ActionRegistry {
  const actions: ActionRegistry = new Map();
  registerWorktreeBulkActions(actions);
  return actions;
}

function get(actions: ActionRegistry, id: string): AnyActionDefinition {
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  return factory() as AnyActionDefinition;
}

describe("worktreeBulkActions registration", () => {
  it("registers worktree.bulk.closeSessions", () => {
    const actions = setupActions();
    expect(actions.has("worktree.bulk.closeSessions")).toBe(true);
  });

  it("registers worktree.bulk.remove", () => {
    const actions = setupActions();
    expect(actions.has("worktree.bulk.remove")).toBe(true);
  });

  it("worktree.bulk.closeSessions is danger:'confirm' so it is excluded from repeat-last and MRU", () => {
    const def = get(setupActions(), "worktree.bulk.closeSessions");
    expect(def.danger).toBe("confirm");
  });

  it("worktree.bulk.remove is danger:'confirm' so the D3 typed-name gate cannot be bypassed via palette", () => {
    const def = get(setupActions(), "worktree.bulk.remove");
    expect(def.danger).toBe("confirm");
  });

  it("both bulk actions live in the 'worktree' category", () => {
    const actions = setupActions();
    expect(get(actions, "worktree.bulk.closeSessions").category).toBe("worktree");
    expect(get(actions, "worktree.bulk.remove").category).toBe("worktree");
  });

  it("both bulk actions are renderer-scoped (no main-process IPC dispatch path)", () => {
    const actions = setupActions();
    expect(get(actions, "worktree.bulk.closeSessions").scope).toBe("renderer");
    expect(get(actions, "worktree.bulk.remove").scope).toBe("renderer");
  });

  it("carry a dangerRationale so the action manifest can surface why the gate exists", () => {
    const actions = setupActions();
    expect(get(actions, "worktree.bulk.closeSessions").dangerRationale).toBeTruthy();
    expect(get(actions, "worktree.bulk.remove").dangerRationale).toBeTruthy();
  });
});
