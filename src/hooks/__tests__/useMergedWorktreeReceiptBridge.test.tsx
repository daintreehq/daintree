// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MergedWorktreeRemovalReceipt } from "@shared/types/mergedWorktreeCleanup";

const remote = vi.hoisted(() => ({ value: false }));
const storage = vi.hoisted(() => ({ withhold: new Set<string>() }));

vi.mock("@/hooks/useHostPlatform", () => ({ isRemoteWindow: () => remote.value }));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (select: (state: { currentProject: { id: string } | null }) => unknown) =>
    select({ currentProject: { id: "project-1" } }),
}));
vi.mock("@/store/slices/notificationHistorySlice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/store/slices/notificationHistorySlice")>();
  return {
    ...actual,
    notificationHistoryIdsInStorage: () => {
      const ids = actual.notificationHistoryIdsInStorage();
      for (const id of storage.withhold) ids.delete(id);
      return ids;
    },
  };
});

import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";
import { useMergedWorktreeReceiptBridge } from "@/hooks/useMergedWorktreeReceiptBridge";
import { mergedWorktreeReceiptEntryId } from "@/components/Worktree/mergedCleanup/mergedWorktreeReceiptEntry";

function receipt(id: string): MergedWorktreeRemovalReceipt {
  return {
    id,
    projectId: "project-1",
    projectName: "Repo",
    worktreePath: `/wt/${id}`,
    branch: `feature/${id}`,
    prNumber: 12,
    prUrl: "https://forge.test/o/r/pull/12",
    removedAt: 1_700_000_000_000,
  };
}

const takeReceipts = vi.fn<() => Promise<MergedWorktreeRemovalReceipt[]>>();
const ackReceipts = vi.fn<(payload: { ids: string[] }) => Promise<void>>();
let ready: (() => void) | null = null;
let reveal: (() => void) | null = null;
let park: (() => void) | null = null;

beforeEach(() => {
  remote.value = false;
  storage.withhold.clear();
  localStorage.clear();
  useNotificationHistoryStore.setState({ entries: [], unreadCount: 0, snoozedThreads: {} });
  takeReceipts.mockReset().mockResolvedValue([]);
  ackReceipts.mockReset().mockResolvedValue(undefined);
  ready = reveal = park = null;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      mergedWorktreeCleanup: {
        takeReceipts,
        ackReceipts,
        onReceiptsReady: (callback: () => void) => {
          ready = callback;
          return () => {};
        },
      },
      app: {
        onViewRevealed: (callback: () => void) => {
          reveal = callback;
          return () => {};
        },
        onViewCached: (callback: () => void) => {
          park = callback;
          return () => {};
        },
      },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "electron");
});

const entries = () => useNotificationHistoryStore.getState().entries;

describe("useMergedWorktreeReceiptBridge", () => {
  it("files each receipt unread, naming the branch, and acks only what storage holds", async () => {
    takeReceipts.mockResolvedValue([receipt("a"), receipt("b")]);
    storage.withhold.add(mergedWorktreeReceiptEntryId("b"));
    renderHook(() => useMergedWorktreeReceiptBridge(true));

    await vi.waitFor(() => expect(ackReceipts).toHaveBeenCalled());
    expect(ackReceipts.mock.calls).toEqual([[{ ids: ["a"] }]]);
    const filed = entries().find((entry) => entry.id === mergedWorktreeReceiptEntryId("a"));
    expect(filed?.message).toContain("feature/a");
    expect(filed?.context).toEqual({ projectId: "project-1", eventKind: "git" });
    expect(filed?.seenAsToast).toBe(false);
    expect(useNotificationHistoryStore.getState().unreadCount).toBeGreaterThan(0);
  });

  it("waits for the view's state before asking", async () => {
    const { rerender } = renderHook(({ loaded }) => useMergedWorktreeReceiptBridge(loaded), {
      initialProps: { loaded: false },
    });
    expect(takeReceipts).not.toHaveBeenCalled();
    rerender({ loaded: true });
    await vi.waitFor(() => expect(takeReceipts).toHaveBeenCalledTimes(1));
  });

  it("asks again when main announces a removal, but not while parked out of sight", async () => {
    renderHook(() => useMergedWorktreeReceiptBridge(true));
    await vi.waitFor(() => expect(takeReceipts).toHaveBeenCalledTimes(1));

    takeReceipts.mockResolvedValue([receipt("c")]);
    act(() => ready?.());
    await vi.waitFor(() => expect(ackReceipts).toHaveBeenCalledWith({ ids: ["c"] }));

    act(() => park?.());
    act(() => ready?.());
    expect(takeReceipts).toHaveBeenCalledTimes(2);

    act(() => reveal?.());
    await vi.waitFor(() => expect(takeReceipts).toHaveBeenCalledTimes(3));
  });

  it("files a receipt handed over twice as one entry", async () => {
    takeReceipts.mockResolvedValue([receipt("d")]);
    renderHook(() => useMergedWorktreeReceiptBridge(true));
    await vi.waitFor(() => expect(ackReceipts).toHaveBeenCalledTimes(1));
    act(() => ready?.());
    await vi.waitFor(() => expect(ackReceipts).toHaveBeenCalledTimes(2));
    expect(
      entries().filter((entry) => entry.id === mergedWorktreeReceiptEntryId("d"))
    ).toHaveLength(1);
  });

  it("files nothing from a take that lands after the view was parked", async () => {
    let answer!: (receipts: MergedWorktreeRemovalReceipt[]) => void;
    takeReceipts.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    renderHook(() => useMergedWorktreeReceiptBridge(true));
    await vi.waitFor(() => expect(takeReceipts).toHaveBeenCalledTimes(1));

    act(() => park?.());
    await act(async () => answer([receipt("late")]));

    expect(entries()).toEqual([]);
    expect(ackReceipts).not.toHaveBeenCalled();
  });

  it("does nothing in a window driving a remote host", () => {
    remote.value = true;
    renderHook(() => useMergedWorktreeReceiptBridge(true));
    expect(takeReceipts).not.toHaveBeenCalled();
  });
});
