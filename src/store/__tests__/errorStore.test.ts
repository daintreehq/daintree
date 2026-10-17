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
      retryability: "auto",
      context: { terminalId: "term-1" },
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    const secondId = useErrorStore.getState().addError({
      type: "process",
      message: "Process crashed",
      source: "pty",
      retryability: "auto",
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
      retryability: "auto",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.600Z"));
    useErrorStore.getState().addError({
      type: "network",
      message: "Timeout",
      source: "fetcher",
      retryability: "auto",
    });

    expect(useErrorStore.getState().errors).toHaveLength(2);
  });

  it("enforces max error history", () => {
    for (let index = 0; index < 55; index++) {
      useErrorStore.getState().addError({
        type: "unknown",
        message: `error-${index}`,
        source: "test",
        retryability: "none",
      });
      vi.advanceTimersByTime(600);
    }

    const state = useErrorStore.getState();
    expect(state.errors).toHaveLength(50);
    expect(state.errors.some((entry) => entry.message === "error-0")).toBe(false);
    expect(state.errors.some((entry) => entry.message === "error-54")).toBe(true);
  });

  it("preserves original correlationId on deduplicated errors", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    useErrorStore.getState().addError({
      type: "git",
      message: "push rejected",
      source: "git",
      retryability: "none",
      correlationId: "original-corr-id",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    useErrorStore.getState().addError({
      type: "git",
      message: "push rejected",
      source: "git",
      retryability: "none",
      correlationId: "new-corr-id",
    });

    const state = useErrorStore.getState();
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]?.correlationId).toBe("original-corr-id");
  });

  it("does not include recoveryHint in dedup comparison", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    useErrorStore.getState().addError({
      type: "network",
      message: "Timeout",
      source: "fetcher",
      retryability: "auto",
      recoveryHint: "Check your network connection and try again.",
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    useErrorStore.getState().addError({
      type: "network",
      message: "Timeout",
      source: "fetcher",
      retryability: "auto",
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
        retryability: "auto",
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
        retryability: "auto",
      });

      useErrorStore.getState().updateRetryProgress(id, 1, 3);
      useErrorStore.getState().clearRetryProgress(id);

      const error = useErrorStore.getState().errors.find((e) => e.id === id);
      expect(error?.retryProgress).toBeUndefined();
    });
  });

  it("propagates recoveryAction and gitReason on dedup when classification upgrades", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const firstId = useErrorStore.getState().addError({
      type: "git",
      message: "Push failed",
      source: "git",
      retryability: "auto",
      context: { worktreeId: "w-1" },
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    useErrorStore.getState().addError({
      type: "git",
      message: "Push failed",
      source: "git",
      retryability: "user-gated",
      gitReason: "auth-failed",
      recoveryAction: { label: "Reconnect", actionId: "github.connect" },
      context: { worktreeId: "w-1" },
    });

    const stored = useErrorStore.getState().errors.find((e) => e.id === firstId);
    expect(stored?.retryability).toBe("user-gated");
    expect(stored?.recoveryAction?.actionId).toBe("github.connect");
    expect(stored?.gitReason).toBe("auth-failed");
  });

  it("overwrites retryability on dedup so 'exhausted' transitions are visible", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const firstId = useErrorStore.getState().addError({
      type: "process",
      message: "Process crashed",
      source: "pty",
      retryability: "auto",
      context: { terminalId: "term-1" },
    });

    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    useErrorStore.getState().addError({
      type: "process",
      message: "Process crashed",
      source: "pty",
      retryability: "exhausted",
      context: { terminalId: "term-1" },
    });

    const stored = useErrorStore.getState().errors.find((e) => e.id === firstId);
    expect(stored?.retryability).toBe("exhausted");
  });

  it("reset fully clears error panel state", () => {
    useErrorStore.getState().setPanelOpen(true);
    useErrorStore.getState().addError({
      type: "git",
      message: "Bad HEAD",
      source: "git",
      retryability: "none",
    });

    const before = useErrorStore.getState();
    expect(before.errors.length).toBe(1);
    expect(before.lastErrorTime).toBeGreaterThan(0);

    useErrorStore.getState().reset();

    const after = useErrorStore.getState();
    expect(after.errors).toEqual([]);
    expect(after.lastErrorTime).toBe(0);
    expect(after.isPanelOpen).toBe(false);
  });

  describe("normalized dedup", () => {
    it("deduplicates errors whose messages differ only by a UUID", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "Error abc12345-6789-4abc-def0-123456789abc occurred",
        source: "pty",
        retryability: "auto",
      });

      vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "Error deadbeef-1111-4abc-def0-222222222222 occurred",
        source: "pty",
        retryability: "auto",
      });

      const state = useErrorStore.getState();
      expect(state.errors).toHaveLength(1);
      // First message preserved for display
      expect(state.errors[0]?.message).toBe("Error abc12345-6789-4abc-def0-123456789abc occurred");
    });

    it("deduplicates EADDRINUSE errors with different port numbers", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "listen EADDRINUSE: address already in use :::3000",
        source: "http",
        retryability: "auto",
      });

      vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "listen EADDRINUSE: address already in use :::4000",
        source: "http",
        retryability: "auto",
      });

      expect(useErrorStore.getState().errors).toHaveLength(1);
    });

    it("does not deduplicate errors with genuinely different messages", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "EBUSY: resource busy or locked",
        source: "pty",
        retryability: "auto",
      });

      vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "EACCES: permission denied",
        source: "pty",
        retryability: "auto",
      });

      expect(useErrorStore.getState().errors).toHaveLength(2);
    });

    it("does not deduplicate outside rate limit window even with normalized-identical messages", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "Error abc12345-6789-4abc-def0-123456789abc occurred",
        source: "pty",
        retryability: "auto",
      });

      vi.setSystemTime(new Date("2026-01-01T00:00:00.600Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "Error deadbeef-1111-4abc-def0-222222222222 occurred",
        source: "pty",
        retryability: "auto",
      });

      expect(useErrorStore.getState().errors).toHaveLength(2);
    });
  });

  describe("promoteErrors", () => {
    let errorIds: string[] = [];

    beforeEach(() => {
      errorIds = [];
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      for (const msg of ["err-a", "err-b", "err-c"]) {
        const id = useErrorStore.getState().addError({
          type: "process",
          message: msg,
          source: "test",
          retryability: "auto",
        });
        errorIds.push(id);
      }
    });

    it("promotes only specified errors when ids are provided", () => {
      useErrorStore.getState().promoteErrors([errorIds[0]!]);

      const state = useErrorStore.getState();
      expect(state.errors.find((e) => e.id === errorIds[0])?.promotedToDock).toBe(true);
      expect(state.errors.find((e) => e.id === errorIds[1])?.promotedToDock).toBeUndefined();
      expect(state.errors.find((e) => e.id === errorIds[2])?.promotedToDock).toBeUndefined();
    });

    it("promotes all non-dismissed errors when no ids are provided", () => {
      useErrorStore.getState().promoteErrors();

      const state = useErrorStore.getState();
      for (const id of errorIds) {
        expect(state.errors.find((e) => e.id === id)?.promotedToDock).toBe(true);
      }
    });

    it("does not promote dismissed errors", () => {
      useErrorStore.getState().dismissError(errorIds[0]!);
      useErrorStore.getState().promoteErrors();

      const state = useErrorStore.getState();
      expect(state.errors.find((e) => e.id === errorIds[0])?.promotedToDock).toBeUndefined();
      expect(state.errors.find((e) => e.id === errorIds[1])?.promotedToDock).toBe(true);
    });

    it("is idempotent", () => {
      useErrorStore.getState().promoteErrors([errorIds[0]!]);
      useErrorStore.getState().promoteErrors([errorIds[0]!]);

      expect(
        useErrorStore.getState().errors.find((e) => e.id === errorIds[0])?.promotedToDock
      ).toBe(true);
    });

    it("preserves promotedToDock when a normalized-identical error is deduplicated", () => {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      // Add an error with a UUID suffix and promote it
      const id = useErrorStore.getState().addError({
        type: "process",
        message: "Spawn failed abc12345-6789-4abc-def0-123456789abc",
        source: "pty",
        retryability: "auto",
      });
      useErrorStore.getState().promoteErrors([id]);

      // Fire a duplicate with a different UUID that normalizes to the same key
      vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
      useErrorStore.getState().addError({
        type: "process",
        message: "Spawn failed deadbeef-1111-4abc-def0-222222222222",
        source: "pty",
        retryability: "auto",
      });

      const state = useErrorStore.getState();
      expect(state.errors).toHaveLength(4); // 3 from beforeEach + 1 promoted (duplicate merged)
      const promoted = state.errors.find((e) => e.id === id);
      expect(promoted?.promotedToDock).toBe(true);
      // Original message preserved for display
      expect(promoted?.message).toBe("Spawn failed abc12345-6789-4abc-def0-123456789abc");
    });

    it("is a no-op with empty ids array", () => {
      const before = useErrorStore.getState().errors;
      useErrorStore.getState().promoteErrors([]);
      const after = useErrorStore.getState().errors;
      expect(after).toEqual(before);
    });
  });
});
