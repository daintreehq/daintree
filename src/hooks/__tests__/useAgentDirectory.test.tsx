// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AgentDirectory } from "@shared/types/agentDirectory";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import { AGENT_DIRECTORY_POLL_MS, useAgentDirectory } from "../useAgentDirectory";

function directory(observedAt: number, entries: unknown[] = []): AgentDirectory {
  return { coverage: "ok", observedAt, complete: true, omitted: 0, entries } as AgentDirectory;
}

const readAgentDirectory = vi.fn<() => Promise<AgentDirectory>>();
let clock = 0;

function setHidden(value: boolean) {
  Object.defineProperty(document, "hidden", { value, configurable: true });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

const nextPoll = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(AGENT_DIRECTORY_POLL_MS);
  });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  Object.defineProperty(window, "electron", {
    value: { canopy: { readAgentDirectory } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  delete (window as { electron?: unknown }).electron;
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  readAgentDirectory.mockReset();
  __resetProjectViewCacheStateForTests();
  vi.useRealTimers();
});

describe("useAgentDirectory", () => {
  it("keeps what it holds for a read that says nothing new but its time, and takes one that does", async () => {
    readAgentDirectory.mockImplementation(async () => directory(++clock));
    const { result } = renderHook(() => useAgentDirectory(true));
    await act(async () => {});
    const first = result.current;
    expect(first?.observedAt).toBe(1);

    await nextPoll();
    expect(readAgentDirectory).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(first);

    readAgentDirectory.mockImplementation(async () => directory(++clock, [{ label: "new" }]));
    await nextPoll();
    expect(result.current).not.toBe(first);
    expect(result.current?.entries).toHaveLength(1);
  });

  it("takes every read while a confirmation waits, since its expiry is held against the read's time", async () => {
    const waiting = [
      { state: "live", confirmations: { waiting: [{ expiresAt: 10 }], omitted: 0 } },
    ];
    readAgentDirectory.mockImplementation(async () => directory(++clock, waiting));
    const { result } = renderHook(() => useAgentDirectory(true));
    await act(async () => {});
    const first = result.current;

    await nextPoll();
    expect(result.current).not.toBe(first);
    expect(result.current?.observedAt).toBe(2);
  });

  it("reads nothing while the view can't be seen, and reads at once when it can", async () => {
    readAgentDirectory.mockImplementation(async () => directory(++clock));
    renderHook(() => useAgentDirectory(true));
    await act(async () => {});
    expect(readAgentDirectory).toHaveBeenCalledTimes(1);

    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_DIRECTORY_POLL_MS * 3);
    });
    expect(readAgentDirectory).toHaveBeenCalledTimes(1);

    setHidden(false);
    await act(async () => {});
    expect(readAgentDirectory).toHaveBeenCalledTimes(2);
  });

  it("says what it holds is stale while reads fail, without replacing it on each one", async () => {
    readAgentDirectory
      .mockResolvedValueOnce(directory(1, [{ label: "a" }]))
      .mockRejectedValue(new Error("unreachable"));
    const { result } = renderHook(() => useAgentDirectory(true));
    await act(async () => {});

    await nextPoll();
    const stale = result.current;
    expect(stale).toMatchObject({ coverage: "stale", complete: false, entries: [{ label: "a" }] });

    await nextPoll();
    expect(result.current).toBe(stale);
  });
});
