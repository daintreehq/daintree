// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNotificationHistoryPruning } from "../useNotificationHistoryPruning";
import { useNotificationHistoryStore } from "@/store/slices/notificationHistorySlice";

describe("useNotificationHistoryPruning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prunes once immediately on mount", () => {
    const spy = vi.spyOn(useNotificationHistoryStore.getState(), "pruneExpiredEntries");
    renderHook(() => useNotificationHistoryPruning());
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("prunes again on every hourly tick", () => {
    const spy = vi.spyOn(useNotificationHistoryStore.getState(), "pruneExpiredEntries");
    renderHook(() => useNotificationHistoryPruning());
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("stops pruning after unmount (interval cleared)", () => {
    const spy = vi.spyOn(useNotificationHistoryStore.getState(), "pruneExpiredEntries");
    const { unmount } = renderHook(() => useNotificationHistoryPruning());
    expect(spy).toHaveBeenCalledTimes(1);
    unmount();
    vi.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
