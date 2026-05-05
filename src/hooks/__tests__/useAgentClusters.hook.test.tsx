// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import type { TerminalInstance } from "@shared/types";

const { useWorktreeStoreMock } = vi.hoisted(() => ({
  useWorktreeStoreMock: vi.fn(),
}));

vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: useWorktreeStoreMock,
}));

import { useAgentClusters } from "../useAgentClusters";
import { _resetWorktreeIdCacheForTests } from "../useTerminalSelectors";

function makeAgent(id: string, overrides: Partial<TerminalInstance> = {}): TerminalInstance {
  return {
    id,
    title: id,
    kind: "terminal",
    detectedAgentId: "claude",
    worktreeId: "wt-1",
    location: "grid",
    agentState: "idle",
    hasPty: true,
    ...overrides,
  } as TerminalInstance;
}

function seedPanels(terminals: TerminalInstance[]): void {
  const panelsById: Record<string, TerminalInstance> = {};
  const panelIds: string[] = [];
  for (const t of terminals) {
    panelsById[t.id] = t;
    panelIds.push(t.id);
  }
  usePanelStore.setState({ panelsById, panelIds });
}

function seedWorktrees(ids: string[]): void {
  const worktrees = new Map(ids.map((id) => [id, { id, worktreeId: id }]));
  useWorktreeStoreMock.mockImplementation(
    (selector: (state: { worktrees: typeof worktrees }) => unknown) => selector({ worktrees })
  );
}

describe("useAgentClusters (hook integration)", () => {
  beforeEach(() => {
    _resetWorktreeIdCacheForTests();
    usePanelStore.setState({ panelsById: {}, panelIds: [] });
    useWorktreeStoreMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when fewer than 2 eligible agents exist", () => {
    seedWorktrees(["wt-1"]);
    seedPanels([
      makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: 1 }),
    ]);
    const { result } = renderHook(() => useAgentClusters());
    expect(result.current).toBeNull();
  });

  it("detects a waiting cluster with 2 eligible agents", () => {
    seedWorktrees(["wt-1"]);
    seedPanels([
      makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: 1 }),
      makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: 2 }),
    ]);
    const { result } = renderHook(() => useAgentClusters());
    expect(result.current?.type).toBe("waiting");
    expect(result.current?.memberIds).toEqual(["a", "b"]);
  });

  it("excludes orphaned-worktree terminals (critical: matches WaitingContainer visibility)", () => {
    seedWorktrees(["wt-1"]); // wt-gone is NOT in the active set
    seedPanels([
      makeAgent("a", {
        agentState: "waiting",
        waitingReason: "prompt",
        lastStateChange: 1,
        worktreeId: "wt-1",
      }),
      makeAgent("b", {
        agentState: "waiting",
        waitingReason: "prompt",
        lastStateChange: 2,
        worktreeId: "wt-gone",
      }),
    ]);
    const { result } = renderHook(() => useAgentClusters());
    expect(result.current).toBeNull();
  });

  it("recomputes when panelStore updates (reactive)", () => {
    seedWorktrees(["wt-1"]);
    seedPanels([
      makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: 1 }),
    ]);
    const { result } = renderHook(() => useAgentClusters());
    expect(result.current).toBeNull();

    act(() => {
      seedPanels([
        makeAgent("a", { agentState: "waiting", waitingReason: "prompt", lastStateChange: 1 }),
        makeAgent("b", { agentState: "waiting", waitingReason: "prompt", lastStateChange: 2 }),
      ]);
    });

    expect(result.current?.type).toBe("waiting");
    expect(result.current?.count).toBe(2);
  });

  it("completion cluster expires lazily when Date.now() moves past the 30s window on next update", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z").getTime());
    const start = Date.now();
    seedWorktrees(["wt-1"]);
    seedPanels([
      makeAgent("a", { agentState: "completed", lastStateChange: start - 1_000 }),
      makeAgent("b", { agentState: "completed", lastStateChange: start - 2_000 }),
    ]);
    const { result } = renderHook(() => useAgentClusters());
    expect(result.current?.type).toBe("completion");

    act(() => {
      vi.setSystemTime(start + 60_000);
      seedPanels([
        makeAgent("a", { agentState: "completed", lastStateChange: start - 1_000 }),
        makeAgent("b", { agentState: "completed", lastStateChange: start - 2_000 }),
      ]);
    });

    expect(result.current).toBeNull();
  });
});
