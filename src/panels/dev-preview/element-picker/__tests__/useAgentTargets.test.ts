// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { usePanelStore } from "@/store/panelStore";
import { useAgentTargets } from "../useAgentTargets";

function agent(id: string, worktreeId?: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: "terminal",
    hasPty: true,
    location: "grid",
    launchAgentId: "claude",
    agentState: "idle",
    title: id,
    ...(worktreeId ? { worktreeId } : {}),
    ...extra,
  };
}

function seed(panels: Array<ReturnType<typeof agent>>) {
  usePanelStore.setState({
    panelIds: panels.map((p) => p.id),
    panelsById: Object.fromEntries(panels.map((p) => [p.id, p])) as never,
  });
}

afterEach(() => usePanelStore.setState({ panelIds: [], panelsById: {} as never }));

describe("useAgentTargets", () => {
  it("lists worktree-less agent panels for a null worktree and skips bound ones", () => {
    seed([agent("free"), agent("bound", "wt-1"), agent("gone", undefined, { location: "trash" })]);
    const { result } = renderHook(() => useAgentTargets(null));
    expect(result.current.map((t) => t.terminalId)).toEqual(["free"]);
  });

  it("keeps a worktree inspector to its own worktree, never worktree-less panels", () => {
    seed([agent("free"), agent("bound", "wt-1"), agent("other", "wt-2")]);
    const { result } = renderHook(() => useAgentTargets("wt-1"));
    expect(result.current.map((t) => t.terminalId)).toEqual(["bound"]);
  });
});
