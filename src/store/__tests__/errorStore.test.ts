import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useErrorStore } from "../errorStore";

describe("errorStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useErrorStore.getState().reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("deduplicates rapid matching errors and refreshes timestamp", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const firstId = useErrorStore.getState().addError({
      type: "process",
      message: "Process crashed",
      source: "pty",
      isTransient: true,
      context: { terminalId: "term-1" },
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    const secondId = useErrorStore.getState().addError({
      type: "process",
      message: "Process crashed",
      source: "pty",
      isTransient: true,
      context: { terminalId: "term-1" },
    });

    const state = useErrorStore.getState();
    expect(secondId).toBe(firstId);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.timestamp).toBe(new Date("2026-01-01T00:00:00.200Z").getTime());
  });

  it("does not deduplicate after rate limit window", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    useErrorStore.getState().addError({
      type: "network",
      message: "Timeout",
      source: "fetcher",
      isTransient: true,
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.600Z"));
    useErrorStore.getState().addError({
      type: "network",
      message: "Timeout",
      source: "fetcher",
      isTransient: true,
    });

    expect(useErrorStore.getState().errors).toHaveLength(2);
  });

  it("enforces max error history", () => {
    for (let index = 0; index < 55; index++) {
      useErrorStore.getState().addError({
        type: "unknown",
        message: `error-${index}`,
        source: "test",
        isTransient: false,
      });
      vi.advanceTimersByTime(600);
    }

    const state = useErrorStore.getState();
    expect(state.errors).toHaveLength(50);
    expect(state.errors.some((entry) => entry.message === "error-0")).toBe(false);
    expect(state.errors.some((entry) => entry.message === "error-54")).toBe(true);
  });

  it("clearAll fully clears error panel state", () => {
    useErrorStore.getState().setPanelOpen(true);
    useErrorStore.getState().addError({
      type: "git",
      message: "Bad HEAD",
      source: "git",
      isTransient: false,
    });

    const before = useErrorStore.getState();
    expect(before.errors.length).toBe(1);
    expect(before.lastErrorTime).toBeGreaterThan(0);

    useErrorStore.getState().clearAll();

    const after = useErrorStore.getState();
    expect(after.errors).toEqual([]);
    expect(after.lastErrorTime).toBe(0);
    expect(after.isPanelOpen).toBe(false);
  });
});
