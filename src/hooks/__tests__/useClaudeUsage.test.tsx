// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ClaudeUsageAccount } from "@shared/types/ipc/agentQuota";

const readUsage = vi.hoisted(() => vi.fn<() => Promise<ClaudeUsageAccount[]>>());
vi.mock("@/clients/claudeClient", () => ({ claudeClient: { readUsage: () => readUsage() } }));

import { CLAUDE_USAGE_POLL_MS, useClaudeUsage } from "../useClaudeUsage";

const account = (key: string): ClaudeUsageAccount => ({
  key,
  kind: "default",
  accountNames: [],
  readings: [],
});

describe("useClaudeUsage (#16370)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readUsage.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads nothing while disabled", async () => {
    const { result } = renderHook(() => useClaudeUsage(false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLAUDE_USAGE_POLL_MS * 2);
    });
    expect(readUsage).not.toHaveBeenCalled();
    expect(result.current.accounts).toBeNull();
  });

  it("reads on mount and again each minute", async () => {
    readUsage.mockResolvedValueOnce([]).mockResolvedValueOnce([account("a")]);
    const { result } = renderHook(() => useClaudeUsage(true));
    await act(async () => {});
    expect(result.current.accounts).toEqual([]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLAUDE_USAGE_POLL_MS);
    });
    expect(readUsage).toHaveBeenCalledTimes(2);
    expect(result.current.accounts).toEqual([account("a")]);
  });

  it("keeps what it showed when a later read fails, and says it failed", async () => {
    readUsage.mockResolvedValueOnce([account("a")]).mockRejectedValueOnce(new Error("ipc gone"));
    const { result } = renderHook(() => useClaudeUsage(true));
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLAUDE_USAGE_POLL_MS);
    });
    expect(result.current.accounts).toEqual([account("a")]);
    expect(result.current.failed).toBe(true);

    readUsage.mockResolvedValueOnce([account("b")]);
    await act(async () => result.current.refresh());
    expect(result.current.accounts).toEqual([account("b")]);
    expect(result.current.failed).toBe(false);
  });

  it("drops an answer that arrives after an older one was overtaken", async () => {
    let answerFirst: (value: ClaudeUsageAccount[]) => void = () => {};
    readUsage
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce([account("new")]);
    const { result } = renderHook(() => useClaudeUsage(true));

    await act(async () => result.current.refresh());
    await act(async () => answerFirst([account("old")]));

    expect(result.current.accounts).toEqual([account("new")]);
  });

  it("stops reading once unmounted", async () => {
    readUsage.mockResolvedValue([]);
    const { unmount } = renderHook(() => useClaudeUsage(true));
    await act(async () => {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLAUDE_USAGE_POLL_MS * 3);
    });
    expect(readUsage).toHaveBeenCalledTimes(1);
  });
});
