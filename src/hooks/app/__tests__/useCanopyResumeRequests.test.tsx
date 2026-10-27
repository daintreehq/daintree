// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanopyResumeRequest } from "@shared/types/ipc/canopy";

const { onResumeRequested, resumeSettled, resumeSessionForPerson, whenWorktreesKnown, store } =
  vi.hoisted(() => ({
    onResumeRequested: vi.fn(),
    resumeSettled: vi.fn(async () => {}),
    resumeSessionForPerson: vi.fn(),
    whenWorktreesKnown: vi.fn(async () => true),
    store: {
      getState: () => ({
        worktrees: new Map([["/repo/wt", { id: "/repo/wt", path: "/repo/wt" }]]),
      }),
    },
  }));

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: { canopy: { onResumeRequested, resumeSettled } },
});
vi.mock("@/services/agentResumeForPerson", () => ({ resumeSessionForPerson }));
vi.mock("@/services/worktreeLanding", () => ({ whenWorktreesKnown }));
vi.mock("@/hooks/useWorktreeStore", () => ({ useWorktreeStoreApi: () => store }));

import { useCanopyResumeRequests } from "../useCanopyResumeRequests";

const session = {
  sessionId: "session-1",
  agentId: "claude",
  worktreeId: "/repo/wt",
  title: null,
  projectId: "p1",
  savedAt: 1,
};

describe("useCanopyResumeRequests", () => {
  let request: (payload: CanopyResumeRequest) => void = () => {};
  const unsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    whenWorktreesKnown.mockResolvedValue(true);
    onResumeRequested.mockImplementation((callback: (payload: CanopyResumeRequest) => void) => {
      request = callback;
      return unsubscribe;
    });
  });

  it("holds a request until the view has hydrated, then answers with the pane that runs it", async () => {
    resumeSessionForPerson.mockResolvedValue({
      terminalId: "term-9",
      outcome: "created",
      worktreeId: "/repo/wt",
    });
    const { rerender } = renderHook(({ loaded }) => useCanopyResumeRequests(loaded), {
      initialProps: { loaded: false },
    });
    act(() => request({ requestId: "r1", session }));
    expect(resumeSessionForPerson).not.toHaveBeenCalled();

    rerender({ loaded: true });
    await vi.waitFor(() => expect(resumeSettled).toHaveBeenCalledWith("r1", { runId: "term-9" }));
    // Resumed against this view's own worktrees, by id and path.
    expect(resumeSessionForPerson).toHaveBeenCalledWith(
      session,
      new Map([["/repo/wt", "/repo/wt"]])
    );
  });

  it("answers why when the resume fails", async () => {
    resumeSessionForPerson.mockRejectedValue(
      new Error("That session's worktree has been removed.")
    );
    renderHook(() => useCanopyResumeRequests(true));
    act(() => request({ requestId: "r2", session }));
    await vi.waitFor(() =>
      expect(resumeSettled).toHaveBeenCalledWith("r2", {
        error: "That session's worktree has been removed.",
      })
    );
  });

  it("resumes nothing while the view never learns its worktrees, and says so", async () => {
    whenWorktreesKnown.mockResolvedValue(false);
    renderHook(() => useCanopyResumeRequests(true));
    act(() => request({ requestId: "r3", session }));
    await vi.waitFor(() =>
      expect(resumeSettled).toHaveBeenCalledWith("r3", {
        error: "The project's worktrees didn't load in time.",
      })
    );
    expect(resumeSessionForPerson).not.toHaveBeenCalled();
  });

  it("stops listening when the view goes", () => {
    const { unmount } = renderHook(() => useCanopyResumeRequests(true));
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
