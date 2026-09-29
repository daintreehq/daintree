// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { usePanelStore } from "@/store/panelStore";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useWorktreeSelectionStore } from "@/store/worktreeStore";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import {
  resetDeletedWorktreeCleanupState,
  startDeletedWorktreeCleanup,
} from "../deletedWorktreeCleanup";

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

const NOW = 1_700_000_000_000;

/**
 * The 1 Hz sweep is only there to count down deleted-worktree rows. Nearly every
 * session has none, so the idle cost of the timer is what this pins: interval
 * callbacks the renderer is woken for with nothing to sweep.
 */
let ticks = 0;
let disposeCleanup: (() => void) | undefined;
let hidden = false;
let bulkTrashByWorktree: ReturnType<typeof vi.fn<(worktreeId: string) => void>>;

function addRow(id: string, expiresAt: number | null = null): void {
  useWorktreeSelectionStore.getState().addDeletedWorktree({
    id,
    title: id,
    path: `/repo/${id}`,
    deletedAt: Date.now(),
    expiresAt,
    holdReason: null,
    pinnedBeforeWorktreeId: null,
  });
}

function removeRows(): void {
  useWorktreeSelectionStore.getState().pruneDeletedWorktrees(new Set(), new Set());
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resetDeletedWorktreeCleanupState();
  __resetProjectViewCacheStateForTests();
  useWorktreeSelectionStore.getState().reset();
  usePreferencesStore.setState({ deletedWorktreeCleanupSeconds: 60 });
  bulkTrashByWorktree = vi.fn<(worktreeId: string) => void>();
  usePanelStore.setState({
    panelIds: [],
    panelsById: {},
    panelIdsByWorktreeId: {},
    bulkTrashByWorktree,
  });
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  vi.stubGlobal("electron", {
    app: {
      onViewCached: () => vi.fn(),
      onViewWarmActivated: () => vi.fn(),
      onViewRevealed: () => vi.fn(),
      isViewCached: () => false,
    },
  });

  ticks = 0;
  const fakeSetInterval = globalThis.setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, ms?: number) =>
    fakeSetInterval(() => {
      ticks++;
      handler();
    }, ms)) as typeof setInterval);
});

afterEach(() => {
  disposeCleanup?.();
  disposeCleanup = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "hidden");
  __resetProjectViewCacheStateForTests();
  resetDeletedWorktreeCleanupState();
});

describe("deleted-worktree sweep idle cost", () => {
  it("wakes the renderer zero times a minute with no deleted worktrees", () => {
    const idle = vi.getTimerCount();
    disposeCleanup = startDeletedWorktreeCleanup();
    expect(vi.getTimerCount()).toBe(idle);
    vi.advanceTimersByTime(60_000);
    expect(ticks).toBe(0);
  });

  it("sweeps once a second while a row exists and goes quiet once it is gone", () => {
    const idle = vi.getTimerCount();
    disposeCleanup = startDeletedWorktreeCleanup();
    addRow("wt-1");
    expect(vi.getTimerCount()).toBe(idle + 1);
    vi.advanceTimersByTime(10_000);
    expect(ticks).toBe(10);

    removeRows();
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.size).toBe(0);
    expect(vi.getTimerCount()).toBe(idle);
    ticks = 0;
    vi.advanceTimersByTime(60_000);
    expect(ticks).toBe(0);

    addRow("wt-2");
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(1);
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-2")?.expiresAt).toBe(
      NOW + 71_000 + 60_000
    );
  });

  it("arms a re-recorded row under the same id at the full TTL", () => {
    disposeCleanup = startDeletedWorktreeCleanup();
    addRow("wt-1");
    vi.advanceTimersByTime(5_000);
    removeRows();
    vi.advanceTimersByTime(30_000);

    addRow("wt-1");
    vi.advanceTimersByTime(1_000);
    expect(useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-1")?.expiresAt).toBe(
      Date.now() + 60_000
    );
  });

  it("still credits a hidden stretch to a row that arrives already armed after the map emptied", () => {
    disposeCleanup = startDeletedWorktreeCleanup();
    addRow("wt-1");
    vi.advanceTimersByTime(1_000);
    removeRows();
    vi.advanceTimersByTime(5_000);

    hidden = true;
    addRow("wt-2", Date.now() + 60_000);
    vi.advanceTimersByTime(120_000);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));

    // The two minutes nobody could see are credited, not spent.
    expect(bulkTrashByWorktree).not.toHaveBeenCalled();
    const expiresAt = useWorktreeSelectionStore.getState().deletedWorktrees.get("wt-2")?.expiresAt;
    expect((expiresAt ?? 0) - Date.now()).toBeGreaterThan(0);
  });
});
