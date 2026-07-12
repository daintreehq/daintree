// @vitest-environment jsdom
/**
 * useProjectSwitcherPalette — scratch create/rename actions (issue #11075).
 *
 * Create threads an optional name through to the store and switches to the new
 * scratch. The retry path is the interesting part: a failure AFTER the scratch
 * exists must resume at the switch, never create a second workspace.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { useProjectStoreMock, notifyMock, projectStatsState, scratchState } = vi.hoisted(() => {
  const projectStatsState = {
    stats: {} as Record<
      string,
      { activeAgentCount: number; waitingAgentCount: number; processCount: number }
    >,
  };

  const projectState = {
    projects: [],
    currentProject: null as { id: string } | null,
    switchProject: vi.fn().mockResolvedValue(undefined),
    reopenProject: vi.fn().mockResolvedValue(undefined),
    loadProjects: vi.fn().mockResolvedValue(undefined),
    addProject: vi.fn().mockResolvedValue(undefined),
    closeProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    closeActiveProject: vi.fn().mockResolvedValue({ processesKilled: 0 }),
    removeProject: vi.fn().mockResolvedValue(undefined),
    locateProject: vi.fn().mockResolvedValue(undefined),
  };

  const useProjectStoreMock = Object.assign(
    vi.fn((selector: (state: typeof projectState) => unknown) => selector(projectState)),
    { getState: () => projectState }
  );

  const scratchState = {
    scratches: [],
    currentScratch: null,
    loadScratches: vi.fn().mockResolvedValue(undefined),
    createScratch: vi.fn(),
    switchScratch: vi.fn(),
    removeScratch: vi.fn().mockResolvedValue(undefined),
    renameScratch: vi.fn(),
  };

  return {
    useProjectStoreMock,
    notifyMock: vi.fn().mockReturnValue(""),
    projectStatsState,
    scratchState,
  };
});

vi.mock("@/clients", () => ({
  projectClient: {
    prefetchHydrate: vi.fn().mockResolvedValue(undefined),
    getBulkStats: vi.fn().mockResolvedValue({}),
  },
  scratchClient: {
    saveAsProject: vi.fn().mockResolvedValue({ status: "cancelled" }),
  },
}));

vi.mock("@/store/projectStore", () => ({ useProjectStore: useProjectStoreMock }));

vi.mock("@/store/projectStatsStore", () => ({
  useProjectStatsStore: Object.assign(
    vi.fn((selector: (state: typeof projectStatsState) => unknown) => selector(projectStatsState)),
    {
      getState: () => ({
        stats: projectStatsState.stats,
        setStats: (stats: typeof projectStatsState.stats) => {
          projectStatsState.stats = stats;
        },
      }),
    }
  ),
}));

vi.mock("@/store/projectSettingsStore", () => ({
  useProjectSettingsStore: Object.assign(
    vi.fn((selector?: (state: unknown) => unknown) =>
      selector ? selector({ loadNotificationOverridesForProjects: vi.fn() }) : undefined
    ),
    { getState: () => ({ loadNotificationOverridesForProjects: vi.fn() }) }
  ),
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: vi.fn((selector?: (s: typeof scratchState) => unknown) =>
    selector ? selector(scratchState) : scratchState
  ),
}));

vi.mock("@/lib/notify", () => ({ notify: notifyMock }));

import { useProjectSwitcherPalette } from "../useProjectSwitcherPalette";

/** Pulls the "Try again" handler out of the last error notification. */
function lastRetryAction(): () => Promise<void> {
  const call = notifyMock.mock.calls.at(-1)?.[0] as
    | { actions?: { label: string; onClick: () => Promise<void> }[] }
    | undefined;
  const action = call?.actions?.find((a) => a.label === "Try again");
  if (!action) throw new Error("expected a Try again action on the error notification");
  return action.onClick;
}

beforeEach(() => {
  vi.clearAllMocks();
  scratchState.createScratch.mockResolvedValue({ id: "scratch-1" });
  scratchState.switchScratch.mockResolvedValue(undefined);
  scratchState.renameScratch.mockResolvedValue(undefined);
});

describe("createScratch", () => {
  it("forwards a trimmed name and switches to the new scratch", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.createScratch("  Retry queue spike  ");
    });

    expect(scratchState.createScratch).toHaveBeenCalledWith("Retry queue spike");
    expect(scratchState.switchScratch).toHaveBeenCalledWith("scratch-1");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("forwards undefined for a blank name so main applies its own default", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.createScratch("   ");
    });

    expect(scratchState.createScratch).toHaveBeenCalledWith(undefined);
  });

  it("forwards undefined when no name is supplied at all", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.createScratch();
    });

    expect(scratchState.createScratch).toHaveBeenCalledWith(undefined);
  });

  it("retries creation with the same name when creation itself failed", async () => {
    scratchState.createScratch.mockRejectedValueOnce(new Error("disk full"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.createScratch("Named");
    });
    expect(scratchState.switchScratch).not.toHaveBeenCalled();

    await act(async () => {
      await lastRetryAction()();
    });

    expect(scratchState.createScratch).toHaveBeenCalledTimes(2);
    expect(scratchState.createScratch).toHaveBeenLastCalledWith("Named");
    expect(scratchState.switchScratch).toHaveBeenCalledWith("scratch-1");
  });

  it("does not create a second scratch when only the switch failed", async () => {
    scratchState.switchScratch.mockRejectedValueOnce(new Error("view busy"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.createScratch("Named");
    });

    await act(async () => {
      await lastRetryAction()();
    });

    // The scratch already exists; retrying must resume at the switch, or the
    // first workspace is orphaned on disk.
    expect(scratchState.createScratch).toHaveBeenCalledTimes(1);
    expect(scratchState.switchScratch).toHaveBeenCalledTimes(2);
    expect(scratchState.switchScratch).toHaveBeenLastCalledWith("scratch-1");
  });

  it("says the scratch was created when only the switch failed", async () => {
    scratchState.switchScratch.mockRejectedValueOnce(new Error("view busy"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.createScratch("Named");
    });

    const payload = notifyMock.mock.calls.at(-1)?.[0] as { title: string };
    expect(payload.title).not.toMatch(/couldn't create/i);
  });

  it("surfaces create failures as an actionable error, not a passive one", async () => {
    scratchState.createScratch.mockRejectedValueOnce(new Error("nope"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.createScratch();
    });

    const payload = notifyMock.mock.calls.at(-1)?.[0] as {
      type: string;
      priority?: string;
      actions?: unknown[];
    };
    expect(payload.type).toBe("error");
    // An inbox-only error would hide the recovery action behind the notification
    // centre, where a closure-backed onClick can't be reached.
    expect(payload.priority).not.toBe("low");
    expect(payload.actions).toHaveLength(1);
  });
});

describe("renameScratch", () => {
  it("renames with the trimmed value", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.renameScratch("scratch-1", "  New name  ");
    });

    expect(scratchState.renameScratch).toHaveBeenCalledWith("scratch-1", "New name");
  });

  it("ignores a blank name instead of clearing it", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.renameScratch("scratch-1", "   ");
    });

    expect(scratchState.renameScratch).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("retries the same id and name after a failure", async () => {
    scratchState.renameScratch.mockRejectedValueOnce(new Error("locked"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.renameScratch("scratch-1", " New name ");
    });

    await waitFor(() => expect(notifyMock).toHaveBeenCalled());

    await act(async () => {
      await lastRetryAction()();
    });

    expect(scratchState.renameScratch).toHaveBeenCalledTimes(2);
    expect(scratchState.renameScratch).toHaveBeenLastCalledWith("scratch-1", "New name");
  });
});
