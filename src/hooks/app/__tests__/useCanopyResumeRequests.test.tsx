// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopyResumeRequest } from "@shared/types/ipc/canopy";

const {
  onResumeRequested,
  resumeStarted,
  resumeSettled,
  resumeSessionForPerson,
  whenWorktreesKnown,
  view,
} = vi.hoisted(() => ({
  onResumeRequested: vi.fn(),
  resumeStarted: vi.fn(async (_requestId: string): Promise<number | null> => 30_000),
  resumeSettled: vi.fn(async () => {}),
  resumeSessionForPerson: vi.fn(),
  whenWorktreesKnown: vi.fn(async () => true),
  view: {
    worktrees: new Map<string, { id: string; path: string }>(),
    isInitialized: true,
    isLoading: false,
  },
}));

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: { canopy: { onResumeRequested, resumeStarted, resumeSettled } },
});
vi.mock("@/services/agentResumeForPerson", () => ({ resumeSessionForPerson }));
vi.mock("@/services/worktreeLanding", () => ({ whenWorktreesKnown }));
vi.mock("@/store/viewWorkspaceId", () => ({ getViewWorkspaceId: () => "p1" }));
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStoreApi: () => ({ getState: () => view }),
}));

import { useCanopyResumeRequests } from "../useCanopyResumeRequests";

const session = {
  sessionId: "session-1",
  agentId: "claude",
  worktreeId: "/repo/wt",
  title: null,
  projectId: "p1",
  savedAt: 1,
};

function asked(requestId: string): CanopyResumeRequest {
  return { requestId, session };
}

describe("useCanopyResumeRequests", () => {
  let request: (payload: CanopyResumeRequest) => void = () => {};
  const unsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    view.worktrees = new Map([["/repo/wt", { id: "/repo/wt", path: "/repo/wt" }]]);
    view.isInitialized = true;
    view.isLoading = false;
    whenWorktreesKnown.mockResolvedValue(true);
    resumeStarted.mockResolvedValue(30_000);
    resumeSessionForPerson.mockResolvedValue({
      terminalId: "term-9",
      outcome: "created",
      worktreeId: "/repo/wt",
    });
    onResumeRequested.mockImplementation((callback: (payload: CanopyResumeRequest) => void) => {
      request = callback;
      return unsubscribe;
    });
  });

  it("holds a request until the view has hydrated, then answers with the pane that runs it", async () => {
    const { rerender } = renderHook(({ loaded }) => useCanopyResumeRequests(loaded), {
      initialProps: { loaded: false },
    });
    act(() => request(asked("r1")));
    expect(resumeSessionForPerson).not.toHaveBeenCalled();

    rerender({ loaded: true });
    await vi.waitFor(() => expect(resumeSettled).toHaveBeenCalledWith("r1", { runId: "term-9" }));
    // The view's own worktree list, by id and path, and no wait for one it has.
    expect(resumeSessionForPerson).toHaveBeenCalledWith(
      session,
      new Map([["/repo/wt", "/repo/wt"]])
    );
    expect(whenWorktreesKnown).not.toHaveBeenCalled();
  });

  it("launches from the session's own place in a view with no worktree list, waiting for none", async () => {
    view.worktrees = new Map();
    renderHook(() => useCanopyResumeRequests(true));
    act(() => request(asked("r2")));
    await vi.waitFor(() => expect(resumeSettled).toHaveBeenCalledWith("r2", { runId: "term-9" }));
    expect(resumeSessionForPerson).toHaveBeenCalledWith(session, null);
    expect(whenWorktreesKnown).not.toHaveBeenCalled();
  });

  it("gives a project still opening a moment for its first worktree list", async () => {
    view.worktrees = new Map();
    view.isLoading = true;
    whenWorktreesKnown.mockImplementation(async () => {
      view.worktrees = new Map([["/repo/wt", { id: "/repo/wt", path: "/repo/wt" }]]);
      return true;
    });
    renderHook(() => useCanopyResumeRequests(true));
    act(() => request(asked("r3")));
    await vi.waitFor(() => expect(resumeSettled).toHaveBeenCalledWith("r3", { runId: "term-9" }));
    expect(resumeSessionForPerson).toHaveBeenCalledWith(
      session,
      new Map([["/repo/wt", "/repo/wt"]])
    );
  });

  it("launches nothing when main's go-ahead arrives too late to land the pane in time", async () => {
    let now = 1_000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    // The wall clock steps back meanwhile: the budget is not timed by it.
    const wall = vi.spyOn(Date, "now").mockReturnValue(0);
    resumeStarted.mockImplementationOnce(async () => {
      // The reply takes the whole launch budget to come back.
      now += 30_000;
      return 30_000;
    });
    try {
      renderHook(() => useCanopyResumeRequests(true));
      act(() => request(asked("r7")));
      await vi.waitFor(() => expect(resumeStarted).toHaveBeenCalledWith("r7"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(resumeSessionForPerson).not.toHaveBeenCalled();
      expect(resumeSettled).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      wall.mockRestore();
    }
  });

  it("answers why when the resume fails", async () => {
    resumeSessionForPerson.mockRejectedValue(
      new Error("That session's worktree has been removed.")
    );
    renderHook(() => useCanopyResumeRequests(true));
    act(() => request(asked("r4")));
    await vi.waitFor(() =>
      expect(resumeSettled).toHaveBeenCalledWith("r4", {
        error: "That session's worktree has been removed.",
      })
    );
  });

  it("claims each request before launching, and never starts one main has stopped waiting for", async () => {
    resumeStarted.mockResolvedValueOnce(null);
    renderHook(() => useCanopyResumeRequests(true));
    act(() => request(asked("r5")));
    await vi.waitFor(() => expect(resumeStarted).toHaveBeenCalledWith("r5"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(resumeSessionForPerson).not.toHaveBeenCalled();
    expect(resumeSettled).not.toHaveBeenCalled();

    act(() => request(asked("r6")));
    await vi.waitFor(() => expect(resumeSettled).toHaveBeenCalledWith("r6", { runId: "term-9" }));
    expect(resumeStarted.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      resumeSessionForPerson.mock.invocationCallOrder[0]!
    );
  });

  it("stops listening when the view goes", () => {
    const { unmount } = renderHook(() => useCanopyResumeRequests(true));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
