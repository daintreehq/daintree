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

import {
  CLAUDE_SUBAGENT_POLL_MS,
  SUBAGENT_REFRESH_THROTTLE_MS,
  __resetSubagentThrottle,
  useSubagents,
} from "../useSubagents";
import type { AgentSubagentStatus, AgentSubagentsResult } from "@shared/types/ipc/agentSubagents";

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

function claudeOk(...statuses: AgentSubagentStatus[]): AgentSubagentsResult {
  return {
    status: "ok",
    provider: "claude",
    parentId: "root",
    subagents: statuses.map((status, index) => ({
      id: `child-${index}`,
      label: null,
      role: null,
      preview: "",
      model: null,
      depth: null,
      status,
      createdAt: 0,
      updatedAt: 0,
    })),
  };
}

/** Let the mount lookup land, then step the clock one poll at a time. */
async function advancePolls(polls: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  for (let i = 0; i < polls; i += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLAUDE_SUBAGENT_POLL_MS);
    });
  }
}

beforeEach(() => {
  listSubagents.mockReset();
  listClaudeSubagents.mockReset();
  Reflect.set(window, "electron", {});
  __resetSubagentThrottle();
});

afterEach(() => {
  Reflect.deleteProperty(window, "electron");
  vi.restoreAllMocks();
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

  it("hands a lookup's answer to a pane that remounted while it was running", async () => {
    let answer: (value: AgentSubagentsResult) => void = () => {};
    listSubagents.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const first = renderHook(() => useSubagents("t1", { provider: "codex" }));
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));
    first.unmount();

    const second = renderHook(() => useSubagents("t1", { provider: "codex" }));
    expect(second.result.current.isLoading).toBe(true);
    await act(async () => answer(ok("child-1")));

    expect(second.result.current.result).toEqual(ok("child-1"));
    expect(second.result.current.isLoading).toBe(false);
    expect(listSubagents).toHaveBeenCalledTimes(1);
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

  it("holds the settle refetch inside the throttle window and takes it once past", async () => {
    listSubagents.mockResolvedValue(ok("child-1"));
    const nowSpy = vi.spyOn(Date, "now");
    nowSpy.mockReturnValue(1_000_000);

    const { rerender } = renderHook(
      ({ agentState }: { agentState: "working" | "completed" }) =>
        useSubagents("t1", { provider: "codex", agentState }),
      { initialProps: { agentState: "working" } as { agentState: "working" | "completed" } }
    );
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

    // Moments after the mount lookup: the settle is absorbed by the throttle.
    rerender({ agentState: "completed" });
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(1));

    // Past the window, the same transition is worth a query.
    nowSpy.mockReturnValue(1_000_000 + SUBAGENT_REFRESH_THROTTLE_MS + 1);
    rerender({ agentState: "working" });
    rerender({ agentState: "completed" });
    await waitFor(() => expect(listSubagents).toHaveBeenCalledTimes(2));
  });

  it("does not leave a respawned pane showing the list of the process before it", async () => {
    let releaseCodex: ((value: AgentSubagentsResult) => void) | undefined;
    listSubagents.mockResolvedValueOnce(ok("old-child")).mockImplementationOnce(
      () =>
        new Promise<AgentSubagentsResult>((resolve) => {
          releaseCodex = resolve;
        })
    );

    const { result, rerender } = renderHook(
      ({ generation }: { generation: number }) =>
        useSubagents("t1", { provider: "codex", generation }),
      { initialProps: { generation: 1 } }
    );
    await waitFor(() => expect(result.current.result?.status).toBe("ok"));

    rerender({ generation: 2 });
    // The dead process's children must not stand in for the new one's.
    expect(result.current.result).toBeNull();

    await act(async () => {
      releaseCodex?.(ok("new-child"));
    });
    await waitFor(() =>
      expect(result.current.result?.status === "ok" && result.current.result.subagents[0]?.id).toBe(
        "new-child"
      )
    );
  });

  it("ignores a lookup that lands after the pane has moved to another agent", async () => {
    let releaseCodex: ((value: AgentSubagentsResult) => void) | undefined;
    listSubagents.mockImplementation(
      () =>
        new Promise<AgentSubagentsResult>((resolve) => {
          releaseCodex = resolve;
        })
    );
    listClaudeSubagents.mockResolvedValue({
      status: "ok",
      provider: "claude",
      parentId: "root",
      subagents: [],
    });

    const { result, rerender } = renderHook(
      ({ provider }: { provider: "codex" | "claude" }) => useSubagents("t1", { provider }),
      { initialProps: { provider: "codex" } as { provider: "codex" | "claude" } }
    );
    await waitFor(() => expect(listSubagents).toHaveBeenCalled());

    rerender({ provider: "claude" });
    await waitFor(() => expect(result.current.result?.status).toBe("ok"));

    // The stale Codex answer arrives last and must not overwrite Claude's.
    await act(async () => {
      releaseCodex?.(ok("stale-codex-child"));
    });
    expect(result.current.result?.status === "ok" && result.current.result.provider).toBe("claude");
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

  it("keeps the list it already read when a refresh fails to answer", async () => {
    listSubagents.mockResolvedValueOnce(ok("child-1"));
    const { result } = renderHook(() => useSubagents("t1", { provider: "codex" }));
    await waitFor(() => expect(result.current.result?.status).toBe("ok"));

    listSubagents.mockRejectedValueOnce(new Error("app-server exited"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshError).toBe("protocol-error"));
    expect(result.current.result).toEqual(ok("child-1"));

    // A remount inside the throttle window rehydrates to the list, not the
    // failure, and still says the list is the old one.
    const again = renderHook(() => useSubagents("t1", { provider: "codex" }));
    expect(again.result.current.result).toEqual(ok("child-1"));
    expect(again.result.current.refreshError).toBe("protocol-error");

    listSubagents.mockResolvedValueOnce(ok("child-2"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.result).toEqual(ok("child-2")));
    expect(result.current.refreshError).toBeNull();
  });

  it("drops the list when a refresh says the session can no longer be identified", async () => {
    listSubagents.mockResolvedValueOnce(ok("child-1"));
    const { result } = renderHook(() => useSubagents("t1", { provider: "codex" }));
    await waitFor(() => expect(result.current.result?.status).toBe("ok"));

    // Fail closed: another terminal's children would look exactly like these.
    listSubagents.mockResolvedValueOnce({ status: "unavailable", reason: "ambiguous-session" });
    act(() => result.current.refresh());
    await waitFor(() =>
      expect(result.current.result).toEqual({ status: "unavailable", reason: "ambiguous-session" })
    );
    expect(result.current.refreshError).toBeNull();
  });

  describe("live polling", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
    });

    it("keeps asking Claude while the parent is working, so a first child is found", async () => {
      listClaudeSubagents.mockResolvedValue(claudeOk());
      const { unmount } = renderHook(() =>
        useSubagents("t1", { provider: "claude", agentState: "working" })
      );

      await advancePolls(2);
      expect(listClaudeSubagents).toHaveBeenCalledTimes(3);
      unmount();
    });

    it("keeps asking after the parent settles while a child is still running", async () => {
      listClaudeSubagents.mockResolvedValue(claudeOk({ type: "working" }, { type: "completed" }));
      const { unmount } = renderHook(() =>
        useSubagents("t1", { provider: "claude", agentState: "idle" })
      );

      await advancePolls(1);
      expect(listClaudeSubagents).toHaveBeenCalledTimes(2);
      unmount();
    });

    it("stops once the parent has settled and nothing it spawned is live", async () => {
      // Unknown is not live: a quiet child nobody can account for does not
      // keep the poll alive any more than a finished one does.
      listClaudeSubagents.mockResolvedValue(
        claudeOk({ type: "completed" }, { type: "unknown", reason: "stale" })
      );
      const { unmount } = renderHook(() =>
        useSubagents("t1", { provider: "claude", agentState: "idle" })
      );

      await advancePolls(3);
      expect(listClaudeSubagents).toHaveBeenCalledTimes(1);
      unmount();
    });

    it("stops asking when the pane unmounts", async () => {
      listClaudeSubagents.mockResolvedValue(claudeOk({ type: "working" }));
      const { unmount } = renderHook(() =>
        useSubagents("t1", { provider: "claude", agentState: "working" })
      );
      await advancePolls(0);
      unmount();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(CLAUDE_SUBAGENT_POLL_MS * 3);
      });
      expect(listClaudeSubagents).toHaveBeenCalledTimes(1);
    });

    it("finds a child spawned just before the parent settles, inside the poll interval", async () => {
      listClaudeSubagents.mockResolvedValueOnce(claudeOk());
      listClaudeSubagents.mockResolvedValue(claudeOk({ type: "working" }));
      const { result, rerender, unmount } = renderHook(
        ({ agentState }: { agentState: "working" | "idle" }) =>
          useSubagents("t1", { provider: "claude", agentState }),
        { initialProps: { agentState: "working" } as { agentState: "working" | "idle" } }
      );
      await advancePolls(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      rerender({ agentState: "idle" });
      await advancePolls(0);

      expect(listClaudeSubagents).toHaveBeenCalledTimes(2);
      expect(
        result.current.result?.status === "ok" && result.current.result.subagents
      ).toHaveLength(1);
      unmount();
    });

    it("keeps to the poll interval when each lookup takes a while to answer", async () => {
      listClaudeSubagents.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(claudeOk()), 200))
      );
      const { unmount } = renderHook(() =>
        useSubagents("t1", { provider: "claude", agentState: "working" })
      );

      await advancePolls(3);
      expect(listClaudeSubagents).toHaveBeenCalledTimes(4);
      unmount();
    });

    it("refreshes in the background without showing the list as loading", async () => {
      listClaudeSubagents.mockResolvedValueOnce(claudeOk({ type: "working" }));
      listClaudeSubagents.mockReturnValue(new Promise(() => {}));
      const { result, unmount } = renderHook(() =>
        useSubagents("t1", { provider: "claude", agentState: "working" })
      );

      await advancePolls(1);
      expect(listClaudeSubagents).toHaveBeenCalledTimes(2);
      expect(result.current.isLoading).toBe(false);
      unmount();
    });

    it("never polls Codex, whose every lookup spawns a process", async () => {
      listSubagents.mockResolvedValue(ok("child-1"));
      const { unmount } = renderHook(() =>
        useSubagents("t1", { provider: "codex", agentState: "working" })
      );

      await advancePolls(3);
      expect(listSubagents).toHaveBeenCalledTimes(1);
      unmount();
    });
  });
});
