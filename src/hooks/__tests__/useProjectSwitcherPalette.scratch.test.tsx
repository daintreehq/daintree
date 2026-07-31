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

/**
 * The slice of a notify() payload these specs read back. Declaring it here lets the
 * mock be typed at the source, so assertions destructure a real type instead of
 * casting `any` at every call site.
 */
interface NotifyCall {
  type: string;
  title: string;
  message?: string;
  priority?: string;
  transient?: boolean;
  context?: { eventKind?: string };
  actions?: { label: string; onClick: () => Promise<void> }[];
}

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
  // seed it and mutate it mid-run to model `scratch:removed` pushes. Same for
  // `currentScratch`, which decides which row the palette marks active.
  const scratchState = {
    scratches: [] as Scratch[],
    currentScratch: null as Scratch | null,
    loadScratches: vi.fn().mockResolvedValue(undefined),
    createScratch: vi.fn(),
    switchScratch: vi.fn(),
    // Typed so `mock.calls` yields real ids — the bulk specs assert on the exact set
    // of scratches the fan-out asked the store to delete.
    removeScratch: vi.fn<(scratchId: string) => Promise<void>>().mockResolvedValue(undefined),
    renameScratch: vi.fn(),
  };

  return {
    useProjectStoreMock,
    notifyMock: vi.fn<(payload: NotifyCall) => string>().mockReturnValue(""),
    projectStatsState,
    scratchState,
    announceMock: vi.fn<(message: string, priority?: "polite" | "assertive") => void>(),
    closeAndAnnounceSpy:
      vi.fn<(closeFn: () => void, message: string, priority?: "polite" | "assertive") => void>(),
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
  useScratchStore: Object.assign(
    vi.fn((selector?: (s: typeof scratchState) => unknown) =>
      selector ? selector(scratchState) : scratchState
    ),
    { getState: () => scratchState }
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
import type { SearchableScratch } from "../useProjectSwitcherPalette";
import { projectClient } from "@/clients";

/** Pulls the "Try again" handler out of the last error notification. */
function lastRetryAction(): () => Promise<void> {
  const call = notifyMock.mock.calls.at(-1)?.[0];
  const action = call?.actions?.find((a) => a.label === "Try again");
  if (!action) throw new Error("expected a Try again action on the error notification");
  return action.onClick;
}

beforeEach(() => {
  vi.clearAllMocks();
  scratchState.scratches = [];
  scratchState.currentScratch = null;
  scratchState.createScratch.mockResolvedValue({ id: "scratch-1" });
  scratchState.switchScratch.mockResolvedValue(undefined);
  scratchState.renameScratch.mockResolvedValue(undefined);
  scratchState.removeScratch.mockResolvedValue(undefined);
  closeAndAnnounceSpy.mockImplementation(realCloseAndAnnounce);
});

/**
 * Seeds N scratches into the mocked store and marks the first one ACTIVE.
 *
 * The active scratch is deliberately part of every bulk fixture: it is the one the
 * user is standing in, and "delete all" has to take it too. With an all-inactive
 * fixture, an implementation that quietly skipped `isActive` would look correct.
 */
function seedScratches(count: number): Scratch[] {
  scratchState.scratches = Array.from({ length: count }, (_, i) => ({
    id: `scratch-${i + 1}`,
    name: `Spike ${i + 1}`,
    path: `/tmp/scratches/scratch-${i + 1}`,
    createdAt: 1_000 + i,
    lastOpened: 1_000 + i,
  }));
  scratchState.currentScratch = scratchState.scratches[0] ?? null;
  return scratchState.scratches;
}

/** Every id `removeScratch` was actually asked to delete. */
function deletedIds(): string[] {
  return scratchState.removeScratch.mock.calls.map((call) => call[0]);
}

/** A removal that stays pending until the test releases it. */
function deferRemovals(): { release: () => void } {
  const resolvers: (() => void)[] = [];
  scratchState.removeScratch.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      })
  );
  return {
    release: () => {
      for (const resolve of resolvers) resolve();
    },
  };
}

/** The payload of the most recent notify() call. */
function lastNotification(): NotifyCall {
  const payload = notifyMock.mock.calls.at(-1)?.[0];
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

    expect(lastNotification().title).not.toMatch(/couldn't create/i);
  });

  it("surfaces create failures as an actionable error, not a passive one", async () => {
    scratchState.createScratch.mockRejectedValueOnce(new Error("nope"));
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await act(async () => {
      await result.current.createScratch();
    });

    const payload = lastNotification();
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
  it("opens a confirmation only when there is something to delete", () => {
    const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    // Paired with the seeded case: on its own this would still pass if
    // `requestDeleteAllScratches` were a permanent no-op.
    expect(result.current.deleteAllScratchesConfirm).toBeNull();

    seedScratches(2);
    rerender();
    act(() => result.current.requestDeleteAllScratches());

    expect(result.current.deleteAllScratchesConfirm).toHaveLength(2);
  });

  it("enrols the active scratch along with the rest", async () => {
    const seeded = seedScratches(3);
    const activeId = scratchState.currentScratch!.id;
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    expect(result.current.deleteAllScratchesConfirm?.map((t) => t.id)).toContain(activeId);

    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    // "Delete all" that spared the workspace you're standing in would be a lie.
    expect(deletedIds()).toContain(activeId);
    expect(deletedIds()).toHaveLength(seeded.length);
  });

  it("dismisses the confirmation without deleting anything", () => {
    seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    expect(result.current.deleteAllScratchesConfirm).not.toBeNull();

    act(() => result.current.dismissDeleteAllScratchesConfirm());

    expect(result.current.deleteAllScratchesConfirm).toBeNull();
    expect(scratchState.removeScratch).not.toHaveBeenCalled();
  });

  it("holds the dialog open and the summary back until every removal settles", async () => {
    const seeded = seedScratches(3);
    const { release } = deferRemovals();
    const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());

    let run!: Promise<void>;
    act(() => {
      run = result.current.confirmDeleteAllScratches();
    });

    // Every target is in flight at once — a sequential await loop would show one.
    expect(deletedIds()).toHaveLength(seeded.length);
    expect(result.current.isDeletingAllScratches).toBe(true);
    expect(notifyMock).not.toHaveBeenCalled();

    // The `scratch:removed` pushes land while the run is still going, draining the
    // live list out from under the open dialog. The dialog must ride it out: without
    // the in-flight guard on the stale-snapshot effect, this tears it down early and
    // the user loses the outcome.
    scratchState.scratches = [];
    rerender();

    expect(result.current.deleteAllScratchesConfirm).toHaveLength(seeded.length);
    expect(notifyMock).not.toHaveBeenCalled();

    await act(async () => {
      release();
      await run;
    });

    expect(result.current.deleteAllScratchesConfirm).toBeNull();
    expect(result.current.isDeletingAllScratches).toBe(false);
    expect(notifyMock).toHaveBeenCalledTimes(1);
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
    expect([...deletedIds()].sort()).toEqual(seeded.map((s) => s.id).sort());
    expect(deletedIds()).not.toContain("scratch-late");
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
    expect(deletedIds()).toEqual(expect.arrayContaining(seeded.map((s) => s.id)));
  });

  it("collapses a fully successful run into a single summary notification", async () => {
    const seeded = seedScratches(3);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    // Tied to the actual deletions: a summary that reported success without ever
    // calling the store would otherwise pass.
    expect([...deletedIds()].sort()).toEqual(seeded.map((s) => s.id).sort());
    // One summary, not one toast per scratch — the per-item error path in
    // `removeScratchAction` must not be reused for the fan-out.
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = lastNotification();
    expect(payload.type).toBe("success");
    expect(payload.title).toContain(String(seeded.length));
  });

  it("reports a partial run as a warning counting the successes against the total", async () => {
    const seeded = seedScratches(4);
    const doomed = new Set([seeded[0]!.id, seeded[1]!.id]);
    scratchState.removeScratch.mockImplementation((id: string) =>
      doomed.has(id) ? Promise.reject(new Error("EBUSY")) : Promise.resolve(undefined)
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
    // Both numbers, in order — a title that merely mentioned the failure count
    // ("2 couldn't be deleted") would satisfy a bare contains-"2" check.
    const numbers = (payload.title.match(/\d+/g) ?? []).map(Number);
    expect(numbers).toEqual([seeded.length - doomed.size, seeded.length]);
    // Several failed, so the summary reports the count rather than naming one.
    expect(payload.message).toContain(String(doomed.size));
  });

  it("names the single casualty when only one target fails", async () => {
    const seeded = seedScratches(3);
    scratchState.removeScratch.mockImplementation((id: string) =>
      id === seeded[0]!.id ? Promise.reject(new Error("EBUSY")) : Promise.resolve(undefined)
    );
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    const payload = lastNotification();
    expect(payload.message).toContain(seeded[0]!.name);
    expect(payload.message).toContain("EBUSY");
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

  it("hands closeAndAnnounce a callback that really is the dialog close", async () => {
    seedScratches(2);
    // Inert helper: the dialog can only close if the hook handed over a closer that
    // does it. Without this, `closeAndAnnounce(() => {}, title)` followed by a
    // separate close would satisfy the routing spec above while announcing first —
    // exactly the ordering #9434 exists to prevent.
    closeAndAnnounceSpy.mockImplementation(() => {});
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.requestDeleteAllScratches());
    await act(async () => {
      await result.current.confirmDeleteAllScratches();
    });

    expect(result.current.deleteAllScratchesConfirm).not.toBeNull();

    const [closeFn, message] = closeAndAnnounceSpy.mock.calls[0]!;
    expect(message).toBe(lastNotification().title);

    act(() => closeFn());

    expect(result.current.deleteAllScratchesConfirm).toBeNull();
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

/**
 * Scratches in switcher search (issue #11466).
 *
 * Browse leaves them to the pinned section; a query pulls them into the one
 * array the palette renders, indexes and walks — so a name typed in full is
 * reachable by arrow key and committable with Enter, which it never was while
 * they lived in their own nested listbox.
 *
 * The project pool is empty throughout: what these specs pin is membership,
 * navigation and dispatch. Relative ordering against projects is the ranker's
 * own contract, covered in `src/lib/__tests__/projectSwitcherSearch.test.ts`.
 */
describe("scratches in search results", () => {
  it("keeps scratches out of the results array while browsing", async () => {
    seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    expect(result.current.results).toEqual([]);
    // Still listed for the pinned browse section, just not as ranked rows.
    expect(result.current.scratchResults).toHaveLength(2);
  });

  it("ranks matching scratches into the results array once a query is active", async () => {
    seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.setQuery("Spike 2"));

    await waitFor(() => {
      expect(result.current.results.map((row) => row.id)).toEqual(["scratch-2"]);
    });
    expect(result.current.results[0]!.kind).toBe("scratch");
  });

  it("drops scratches from the results array again when the query is cleared", async () => {
    seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.setQuery("Spike"));
    // Both scratches are present before AND after the deferred render settles,
    // so a length check alone would not prove the ranking actually ran.
    await waitFor(() => {
      expect(result.current.isFiltering).toBe(false);
      expect(result.current.results).toHaveLength(2);
    });

    act(() => result.current.setQuery(""));

    await waitFor(() => expect(result.current.results).toEqual([]));
  });

  it("moves the selection across scratch rows with the arrow-key step", async () => {
    seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.setQuery("Spike"));
    await waitFor(() => {
      expect(result.current.isFiltering).toBe(false);
      expect(result.current.results).toHaveLength(2);
    });

    const first = result.current.results[result.current.selectedIndex]!.id;
    act(() => result.current.selectNext());

    expect(result.current.results[result.current.selectedIndex]!.id).not.toBe(first);
  });

  it("keeps ranked results in step with the scratch store under a settled query", async () => {
    const seeded = seedScratches(2);
    const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.setQuery("Spike 2"));
    await waitFor(() => expect(result.current.results.map((row) => row.id)).toEqual(["scratch-2"]));

    // A `scratch:removed` push under an open, settled query. Without the store
    // feeding the ranked list, the row would linger and Enter would commit a
    // workspace that no longer exists.
    scratchState.scratches = [seeded[0]!];
    rerender();

    await waitFor(() => expect(result.current.results).toEqual([]));
  });

  it("holds browse rows steady when only the scratches change", async () => {
    seedScratches(2);
    const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

    const before = result.current.results;
    scratchState.scratches = [
      ...scratchState.scratches,
      {
        id: "scratch-3",
        name: "Spike 3",
        path: "/tmp/scratches/scratch-3",
        createdAt: 3_000,
        lastOpened: 3_000,
      },
    ];
    rerender();

    // Browse ignores scratches, so its array must keep its identity — a fresh
    // one sends the palette's scroll-into-view effect chasing the highlight
    // while the user is reading the pinned section.
    expect(result.current.results).toBe(before);
  });

  it("switches to the highlighted scratch on confirm rather than a project", async () => {
    seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    // "Spike 2" is the inactive one, so a switch is genuinely dispatched.
    act(() => result.current.setQuery("Spike 2"));
    await waitFor(() => expect(result.current.results).toHaveLength(1));

    act(() => result.current.confirmSelection());

    await waitFor(() => expect(scratchState.switchScratch).toHaveBeenCalledWith("scratch-2"));
    expect(useProjectStoreMock.getState().switchProject).not.toHaveBeenCalled();
  });

  it("matches a scratch on its name and not its generated folder path", async () => {
    seedScratches(1);
    const scratchPath = scratchState.scratches[0]!.path;
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => result.current.setQuery(scratchPath));

    await waitFor(() => expect(result.current.results).toEqual([]));
  });
});

/**
 * Scratch rows join the agent-status map (#11518).
 *
 * A scratch terminal already carries the scratch id as its `projectId`, so the
 * join is the same lookup projects do — what these specs hold is that it
 * actually happens, that it re-runs when the map moves, and that the open-time
 * pull (the only guaranteed hydration path) asks for scratch ids too.
 */
describe("scratch agent-status join", () => {
  // The stats fixture is module-scoped and shared with the suites above, so it
  // has to be cleared per-spec or a seeded map leaks into the next assertion.
  beforeEach(() => {
    projectStatsState.stats = {};
  });

  const STATS_FIELDS = [
    "activeAgentCount",
    "waitingAgentCount",
    "blockedAgentCount",
    "completedAgentCount",
    "unacknowledgedCompletedAgentCount",
    "processCount",
  ] as const;

  function scratchRow(result: { current: { scratchResults: SearchableScratch[] } }, id: string) {
    const row = result.current.scratchResults.find((s) => s.id === id);
    if (!row) throw new Error(`no scratch row for ${id}`);
    return row;
  }

  it("defaults every count when the map has no entry for the scratch", async () => {
    seedScratches(1);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    await waitFor(() => expect(result.current.scratchResults).toHaveLength(1));

    const row = scratchRow(result, "scratch-1");
    for (const field of STATS_FIELDS) expect(row[field]).toBe(0);
    expect(row.oldestWaitingSince).toBeUndefined();
  });

  it("carries the map's counts onto the row", async () => {
    seedScratches(1);
    projectStatsState.stats = {
      "scratch-1": {
        activeAgentCount: 1,
        waitingAgentCount: 2,
        blockedAgentCount: 1,
        oldestWaitingSince: 4_000,
        completedAgentCount: 3,
        unacknowledgedCompletedAgentCount: 2,
        latestCompletionAt: 9_000,
        processCount: 5,
      } as (typeof projectStatsState.stats)[string],
    };

    const { result } = renderHook(() => useProjectSwitcherPalette());

    await waitFor(() => expect(result.current.scratchResults).toHaveLength(1));

    const row = scratchRow(result, "scratch-1");
    expect(row.waitingAgentCount).toBe(2);
    expect(row.blockedAgentCount).toBe(1);
    expect(row.oldestWaitingSince).toBe(4_000);
    expect(row.unacknowledgedCompletedAgentCount).toBe(2);
    expect(row.processCount).toBe(5);
  });

  // The memo previously depended only on the scratch list. Without the stats
  // dependency the join reads whatever was there on first build, forever.
  it("recomputes when only the status map moves", async () => {
    seedScratches(1);
    const { result, rerender } = renderHook(() => useProjectSwitcherPalette());

    await waitFor(() => expect(result.current.scratchResults).toHaveLength(1));
    expect(scratchRow(result, "scratch-1").waitingAgentCount).toBe(0);

    projectStatsState.stats = {
      "scratch-1": {
        activeAgentCount: 0,
        waitingAgentCount: 3,
        processCount: 0,
      } as (typeof projectStatsState.stats)[string],
    };
    await act(async () => {
      rerender();
    });

    expect(scratchRow(result, "scratch-1").waitingAgentCount).toBe(3);
  });

  it("does not let a project entry bleed into a scratch row", async () => {
    seedScratches(1);
    projectStatsState.stats = {
      "project-1": {
        activeAgentCount: 7,
        waitingAgentCount: 7,
        processCount: 7,
      } as (typeof projectStatsState.stats)[string],
    };

    const { result } = renderHook(() => useProjectSwitcherPalette());

    await waitFor(() => expect(result.current.scratchResults).toHaveLength(1));

    expect(scratchRow(result, "scratch-1").activeAgentCount).toBe(0);
  });

  it("asks the open-time pull for scratch ids alongside project ids", async () => {
    seedScratches(2);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => expect(projectClient.getBulkStats).toHaveBeenCalled());

    const requested = vi.mocked(projectClient.getBulkStats).mock.calls.at(-1)![0];
    expect(requested).toEqual(expect.arrayContaining(["scratch-1", "scratch-2"]));
  });

  // The pull used to bail when the project list was empty. A user whose only
  // workspaces are scratches would never get a seeded status map at all.
  it("still pulls when scratches are the only workspaces", async () => {
    seedScratches(1);
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => expect(projectClient.getBulkStats).toHaveBeenCalledWith(["scratch-1"]));
  });

  // Both loads are independent: `Promise.all` here would let either store's IPC
  // failure cost the OTHER kind of row its status seed entirely.
  it("still hydrates scratches when the project load rejects", async () => {
    seedScratches(1);
    useProjectStoreMock.getState().loadProjects.mockRejectedValueOnce(new Error("projects down"));

    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() =>
      expect(projectClient.getBulkStats).toHaveBeenCalledWith(expect.arrayContaining(["scratch-1"]))
    );
  });

  it("still pulls when the scratch load rejects", async () => {
    seedScratches(1);
    scratchState.loadScratches.mockRejectedValueOnce(new Error("scratches down"));

    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    // The rows already in the store are still worth hydrating.
    await waitFor(() => expect(projectClient.getBulkStats).toHaveBeenCalled());
  });

  it("carries the optional completion timestamps through the join", async () => {
    seedScratches(1);
    projectStatsState.stats = {
      "scratch-1": {
        activeAgentCount: 0,
        waitingAgentCount: 0,
        completedAgentCount: 3,
        unacknowledgedCompletedAgentCount: 2,
        oldestUnacknowledgedCompletionAt: 111,
        latestUnacknowledgedCompletionAt: 222,
        latestCompletionAt: 333,
        processCount: 0,
      } as (typeof projectStatsState.stats)[string],
    };

    const { result } = renderHook(() => useProjectSwitcherPalette());

    await waitFor(() => expect(result.current.scratchResults).toHaveLength(1));

    // Distinct sentinels: dropping any single assignment must not be maskable
    // by another timestamp happening to hold the same value.
    const row = scratchRow(result, "scratch-1");
    expect(row.oldestUnacknowledgedCompletionAt).toBe(111);
    expect(row.latestUnacknowledgedCompletionAt).toBe(222);
    expect(row.latestCompletionAt).toBe(333);
  });

  it("makes no request when there are neither projects nor scratches", async () => {
    const { result } = renderHook(() => useProjectSwitcherPalette());

    act(() => {
      result.current.open();
    });

    await waitFor(() => expect(scratchState.loadScratches).toHaveBeenCalled());
    expect(projectClient.getBulkStats).not.toHaveBeenCalled();
  });
});
