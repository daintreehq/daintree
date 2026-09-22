// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { WorktreeState } from "@/types";
import type { OrderBy } from "@/store/worktreeFilterStore";

const { worktreesRef, prefsRef, emptyWorktrees, seenOptions } = vi.hoisted(() => ({
  worktreesRef: { current: [] as unknown[] },
  prefsRef: {
    current: {
      orderBy: "alpha" as OrderBy,
      groupByType: false,
      pinnedWorktrees: [] as string[],
      manualOrder: [] as string[],
    },
  },
  // `useWorktrees` hands gated consumers the same array every render, so the
  // mock does too — otherwise the disabled-stability test would pass for the
  // wrong reason.
  emptyWorktrees: [] as unknown[],
  // Records what the hook actually asked `useWorktrees` for, so the gate is
  // pinned rather than inferred from the empty result the prefs gate produces
  // on its own.
  seenOptions: { current: undefined as { enabled?: boolean } | undefined },
}));

vi.mock("@/hooks/useWorktrees", () => ({
  useWorktrees: (options?: { enabled?: boolean }) => {
    seenOptions.current = options;
    return { worktrees: options?.enabled === false ? emptyWorktrees : worktreesRef.current };
  },
}));

vi.mock("@/store/worktreeFilterStore", () => ({
  useWorktreeFilterStore: (selector: (state: unknown) => unknown) => selector(prefsRef.current),
}));

import { useSidebarWorktreeOrder } from "../useSidebarWorktreeOrder";

const T = 1_700_000_000_000;

const createWorktree = (overrides: Partial<WorktreeState>): WorktreeState =>
  ({
    id: "id",
    path: "/repo",
    name: "name",
    branch: "feature/x",
    isCurrent: false,
    isMainWorktree: false,
    worktreeChanges: null,
    lastActivityTimestamp: null,
    ...overrides,
  }) as WorktreeState;

const main = createWorktree({ id: "m", name: "repo", branch: "main", isMainWorktree: true });
const feature = createWorktree({
  id: "f",
  name: "feature-1",
  branch: "feature/one",
  createdAt: T + 100,
});
const bugfix = createWorktree({
  id: "b",
  name: "bugfix-1",
  branch: "bugfix/one",
  createdAt: T + 50,
});

const ids = (worktrees: readonly WorktreeState[]) => worktrees.map((w) => w.id);

describe("useSidebarWorktreeOrder", () => {
  beforeEach(() => {
    worktreesRef.current = [bugfix, feature, main];
    prefsRef.current = {
      orderBy: "alpha",
      groupByType: false,
      pinnedWorktrees: [],
      manualOrder: [],
    };
  });

  it("returns every worktree in the sidebar's order", () => {
    const { result } = renderHook(() => useSidebarWorktreeOrder());
    expect(ids(result.current)).toEqual(["m", "b", "f"]);
  });

  it("honours the pinned preference", () => {
    prefsRef.current = { ...prefsRef.current, pinnedWorktrees: ["f"] };
    const { result } = renderHook(() => useSidebarWorktreeOrder());
    expect(ids(result.current)).toEqual(["m", "f", "b"]);
  });

  it("honours the grouping preference", () => {
    prefsRef.current = { ...prefsRef.current, groupByType: true };
    const { result } = renderHook(() => useSidebarWorktreeOrder());
    // TYPE_ORDER puts features ahead of bugfixes, unlike the flat name sort.
    expect(ids(result.current)).toEqual(["m", "f", "b"]);
  });

  it("re-orders when the orderBy preference changes", () => {
    const { result, rerender } = renderHook(() => useSidebarWorktreeOrder());
    expect(ids(result.current)).toEqual(["m", "b", "f"]);

    prefsRef.current = { ...prefsRef.current, orderBy: "created" };
    rerender();
    expect(ids(result.current)).toEqual(["m", "f", "b"]);
  });

  it("keeps the same array identity while nothing changes", () => {
    const { result, rerender } = renderHook(() => useSidebarWorktreeOrder());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("forwards the gate to useWorktrees so a closed picker stops subscribing", () => {
    renderHook(() => useSidebarWorktreeOrder({ enabled: false }));
    expect(seenOptions.current).toEqual({ enabled: false });

    renderHook(() => useSidebarWorktreeOrder());
    expect(seenOptions.current).toEqual({ enabled: true });
  });

  it("ignores worktree changes while disabled", () => {
    const { result, rerender } = renderHook(() => useSidebarWorktreeOrder({ enabled: false }));
    const first = result.current;

    worktreesRef.current = [main, feature];
    rerender();
    expect(result.current).toBe(first);
    expect(result.current).toEqual([]);
  });

  it("short-circuits to a stable empty array when disabled", () => {
    const { result, rerender } = renderHook(() => useSidebarWorktreeOrder({ enabled: false }));
    const first = result.current;
    expect(first).toEqual([]);

    // A preference change must not churn a picker that is closed.
    prefsRef.current = { ...prefsRef.current, orderBy: "created" };
    rerender();
    expect(result.current).toBe(first);
  });

  it("picks up the current data and preferences when re-enabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useSidebarWorktreeOrder({ enabled }),
      { initialProps: { enabled: false } }
    );
    expect(result.current).toEqual([]);

    prefsRef.current = { ...prefsRef.current, pinnedWorktrees: ["f"] };
    rerender({ enabled: true });
    expect(ids(result.current)).toEqual(["m", "f", "b"]);
  });
});
