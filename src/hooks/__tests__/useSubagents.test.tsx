// @vitest-environment jsdom
import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listSubagents = vi.hoisted(() => vi.fn());
const listClaudeSubagents = vi.hoisted(() => vi.fn());

vi.mock("@/clients/codexClient", () => ({
  codexClient: { listSubagents, readSubagentTranscript: vi.fn() },
}));
vi.mock("@/clients/claudeClient", () => ({
  claudeClient: { listSubagents: listClaudeSubagents, readSubagentTranscript: vi.fn() },
}));

import { __resetSubagentThrottle, useSubagents } from "../useSubagents";
import type { AgentSubagentsResult } from "@shared/types/ipc/agentSubagents";

function ok(id: string): AgentSubagentsResult {
  return {
    status: "ok",
    provider: "codex",
    parentId: "root",
    subagents: [
      {
        id,
        label: null,
        role: null,
        preview: "",
        model: null,
        depth: null,
        status: { type: "idle" },
        createdAt: 0,
        updatedAt: 0,
      },
    ],
  };
}

beforeEach(() => {
  listSubagents.mockReset();
  listClaudeSubagents.mockReset();
  Reflect.set(window, "electron", {});
  __resetSubagentThrottle();
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  vi.useRealTimers();
});

describe("useSubagents", () => {
  it("asks nothing at all when the terminal runs no supported provider", async () => {
    renderHook(() => useSubagents("t1", { provider: null }));
    await waitFor(() => expect(listSubagents).not.toHaveBeenCalled());
    expect(listClaudeSubagents).not.toHaveBeenCalled();
  });

  it("routes the lookup to the provider it was given", async () => {
    listClaudeSubagents.mockResolvedValue(ok("child-1"));
    renderHook(() => useSubagents("t1", { provider: "claude" }));
    await waitFor(() => expect(listClaudeSubagents).toHaveBeenCalled());
    expect(listSubagents).not.toHaveBeenCalled();
  });

  it("issues one lookup when two panes mount the same terminal at once", async () => {
    listSubagents.mockResolvedValue(ok("child-1"));
    renderHook(() => useSubagents("t1", { provider: "codex" }));
    renderHook(() => useSubagents("t1", { provider: "codex" }));
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));
  });

  it("rehydrates a remount from the cached answer instead of asking again", async () => {
    listSubagents.mockResolvedValue(ok("child-1"));
    const first = renderHook(() => useSubagents("t1", { provider: "codex" }));
    await waitFor(() => expect(first.result.current.result?.status).toBe("ok"));
    first.unmount();

    const second = renderHook(() => useSubagents("t1", { provider: "codex" }));
    expect(second.result.current.result?.status).toBe("ok");
    expect(listSubagents).toHaveBeenCalledTimes(1);
  });

  it("gives a manual refresh the answer the throttle would have withheld", async () => {
    listSubagents.mockResolvedValue(ok("child-1"));
    const { result } = renderHook(() => useSubagents("t1", { provider: "codex" }));
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

    act(() => result.current.refresh());
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(2));
  });

  it("does not let a respawned pane adopt the list of the process before it", async () => {
    listSubagents.mockResolvedValue(ok("child-1"));
    const { rerender } = renderHook(
      ({ generation }: { generation: number }) =>
        useSubagents("t1", { provider: "codex", generation }),
      { initialProps: { generation: 1 } }
    );
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

    rerender({ generation: 2 });
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(2));
  });

  it("does not let a pane that switched agents read the other provider's cached list", async () => {
    listSubagents.mockResolvedValue(ok("child-1"));
    listClaudeSubagents.mockResolvedValue(ok("child-2"));
    const { rerender } = renderHook(
      ({ provider }: { provider: "codex" | "claude" }) => useSubagents("t1", { provider }),
      { initialProps: { provider: "codex" } as { provider: "codex" | "claude" } }
    );
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

    rerender({ provider: "claude" });
    await waitFor(() => expect(listClaudeSubagents).toHaveBeenCalledTimes(1));
  });

  it("looks again once the parent settles, but not while it is still working", async () => {
    listSubagents.mockResolvedValue(ok("child-1"));
    const { rerender } = renderHook(
      ({ agentState }: { agentState: "working" | "completed" }) =>
        useSubagents("t1", { provider: "codex", agentState }),
      { initialProps: { agentState: "working" } as { agentState: "working" | "completed" } }
    );
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

    // The settle refetch is still throttled — the mount lookup was moments ago.
    rerender({ agentState: "completed" });
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));
  });

  it("names the provider's own failure when the lookup itself rejects", async () => {
    listClaudeSubagents.mockRejectedValue(new Error("EACCES"));
    const { result } = renderHook(() => useSubagents("t1", { provider: "claude" }));
    await waitFor(() =>
      expect(result.current.result).toEqual({
        status: "unavailable",
        reason: "store-unreadable",
      })
    );
  });
});
