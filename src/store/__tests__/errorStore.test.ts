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

  it("preserves correlationId through addError", () => {
    const id = useErrorStore.getState().addError({
      type: "git",
      message: "push rejected",
      source: "git",
      isTransient: false,
      correlationId: "test-corr-1234",
    });

    const error = useErrorStore.getState().errors.find((e) => e.id === id);
    expect(error?.correlationId).toBe("test-corr-1234");
  });

  it("preserves original correlationId on deduplicated errors", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    useErrorStore.getState().addError({
      type: "git",
      message: "push rejected",
      source: "git",
      isTransient: false,
      correlationId: "original-corr-id",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    useErrorStore.getState().addError({
      type: "git",
      message: "push rejected",
      source: "git",
      isTransient: false,
      correlationId: "new-corr-id",
    });

    const state = useErrorStore.getState();
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.correlationId).toBe("original-corr-id");
  });

  it("preserves recoveryHint through addError", () => {
    const id = useErrorStore.getState().addError({
      type: "filesystem",
      message: "EACCES: permission denied",
      source: "fs",
      isTransient: false,
      recoveryHint: "Check file permissions or run with elevated privileges.",
    });

    const error = useErrorStore.getState().errors.find((e) => e.id === id);
    expect(error?.recoveryHint).toBe("Check file permissions or run with elevated privileges.");
  });

  it("does not include recoveryHint in dedup comparison", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    useErrorStore.getState().addError({
      type: "network",
      message: "Timeout",
      source: "fetcher",
      isTransient: true,
      recoveryHint: "Check your network connection and try again.",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    useErrorStore.getState().addError({
      type: "network",
      message: "Timeout",
      source: "fetcher",
      isTransient: true,
      recoveryHint: "Different hint text.",
    });

    const state = useErrorStore.getState();
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.recoveryHint).toBe("Check your network connection and try again.");
  });

  describe("retryProgress", () => {
    it("updateRetryProgress sets progress on matching error", () => {
      const id = useErrorStore.getState().addError({
        type: "process",
        message: "spawn failed",
        source: "pty",
        isTransient: true,
      });

      useErrorStore.getState().updateRetryProgress(id, 2, 3);

      const error = useErrorStore.getState().errors.find((e) => e.id === id);
      expect(error?.retryProgress).toEqual({ attempt: 2, maxAttempts: 3 });
    });

    it("clearRetryProgress removes progress from matching error", () => {
      const id = useErrorStore.getState().addError({
        type: "process",
        message: "spawn failed",
        source: "pty",
        isTransient: true,
      });

      useErrorStore.getState().updateRetryProgress(id, 1, 3);
      useErrorStore.getState().clearRetryProgress(id);

      const error = useErrorStore.getState().errors.find((e) => e.id === id);
      expect(error?.retryProgress).toBeUndefined();
    });

    it("clearAll removes all retryProgress", () => {
      const id = useErrorStore.getState().addError({
        type: "process",
        message: "spawn failed",
        source: "pty",
        isTransient: true,
      });

      useErrorStore.getState().updateRetryProgress(id, 1, 3);
      useErrorStore.getState().clearAll();

      expect(useErrorStore.getState().errors).toEqual([]);
    });
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
