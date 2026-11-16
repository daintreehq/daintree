// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { AssistantWorkReading } from "@shared/types/assistantWork";
import { __resetProjectViewCacheStateForTests } from "@/lib/viewCacheState";
import { AGENT_DIRECTORY_POLL_MS } from "../useAgentDirectory";
import { useAssistantWork } from "../useAssistantWork";

const remote = vi.hoisted(() => vi.fn<(hostId: string) => Promise<AssistantWorkReading>>());
vi.mock("@/clients/canopyHostClient", () => ({
  canopyHostClient: { readAssistantWork: remote },
}));

function reading(observedAt: number, workers: unknown[] = []): AssistantWorkReading {
  return {
    coverage: "ok",
    observedAt,
    complete: true,
    omitted: 0,
    workers,
  } as AssistantWorkReading;
}

const own = vi.fn<() => Promise<AssistantWorkReading>>();
const HOSTS = ["local", "studio"];
let clock = 0;

const nextPoll = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(AGENT_DIRECTORY_POLL_MS);
  });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  Object.defineProperty(window, "electron", {
    value: { canopy: { readAssistantWork: own } },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  delete (window as { electron?: unknown }).electron;
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
  own.mockReset();
  remote.mockReset();
  __resetProjectViewCacheStateForTests();
  vi.useRealTimers();
});

describe("useAssistantWork", () => {
  it("keeps the map it holds while every host says what it said before, and only the changed host's reading when one doesn't", async () => {
    own.mockImplementation(async () => reading(++clock));
    remote.mockImplementation(async () => reading(++clock));
    const { result } = renderHook(() => useAssistantWork(HOSTS, "local", true));
    await act(async () => {});
    const first = result.current;
    expect(first.size).toBe(2);

    await nextPoll();
    expect(own).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(first);

    remote.mockImplementation(async () => reading(++clock, [{ terminalId: "w1" }]));
    await nextPoll();
    expect(result.current).not.toBe(first);
    expect(result.current.get("local")).toBe(first.get("local"));
    expect(result.current.get("studio")?.workers).toHaveLength(1);
  });

  it("reads nothing while the view can't be seen, and reads at once when it can", async () => {
    own.mockImplementation(async () => reading(++clock));
    remote.mockImplementation(async () => reading(++clock));
    renderHook(() => useAssistantWork(HOSTS, "local", true));
    await act(async () => {});
    expect(own).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AGENT_DIRECTORY_POLL_MS * 3);
    });
    expect(own).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(own).toHaveBeenCalledTimes(2);
  });

  it("holds a host it can't reach as stale, without replacing the map on each failed read", async () => {
    own.mockImplementation(async () => reading(++clock));
    remote
      .mockResolvedValueOnce(reading(1, [{ terminalId: "w1" }]))
      .mockRejectedValue(new Error("unreachable"));
    const { result } = renderHook(() => useAssistantWork(HOSTS, "local", true));
    await act(async () => {});

    await nextPoll();
    const stale = result.current;
    expect(stale.get("studio")).toMatchObject({ coverage: "stale", workers: [{ terminalId: "w1" }] });

    await nextPoll();
    expect(result.current).toBe(stale);
  });
});
