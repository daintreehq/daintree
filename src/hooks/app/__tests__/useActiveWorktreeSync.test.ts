// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorktreeState } from "@shared/types";
import { useActiveWorktreeSync } from "../useActiveWorktreeSync";
import {
  RENDERER_ACTIVATION_ORIGIN,
  consumeHostAppliedActivation,
  latestActivationRequest,
  markHostActivationApplied,
  _resetHostAppliedActivationForTesting,
} from "@/store/worktreeActivationOrigin";

const mocks = vi.hoisted(() => ({
  useWorktrees: vi.fn<() => { worktrees: Array<{ id: string }>; isInitialized: boolean }>(),
  selectionState: {
    activeWorktreeId: null as string | null,
    restoreWorktreeId: null as string | null,
    selectWorktree: vi.fn(),
    setActiveWorktree: vi.fn(),
    // Only unread today because every active id here is also a live worktree,
    // which short-circuits the `||`. One absent-worktree fixture away from a
    // TypeError without it.
    deletedWorktrees: new Map<string, unknown>(),
  },
  projectState: {
    currentProject: null as { id: string; path: string } | null,
  },
  scratchState: {
    currentScratch: null as { id: string; path: string } | null,
  },
  homeDir: { homeDir: "/home/user" as string | null },
}));

// The hook reads the per-view worktree store through selectors; `useWorktrees`
// stays the fixture's shape and is folded into the store state here.
vi.mock("@/hooks/useWorktreeStore", () => ({
  useWorktreeStore: (
    selector: (state: { worktrees: Map<string, unknown>; isInitialized: boolean }) => unknown
  ): unknown => {
    const { worktrees, isInitialized } = mocks.useWorktrees();
    return selector({ worktrees: new Map(worktrees.map((w) => [w.id, w])), isInitialized });
  },
  useWorktreeStoreApi: () => ({ subscribe: () => () => {} }),
}));

vi.mock("@/store/worktreeStore", () => ({
  useWorktreeSelectionStore: (selector: (state: typeof mocks.selectionState) => unknown): unknown =>
    selector(mocks.selectionState),
}));

vi.mock("@/store", () => ({
  useProjectStore: (selector: (state: typeof mocks.projectState) => unknown): unknown =>
    selector(mocks.projectState),
}));

vi.mock("@/store/scratchStore", () => ({
  useScratchStore: (selector: (state: typeof mocks.scratchState) => unknown): unknown =>
    selector(mocks.scratchState),
}));

vi.mock("@/hooks/app/useHomeDir", () => ({
  useHomeDir: () => mocks.homeDir,
}));

// The active-worktree sync effect pushes the selection over the worktree port
// whenever a project and a worktree are both set. jsdom aliases globalThis to
// window, so stubbing the global satisfies the hook's `window.electron` read
// without an unsafe cast.
vi.stubGlobal("electron", {
  worktreePort: { request: vi.fn(() => Promise.resolve()) },
});

// `useWorktrees` is mocked, so the hook reads this shape straight through — no
// cast to the full WorktreeState is needed for the fields under test.
const worktree = {
  id: "wt-1",
  name: "feature",
  path: "/repo-worktrees/feature",
  isMainWorktree: false,
};

const cwdOf = () => renderHook(() => useActiveWorktreeSync()).result.current.defaultTerminalCwd;

/**
 * The workspace is a project OR a scratch (#11076), and `terminal.new` spawns
 * into whatever this resolves to — a missed branch strands the terminal in the
 * home dir rather than the workspace the user is looking at.
 */
describe("useActiveWorktreeSync defaultTerminalCwd", () => {
  beforeEach(() => {
    mocks.selectionState.activeWorktreeId = worktree.id;
    mocks.selectionState.deletedWorktrees = new Map();
    mocks.projectState.currentProject = null;
    mocks.scratchState.currentScratch = null;
    mocks.homeDir.homeDir = "/home/user";
    mocks.useWorktrees.mockReturnValue({ worktrees: [worktree], isInitialized: true });
  });

  it("prefers the active worktree over every other workspace path", () => {
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };

    expect(cwdOf()).toBe(worktree.path);
  });

  it("falls back to the project when no worktree is selected", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };

    expect(cwdOf()).toBe("/repo");
  });

  it("resolves to the scratch when it is the only active workspace", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };

    expect(cwdOf()).toBe("/scratches/s1");
  });

  it("resolves to the scratch before the worktree snapshot has initialized", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: false });

    expect(cwdOf()).toBe("/scratches/s1");
  });

  it("prefers the project over the scratch in a transient both-set state", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };

    expect(cwdOf()).toBe("/repo");
  });

  it("falls back to the home dir when no workspace is active", () => {
    mocks.selectionState.activeWorktreeId = null;

    expect(cwdOf()).toBe("/home/user");
  });

  it("never yields an empty cwd while a scratch is active but the home dir is unknown", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };
    mocks.homeDir.homeDir = null;

    expect(cwdOf()).toBe("/scratches/s1");
  });

  // Issue #4254 — a selection that predates the authoritative snapshot must not
  // decide the cwd, or terminals spawn in a worktree that may not be current.
  it("withholds a matching worktree until the snapshot is authoritative", () => {
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };
    mocks.useWorktrees.mockReturnValue({ worktrees: [worktree], isInitialized: false });

    expect(cwdOf()).toBe("/repo");
  });

  it("falls back to the home dir before initialization when no workspace is active", () => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: false });

    expect(cwdOf()).toBe("/home/user");
  });

  describe("recomputes when its inputs change", () => {
    it("adopts the worktree once the snapshot becomes authoritative", () => {
      mocks.projectState.currentProject = { id: "p1", path: "/repo" };
      mocks.useWorktrees.mockReturnValue({ worktrees: [worktree], isInitialized: false });

      const { result, rerender } = renderHook(() => useActiveWorktreeSync());
      expect(result.current.defaultTerminalCwd).toBe("/repo");

      mocks.useWorktrees.mockReturnValue({ worktrees: [worktree], isInitialized: true });
      rerender();

      expect(result.current.defaultTerminalCwd).toBe(worktree.path);
    });

    it("adopts the home dir once it resolves", () => {
      mocks.selectionState.activeWorktreeId = null;
      mocks.homeDir.homeDir = null;

      const { result, rerender } = renderHook(() => useActiveWorktreeSync());
      expect(result.current.defaultTerminalCwd).toBe("");

      mocks.homeDir.homeDir = "/home/user";
      rerender();

      expect(result.current.defaultTerminalCwd).toBe("/home/user");
    });

    it("adopts a scratch the moment one becomes active", () => {
      mocks.selectionState.activeWorktreeId = null;

      const { result, rerender } = renderHook(() => useActiveWorktreeSync());
      expect(result.current.defaultTerminalCwd).toBe("/home/user");

      mocks.scratchState.currentScratch = { id: "s1", path: "/scratches/s1" };
      rerender();

      expect(result.current.defaultTerminalCwd).toBe("/scratches/s1");
    });
  });
});

describe("useActiveWorktreeSync host sync", () => {
  const otherWorktree = {
    id: "wt-2",
    name: "other",
    path: "/repo-worktrees/other",
    isMainWorktree: false,
  };
  const request = () => vi.mocked(window.electron.worktreePort.request);

  beforeEach(() => {
    request().mockClear();
    _resetHostAppliedActivationForTesting();
    mocks.selectionState.activeWorktreeId = worktree.id;
    mocks.selectionState.restoreWorktreeId = null;
    mocks.selectionState.deletedWorktrees = new Map();
    mocks.projectState.currentProject = { id: "p1", path: "/repo" };
    mocks.scratchState.currentScratch = null;
    mocks.homeDir.homeDir = "/home/user";
    mocks.useWorktrees.mockReturnValue({
      worktrees: [worktree, otherWorktree],
      isInitialized: true,
    });
  });

  it("tags its set-active request with this view's origin so the host's echo is recognisable (#12370)", () => {
    renderHook(() => useActiveWorktreeSync());

    expect(request()).toHaveBeenCalledTimes(1);
    expect(request()).toHaveBeenCalledWith("set-active", {
      worktreeId: worktree.id,
      origin: RENDERER_ACTIVATION_ORIGIN,
    });
    // Remembered so the echo handler can tell the ack of the latest request
    // from a superseded one, and keep its source if it has to catch up.
    expect(latestActivationRequest()).toEqual({ worktreeId: worktree.id, durable: false });
  });

  it("records the request as durable when the pick is the restore target", () => {
    mocks.selectionState.restoreWorktreeId = worktree.id;
    renderHook(() => useActiveWorktreeSync());

    expect(latestActivationRequest()).toEqual({ worktreeId: worktree.id, durable: true });
  });

  it("does not resend a restore-only change after a rejected request, then uses the current target on the next pick", async () => {
    // The durable flag is read at send time, non-reactively. Simply depending
    // on the restore target looks equivalent — the duplicate-send guard hides
    // it — right until a rejected request clears that guard: a restore target
    // moving on its own would then fire a second activation for a selection
    // the user never changed, and every attached view answers it (#12370).
    request().mockRejectedValueOnce(new Error("worktree port closed"));
    const { rerender } = renderHook(() => useActiveWorktreeSync());
    expect(request()).toHaveBeenCalledTimes(1);
    expect(latestActivationRequest()).toEqual({ worktreeId: worktree.id, durable: false });
    // Let the rejection clear the de-duplication marker.
    await act(async () => {
      await Promise.resolve();
    });

    mocks.selectionState.restoreWorktreeId = otherWorktree.id;
    rerender();
    expect(request()).toHaveBeenCalledTimes(1);

    mocks.selectionState.activeWorktreeId = otherWorktree.id;
    rerender();
    expect(request()).toHaveBeenCalledTimes(2);
    expect(latestActivationRequest()).toEqual({ worktreeId: otherWorktree.id, durable: true });
  });

  it("drops a host mark when the selection clears, so it cannot swallow a later pick", () => {
    markHostActivationApplied(worktree.id);
    mocks.selectionState.activeWorktreeId = null;
    renderHook(() => useActiveWorktreeSync());

    expect(request()).not.toHaveBeenCalled();
    expect(consumeHostAppliedActivation(worktree.id)).toBe(false);
  });

  it("does not answer a selection the host itself pushed, then sends the next local one as usual", () => {
    markHostActivationApplied(worktree.id);
    const { rerender } = renderHook(() => useActiveWorktreeSync());
    expect(request()).not.toHaveBeenCalled();

    mocks.selectionState.activeWorktreeId = otherWorktree.id;
    rerender();
    expect(request()).toHaveBeenCalledTimes(1);
    expect(request()).toHaveBeenLastCalledWith(
      "set-active",
      expect.objectContaining({ worktreeId: otherWorktree.id })
    );

    // The mark was single-shot: coming back to the same id is ours to send.
    mocks.selectionState.activeWorktreeId = worktree.id;
    rerender();
    expect(request()).toHaveBeenCalledTimes(2);
    expect(request()).toHaveBeenLastCalledWith(
      "set-active",
      expect.objectContaining({ worktreeId: worktree.id })
    );
  });

  it("clears a stale host mark on the next selection change instead of swallowing a later local pick", () => {
    // The host pushed wt-2, but the user picked wt-1 before the effect ran.
    markHostActivationApplied(otherWorktree.id);
    const { rerender } = renderHook(() => useActiveWorktreeSync());
    expect(request()).toHaveBeenCalledTimes(1);
    expect(request()).toHaveBeenLastCalledWith(
      "set-active",
      expect.objectContaining({ worktreeId: worktree.id })
    );

    mocks.selectionState.activeWorktreeId = otherWorktree.id;
    rerender();
    expect(request()).toHaveBeenCalledTimes(2);
    expect(request()).toHaveBeenLastCalledWith(
      "set-active",
      expect.objectContaining({ worktreeId: otherWorktree.id })
    );
  });
});

const featureWorktree = {
  id: "feature",
  name: "feature/test-branch",
  path: "/repo-worktrees/feature",
  isMainWorktree: false,
} as WorktreeState;

const mainWorktree = {
  id: "main",
  name: "repo",
  path: "/repo",
  isMainWorktree: true,
} as WorktreeState;

describe("useActiveWorktreeSync initialization", () => {
  beforeEach(() => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.selectionState.selectWorktree.mockReset();
    mocks.selectionState.setActiveWorktree.mockReset();
    mocks.selectionState.deletedWorktrees = new Map();
    mocks.useWorktrees.mockReset();
    mocks.projectState.currentProject = { id: "project-1", path: "/repo" };
    mocks.scratchState.currentScratch = null;
  });

  it("waits for the authoritative snapshot before selecting a fallback worktree", () => {
    mocks.useWorktrees.mockReturnValue({
      worktrees: [featureWorktree],
      isInitialized: false,
    });

    const { rerender } = renderHook(() => useActiveWorktreeSync());

    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();

    mocks.useWorktrees.mockReturnValue({
      worktrees: [mainWorktree, featureWorktree],
      isInitialized: true,
    });
    rerender();

    expect(mocks.selectionState.selectWorktree).toHaveBeenCalledOnce();
    expect(mocks.selectionState.selectWorktree).toHaveBeenCalledWith(mainWorktree.id);
  });

  // The rescue-follow (#11273) selects the destination after the row is pruned
  // but before this effect runs, so it never reaches the branch below. Every
  // other way a deleted row can die — last terminal closed or trashed, row
  // dismissed, auto-cleanup — still lands here. The hook cannot tell those
  // causes apart, so one case covers all of them.
  it("holds the selection on a deleted row and snaps to main only once it is gone", () => {
    mocks.selectionState.activeWorktreeId = "ghost";
    mocks.selectionState.deletedWorktrees = new Map([["ghost", {}]]);
    // Feature first, so the assertion proves the fallback picks the designated
    // main worktree rather than whatever happens to sit at index zero.
    mocks.useWorktrees.mockReturnValue({
      worktrees: [featureWorktree, mainWorktree],
      isInitialized: true,
    });

    const { rerender } = renderHook(() => useActiveWorktreeSync());

    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();

    mocks.selectionState.deletedWorktrees = new Map();
    rerender();

    expect(mocks.selectionState.selectWorktree).toHaveBeenCalledExactlyOnceWith(mainWorktree.id);
  });
});

/**
 * A worktree-less workspace (a plain folder, or a repo opened without one) gets
 * an authoritative empty snapshot, not a pending one. Before #11654 the effect
 * bailed on the empty list and left whatever id the previous project had
 * selected, which then failed every agent launch against a worktree that does
 * not exist here.
 */
describe("useActiveWorktreeSync on a worktree-less workspace", () => {
  beforeEach(() => {
    mocks.selectionState.activeWorktreeId = null;
    mocks.selectionState.selectWorktree.mockReset();
    mocks.selectionState.setActiveWorktree.mockReset();
    mocks.selectionState.deletedWorktrees = new Map();
    mocks.useWorktrees.mockReset();
    mocks.projectState.currentProject = { id: "project-1", path: "/plain-folder" };
    mocks.scratchState.currentScratch = null;
  });

  it("clears an inherited selection only once the empty snapshot is authoritative", () => {
    mocks.selectionState.activeWorktreeId = featureWorktree.id;
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: false });

    const { rerender } = renderHook(() => useActiveWorktreeSync());

    // Empty-and-loading is indistinguishable from empty-and-real without the
    // flag, so nothing may be cleared yet.
    expect(mocks.selectionState.setActiveWorktree).not.toHaveBeenCalled();

    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });
    rerender();

    // `persist: false` is load-bearing: the persisted `activeWorktreeId` slot is
    // app-global, so a plain clear here would drop the saved selection of the
    // git-backed project that left this id behind.
    expect(mocks.selectionState.setActiveWorktree).toHaveBeenCalledExactlyOnceWith(null, {
      persist: false,
    });
    // There is no worktree to snap to — reaching for one would read past the
    // end of the empty list.
    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();
  });

  it("leaves an already-cleared selection alone across repeated snapshots", () => {
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });

    const { rerender } = renderHook(() => useActiveWorktreeSync());
    // A worktree appearing and going again changes the effect's inputs, so it
    // genuinely re-runs against the empty list rather than being skipped.
    // (`selectWorktree` is a mock, so the selection stays null throughout.)
    mocks.useWorktrees.mockReturnValue({ worktrees: [mainWorktree], isInitialized: true });
    rerender();
    expect(mocks.selectionState.selectWorktree).toHaveBeenCalledWith(mainWorktree.id);
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });
    rerender();

    // setActiveWorktree persists and re-runs terminal policy on every call, so
    // clearing a selection that is already null is a write for no reason.
    expect(mocks.selectionState.setActiveWorktree).not.toHaveBeenCalled();
  });

  it("clears the selection when the last live worktree disappears", () => {
    // The other direction into empty: the workspace was authoritative and
    // populated all along, so nothing about initialization changes here.
    mocks.selectionState.activeWorktreeId = featureWorktree.id;
    mocks.useWorktrees.mockReturnValue({
      worktrees: [featureWorktree],
      isInitialized: true,
    });

    const { rerender } = renderHook(() => useActiveWorktreeSync());
    expect(mocks.selectionState.setActiveWorktree).not.toHaveBeenCalled();

    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });
    rerender();

    expect(mocks.selectionState.setActiveWorktree).toHaveBeenCalledExactlyOnceWith(null, {
      persist: false,
    });
    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();
  });

  it("keeps a deleted row selected when it outlives the last live worktree", () => {
    // pruneDeletedWorktrees retains a row while it still owns a terminal, so a
    // deleted row can be the active selection with nothing live left. The user
    // is looking at its surviving terminals.
    mocks.selectionState.activeWorktreeId = "ghost";
    mocks.selectionState.deletedWorktrees = new Map([["ghost", {}]]);
    mocks.useWorktrees.mockReturnValue({ worktrees: [], isInitialized: true });

    renderHook(() => useActiveWorktreeSync());

    expect(mocks.selectionState.setActiveWorktree).not.toHaveBeenCalled();
    expect(mocks.selectionState.selectWorktree).not.toHaveBeenCalled();
  });
});
