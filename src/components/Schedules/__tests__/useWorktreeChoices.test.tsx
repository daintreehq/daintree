// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const store = vi.hoisted(() => ({
  worktrees: [] as Array<{
    id: string;
    path: string;
    name: string;
    branch?: string;
    isMainWorktree: boolean;
  }>,
  isInitialized: true,
  isLoading: false,
  isReconnecting: false,
  error: null as string | null,
}));
vi.mock("@/hooks/useWorktrees", () => ({ useWorktrees: () => ({ ...store }) }));

import { useWorktreeChoices } from "../useWorktreeChoices";

const MAIN = { id: "/repo", path: "/repo", name: "repo", branch: "main", isMainWorktree: true };
const FEATURE = {
  id: "/repo-worktrees/feature",
  path: "/repo-worktrees/feature",
  name: "feature",
  branch: "feature/x",
  isMainWorktree: false,
};

function setStore(next: Partial<typeof store>) {
  Object.assign(store, next);
}

afterEach(() => {
  cleanup();
  setStore({
    worktrees: [],
    isInitialized: true,
    isLoading: false,
    isReconnecting: false,
    error: null,
  });
});

describe("useWorktreeChoices — when the worktrees are known (#17467)", () => {
  it("has no ids before the host has reported, so a target can't be called missing", () => {
    setStore({ worktrees: [MAIN], isInitialized: false });
    expect(renderHook(() => useWorktreeChoices()).result.current.ids).toBeNull();
  });

  it("has no ids while the list is loading", () => {
    setStore({ worktrees: [MAIN], isLoading: true });
    expect(renderHook(() => useWorktreeChoices()).result.current.ids).toBeNull();
  });

  it("has no ids after a failed read", () => {
    setStore({ worktrees: [MAIN], error: "worktree host unreachable" });
    expect(renderHook(() => useWorktreeChoices()).result.current.ids).toBeNull();
  });

  it("has no ids for an initialized but empty list, which only says the host hasn't reported", () => {
    expect(renderHook(() => useWorktreeChoices()).result.current.ids).toBeNull();
  });

  it("keeps the names it has but no ids through a reconnect", () => {
    setStore({ worktrees: [MAIN, FEATURE], isReconnecting: true });
    const { ids, labels } = renderHook(() => useWorktreeChoices()).result.current;
    expect(ids).toBeNull();
    expect(labels.get(FEATURE.id)).toBe("feature/x");
  });

  it("lists every worktree's id once the read has succeeded", () => {
    setStore({ worktrees: [MAIN, FEATURE] });
    const { ids, labels } = renderHook(() => useWorktreeChoices()).result.current;
    expect(ids).toEqual(new Set([MAIN.id, FEATURE.id]));
    expect(labels.get(FEATURE.id)).toBe("feature/x");
    expect(labels.has(MAIN.id)).toBe(false);
  });

  it("settles when the same list stops reconnecting", () => {
    setStore({ worktrees: [MAIN, FEATURE], isReconnecting: true });
    const view = renderHook(() => useWorktreeChoices());
    expect(view.result.current.ids).toBeNull();

    setStore({ isReconnecting: false });
    view.rerender();

    expect(view.result.current.ids).toEqual(new Set([MAIN.id, FEATURE.id]));
  });

  it("drops an id when the worktree is removed while the read stays ready", () => {
    setStore({ worktrees: [MAIN, FEATURE] });
    const view = renderHook(() => useWorktreeChoices());
    expect(view.result.current.ids).toEqual(new Set([MAIN.id, FEATURE.id]));

    setStore({ worktrees: [MAIN] });
    view.rerender();

    expect(view.result.current.ids).toEqual(new Set([MAIN.id]));
    expect(view.result.current.labels.has(FEATURE.id)).toBe(false);
  });
});
