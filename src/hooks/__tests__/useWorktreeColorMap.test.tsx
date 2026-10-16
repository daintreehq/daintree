// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createStore, useStore, type StoreApi } from "zustand";

type Worktrees = Map<string, { path: string; branch?: string }>;

const viewStore = vi.hoisted(() => ({
  current: null as null | StoreApi<{ worktrees: Worktrees }>,
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: <T,>(selector: (state: { worktrees: Worktrees }) => T): T =>
    useStore(viewStore.current!, selector),
}));

import { useWorktreeColorMap } from "../useWorktreeColorMap";
import { useWorktreeFilterStore } from "@/store/worktreeFilterStore";

function seed(worktrees: Worktrees) {
  viewStore.current = createStore<{ worktrees: Worktrees }>()(() => ({ worktrees }));
}

beforeEach(() => {
  useWorktreeFilterStore.setState({ worktreeLabelColors: {} });
});

describe("useWorktreeColorMap (#13408)", () => {
  it("reaches the map when a label changes, with no change to the worktree set", () => {
    seed(
      new Map([
        ["wt-a", { path: "/p/a" }],
        ["wt-b", { path: "/p/b" }],
      ])
    );
    const { result } = renderHook(() => useWorktreeColorMap());
    const automaticA = result.current!["wt-a"];

    act(() => useWorktreeFilterStore.getState().setWorktreeLabelColor("wt-a", "category-pink"));
    expect(result.current!["wt-a"]).toBe("var(--theme-category-pink)");

    act(() => useWorktreeFilterStore.getState().setWorktreeLabelColor("wt-a", null));
    expect(result.current!["wt-a"]).toBe(automaticA);
  });

  it("shows a label on a lone worktree and returns to suppression when cleared", () => {
    seed(new Map([["wt-main", { path: "/p/main" }]]));
    const { result } = renderHook(() => useWorktreeColorMap());
    expect(result.current).toBeNull();

    act(() => useWorktreeFilterStore.getState().setWorktreeLabelColor("wt-main", "category-teal"));
    expect(result.current).toEqual({ "wt-main": "var(--theme-category-teal)" });

    act(() => useWorktreeFilterStore.getState().setWorktreeLabelColor("wt-main", null));
    expect(result.current).toBeNull();
  });

  it("keeps the same map through a poll that changes nothing but other fields", () => {
    seed(
      new Map([
        ["wt-a", { path: "/p/a" }],
        ["wt-b", { path: "/p/b" }],
      ])
    );
    act(() => useWorktreeFilterStore.getState().setWorktreeLabelColor("wt-b", "category-blue"));
    const { result } = renderHook(() => useWorktreeColorMap());
    const before = result.current;

    act(() =>
      viewStore.current!.setState({
        worktrees: new Map([
          ["wt-a", { path: "/p/a", branch: "polled" }],
          ["wt-b", { path: "/p/b" }],
        ]),
      })
    );

    expect(result.current).toBe(before);
  });
});
