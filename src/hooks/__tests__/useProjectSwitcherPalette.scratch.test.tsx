// @vitest-environment jsdom
/**
 * useProjectSwitcherPalette — scratch create/rename actions (issue #11075) and
 * bulk delete-all (issue #11086).
 *
 * Create threads an optional name through to the store and switches to the new
 * scratch. The retry path is the interesting part: a failure AFTER the scratch
 * exists must resume at the switch, never create a second workspace.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Scratch } from "@shared/types";

const {
  useProjectStoreMock,
  notifyMock,
  projectStatsState,
  scratchState,
  announceMock,
  closeAndAnnounceSpy,
} = vi.hoisted(() => {
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

    // `scratches` is typed (not inferred as never[]) so the bulk-delete specs can
    // seed it and mutate it mid-run to model `scratch:removed` pushes.
    const scratchState = {
      scratches: [] as Scratch[],
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
      announceMock: vi.fn(),
      closeAndAnnounceSpy: vi.fn(),
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

vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));

// `closeAndAnnounce` is spied but calls through by default (see beforeEach), so the
// close-then-announce ordering it guarantees (#9434) is genuinely exercised. One spec
// re-stubs it to a no-op to prove the hook never reaches the announcer by another route.
vi.mock("@/lib/accessibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/accessibility")>();
  return { ...actual, closeAndAnnounce: closeAndAnnounceSpy };
});

// The genuine helper, reached past our own mock. Its dependencies (the announcer
// store) stay mocked, so calling through still lands on `announceMock`.
const { closeAndAnnounce: realCloseAndAnnounce } =
  await vi.importActual<typeof import("@/lib/accessibility")>("@/lib/accessibility");

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
  scratchState.scratches = [];
  scratchState.createScratch.mockResolvedValue({ id: "scratch-1" });
  scratchState.switchScratch.mockResolvedValue(undefined);
  scratchState.renameScratch.mockResolvedValue(undefined);
  scratchState.removeScratch.mockResolvedValue(undefined);
  closeAndAnnounceSpy.mockImplementation(realCloseAndAnnounce);
});

/** Seeds N scratches into the mocked store, newest first. */
function seedScratches(count: number): Scratch[] {
  scratchState.scratches = Array.from({ length: count }, (_, i) => ({
    id: `scratch-${i + 1}`,
    name: `Spike ${i + 1}`,
    path: `/tmp/scratches/scratch-${i + 1}`,
    createdAt: 1_000 + i,
    lastOpened: 1_000 + i,
  }));
  return scratchState.scratches;
}

/** The payload of the most recent notify() call. */
function lastNotification(): { type: string; title: string; message?: string } {
  const payload = notifyMock.mock.calls.at(-1)?.[0] as
    | { type: string; title: string; message?: string }
    | undefined;
  if (!payload) throw new Error("expected a notification");
  return payload;
}

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

describe("deleteAllScratches", () => {
  it("does not open a confirmation when there is nothing to delete", () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());

    expect(result.current.deleteAllScratchesConfirm).toBeNull();
  });

  it("freezes the targets at confirm-open so a later arrival is never enrolled", async () => {
    const seeded = seedScratches(2);
    const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    expect(result.current.deleteAllScratchesConfirm).toHaveLength(seeded.length);

    // A scratch created while the user is reading the dialog. It was never part of
    // the count they agreed to, so it must survive the run.
    scratchState.scratches = [
      ...seeded,
      {
        id: "scratch-late",
        name: "Arrived after the dialog opened",
        path: "/tmp/scratches/scratch-late",
        createdAt: 9_000,
        lastOpened: 9_000,
      },
    ];
    rerender();

    expect(result.current.deleteAllScratchesConfirm).toHaveLength(seeded.length);

    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    // Order is the palette's lastOpened-desc sort, not the seed order, and the
    // fan-out is parallel — membership is the contract, not sequence.
    const deletedIds = scratchState.removeScratch.mock.calls.map((call) => call[0] as string);
    expect([...deletedIds].sort()).toEqual(seeded.map((s) => s.id).sort());
    expect(deletedIds).not.toContain("scratch-late");
  });

  it("deletes every snapshotted target even when one of them rejects", async () => {
    const seeded = seedScratches(3);
    scratchState.removeScratch.mockImplementation((id: string) =>
      id === seeded[1]!.id ? Promise.reject(new Error("EBUSY")) : Promise.resolve(undefined)
    );
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    // A sequential loop that rethrew would have stopped at the middle target.
    const deletedIds = scratchState.removeScratch.mock.calls.map((call) => call[0] as string);
    expect(deletedIds).toEqual(expect.arrayContaining(seeded.map((s) => s.id)));
  });

  it("collapses a fully successful run into a single summary notification", async () => {
    const seeded = seedScratches(3);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    // One summary, not one toast per scratch — the per-item error path in
    // `removeScratchAction` must not be reused for the fan-out.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = lastNotification();
    expect(payload.type).toBe("success");
    expect(payload.title).toContain(String(seeded.length));
  });

  it("reports a partial run as a warning naming the survivor count", async () => {
    const seeded = seedScratches(3);
    scratchState.removeScratch.mockImplementation((id: string) =>
      id === seeded[0]!.id ? Promise.reject(new Error("EBUSY")) : Promise.resolve(undefined)
    );
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = lastNotification();
    // Warning, not error: burying the two successes in red would misreport the run.
    expect(payload.type).toBe("warning");
    expect(payload.title).toContain(String(seeded.length - 1));
    expect(payload.message).toContain(seeded[0]!.name);
  });

  it("reports a total failure as an error naming the reason", async () => {
    seedScratches(2);
    scratchState.removeScratch.mockRejectedValue(new Error("disk offline"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = lastNotification();
    expect(payload.type).toBe("error");
    expect(payload.message).toContain("disk offline");
  });

  it("fans out only once when the confirm button is double-fired in a single tick", async () => {
    const seeded = seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      // Both land before React re-renders the disabled state, so only a
      // synchronous guard can stop the second (lesson #4024).
      await Promise.all([
        result.current.confirmDeleteAllScratches(),
        result.current.confirmDeleteAllScratches(),
      ]);
    });

    expect(scratchState.removeScratch).toHaveBeenCalledTimes(seeded.length);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("routes the announcement through closeAndAnnounce rather than the announcer", async () => {
    seedScratches(2);
    // Stub the helper to a no-op: with it inert, ANY call reaching the announcer
    // proves the hook announced on its own. That is the #9434 regression —
    // VoiceOver drops live-region updates raised while the modal still holds
    // focus, so the close has to happen first, and only the helper guarantees it.
    closeAndAnnounceSpy.mockImplementation(() => {});
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    expect(closeAndAnnounceSpy).toHaveBeenCalledTimes(1);
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("announces the summary and clears the dialog on success", async () => {
    seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    // Call-through: the real helper closed the dialog, then announced.
    expect(result.current.deleteAllScratchesConfirm).toBeNull();
    expect(announceMock).toHaveBeenCalledWith(lastNotification().title, undefined);
  });

  it("announces assertively only when nothing could be deleted", async () => {
    seedScratches(2);
    scratchState.removeScratch.mockRejectedValue(new Error("disk offline"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    expect(announceMock).toHaveBeenCalledWith(expect.any(String), "assertive");
  });

  it("settles the loading flag and clears the dialog after a failed run", async () => {
    seedScratches(2);
    scratchState.removeScratch.mockRejectedValue(new Error("disk offline"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    // A stuck ref would wedge the action permanently — the dialog could never
    // be reopened after a transient failure.
    expect(result.current.isDeletingAllScratches).toBe(false);
    expect(result.current.deleteAllScratchesConfirm).toBeNull();

    scratchState.removeScratch.mockResolvedValue(undefined);
    act(() => result.current.requestDeleteAllScratches());
    expect(result.current.deleteAllScratchesConfirm).toHaveLength(2);
  });

  it("dismisses the dialog when every target vanishes from another window", () => {
    seedScratches(2);
    const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    expect(result.current.deleteAllScratchesConfirm).not.toBeNull();

    // A `scratch:removed` push emptied the store under the open dialog.
    scratchState.scratches = [];
    rerender();

    expect(result.current.deleteAllScratchesConfirm).toBeNull();
  });

  it("keeps the dialog open while only some targets have vanished", () => {
    const seeded = seedScratches(2);
    const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());

    scratchState.scratches = [seeded[0]!];
    rerender();

    // Shrinking the snapshot here would rewrite the count the user already read.
    expect(result.current.deleteAllScratchesConfirm).toHaveLength(seeded.length);
  });
});
